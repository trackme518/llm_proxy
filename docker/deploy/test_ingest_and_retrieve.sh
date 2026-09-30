#!/usr/bin/env bash
# Exercise the deployed stack through Traefik; no standalone application runtime.
set -euo pipefail
set +x
for command in curl jq; do
  command -v "$command" >/dev/null || { echo "Required command missing: $command" >&2; exit 1; }
done

base_url=http://127.0.0.1
organization_id=1
project_id=1
echo 'Testing the local stack with default organization (1) and default project (1).'
read -r -s -p 'Paste Bun RAG API key (editor/admin/superadmin): ' api_key
printf '\n'
api_key=${api_key#Bearer }
[[ -n "$api_key" ]] || { echo 'API key is required.' >&2; exit 1; }

work_dir=$(mktemp -d)
document_id=''
job_id=''
# Keep the key out of curl command arguments and restrict temporary file access.
chmod 700 "$work_dir"
printf 'Authorization: Bearer %s\n' "$api_key" > "$work_dir/auth"
unset api_key
request() {
  local method=$1 path=$2 payload=${3:-} status
  local args=(-sS --connect-timeout 10 --max-time 120 -X "$method"
    -H "@$work_dir/auth" -H 'Content-Type: application/json'
    -o "$work_dir/response" -w '%{http_code}')
  if [[ -n "$payload" ]]; then args+=(--data-binary "$payload"); fi
  status=$(curl "${args[@]}" "$base_url$path") || return 1
  if [[ "$status" != 2?? ]]; then
    printf 'HTTP %s from %s\n' "$status" "$path" >&2
    cat "$work_dir/response" >&2
    return 1
  fi
  jq -e . "$work_dir/response"
}
cleanup() {
  local result=$?
  trap - EXIT
  if [[ -n "$document_id" ]]; then
    if request POST /documents/delete "$(jq -nc --argjson id "$document_id" '{document_id:$id}')" >/dev/null; then
      echo "Removed test document $document_id."
    else
      echo "Cleanup failed: delete test document $document_id from the console." >&2
      result=1
    fi
  elif [[ -n "$job_id" ]]; then
    echo "Job $job_id did not return a document ID. Check its status and remove any resulting test document in the console." >&2
  fi
  rm -rf "$work_dir"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

marker="RAG-test-$(date +%s)-$RANDOM"
payload=$(jq -nc --arg marker "$marker" --argjson org "$organization_id" --argjson project "$project_id" \
  '{title:$marker, content:("The verification project " + $marker + " launches in Brno. Its safety color is orange."), organization_id:$org, project_ids:[$project]}')
echo "Ingesting $marker..."
response=$(request POST /documents/ingest "$payload")
job_id=$(jq -er '.job_id | strings | select(length > 0)' <<< "$response")
deadline=$((SECONDS + 300))
while :; do
  response=$(request GET "/documents/ingest-status?job_id=$job_id")
  state=$(jq -er '.state' <<< "$response")
  printf 'Ingestion: %s (%s/%s)\n' "$state" "$(jq -r '.progress' <<< "$response")" "$(jq -r '.total' <<< "$response")"
  case "$state" in
    finished)
      document_id=$(jq -er '.document_id | numbers | select(. > 0)' <<< "$response")
      break ;;
    failed) echo 'Ingestion failed. Check docker logs --tail 100 bun-rag.' >&2; exit 1 ;;
    processing) ;;
    *) echo "Unexpected job state: $state" >&2; exit 1 ;;
  esac
  (( SECONDS < deadline )) || { echo 'Ingestion timed out after 300 seconds.' >&2; exit 1; }
  sleep 2
done

echo 'Checking retrieval through the project scope...'
payload=$(jq -nc --arg query "Where does the verification project $marker launch?" --argjson project "$project_id" \
  '{query:$query, project_ids:[$project]}')
response=$(request POST /api/tools/search-documents "$payload")
jq -e --argjson id "$document_id" \
  '[.citations[]? | select(.document_id == $id and ((.content // "") | contains("Brno")))] | length > 0' <<< "$response" >/dev/null || {
  echo "FAIL: search did not retrieve test document $document_id." >&2
  printf '%s\n' "$response" >&2
  exit 1
}
echo "PASS: document $document_id was ingested and retrieved."
