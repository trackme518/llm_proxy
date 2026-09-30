#!/usr/bin/env bash
# Exercise the deployed chatbot and verify that it performed a RAG search.
set -euo pipefail
set +x
for command in curl jq; do
  command -v "$command" >/dev/null || { echo "Required command missing: $command" >&2; exit 1; }
done
base_url=http://127.0.0.1
site=default
question='Search the knowledge base for information about its main topics and summarize one relevant document with a source citation.'
echo 'Testing the local chatbot with the default site.'

work_dir=$(mktemp -d)
chmod 700 "$work_dir"
trap 'rm -rf "$work_dir"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
request() {
  local path=$1 payload=$2 status
  local args=(-sS --connect-timeout 10 --max-time 180 -X POST
    -H 'Content-Type: application/json' -H "X-Fingerprint: docker-chatbot-test-$$"
    -o "$work_dir/response" -w '%{http_code}' --data-binary "$payload")
  if [[ -f "$work_dir/auth" ]]; then args+=(-H "@$work_dir/auth"); fi
  status=$(curl "${args[@]}" "$base_url$path") || return 1
  if [[ "$status" != 2?? ]]; then
    printf 'HTTP %s from %s\n' "$status" "$path" >&2
    cat "$work_dir/response" >&2
    return 1
  fi
  jq -e . "$work_dir/response"
}

echo 'Obtaining a temporary chatbot token...'
response=$(request /llm/auth "$(jq -nc --arg site "$site" '{site:$site}')")
token=$(jq -er '.token | strings | select(length > 0)' <<< "$response")
printf 'Authorization: Bearer %s\n' "$token" > "$work_dir/auth"
unset token response
echo 'Asking the chatbot to search its knowledge base...'
payload=$(jq -nc --arg site "$site" --arg question "$question" \
  '{site:$site, input:("Use the search_documents RAG tool to search the knowledge base before answering this question. Base your answer on the retrieved documents and cite the source. Question: " + $question)}')
response=$(request /llm/responses "$payload")
answer=$(jq -r '[.output[]? | select(.type == "message" and .role == "assistant") | .content[]? | select(.type == "output_text") | .text] | join("\n")' <<< "$response")
printf '\nChatbot answer:\n%s\n\n' "$answer"
[[ -n "$answer" ]] || { echo 'FAIL: no assistant answer returned.' >&2; exit 1; }
# A generated answer or a function-call request alone does not prove retrieval ran.
jq -e '[.output[]? | select(.type == "mcp_call" and .name == "search_documents" and .status == "completed" and .error == null and .output != null)] | length > 0' \
  <<< "$response" >/dev/null || {
  echo 'FAIL: response does not show a completed search_documents MCP call.' >&2
  echo 'Check the site tools, MCP URL/key, model tool support, and docker logs --tail 100 litellm.' >&2
  exit 1
}
echo 'PASS: chatbot returned an answer and completed a RAG search.'
