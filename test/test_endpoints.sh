#!/usr/bin/env bash
set -uo pipefail

USE_VPS=0
if [[ "${1:-}" == "--vps" ]]; then
  USE_VPS=1
fi

set -a
source docker/secrets/local.env
if [[ "$USE_VPS" -eq 1 ]]; then
  source docker/secrets/vps.env
fi
set +a

BASE_URL="http://localhost"
if [[ "$USE_VPS" -eq 1 ]]; then
  BASE_URL="https://${DOMAIN_NAME}"
fi
LITELLM_BASE_URL="${BASE_URL}/llm"
RAG_BASE_URL="${BASE_URL}"
LITELLM_SITE="default"
CURL_TIMEOUT_SEC=$(( (REQUEST_TIMEOUT + 999) / 1000 ))

PASS_COUNT=0
FAIL_COUNT=0
FAILED_TESTS=()
LAST_BODY=""
LAST_STATUS=""

TMP_ROOT="./chat/.tmp_endpoint_tests"
mkdir -p "$TMP_ROOT"
trap 'rm -rf "$TMP_ROOT"' EXIT

contains_code() {
  local code="$1"
  shift
  local expected
  for expected in "$@"; do
    [[ "$code" == "$expected" ]] && return 0
  done
  return 1
}

run_test() {
  local name="$1"
  local method="$2"
  local url="$3"
  local expected_csv="$4"
  local auth_value="${5:-}"
  local body="${6:-}"
  local content_type="${7:-application/json}"

  local out_file
  out_file="$TMP_ROOT/$(echo "$name" | tr ' /:' '___').out"

  local curl_args=(-sS -m "$CURL_TIMEOUT_SEC" -o "$out_file" -w "%{http_code}" -X "$method" "$url")
  curl_args+=(-H "Accept: application/json")

  if [[ -n "$content_type" ]]; then
    curl_args+=(-H "Content-Type: ${content_type}")
  fi

  if [[ -n "$auth_value" ]]; then
    curl_args+=(-H "Authorization: Bearer ${auth_value}")
  fi

  if [[ -n "$body" ]]; then
    curl_args+=(-d "$body")
  fi

  local status
  if ! status=$(curl "${curl_args[@]}"); then
    ((FAIL_COUNT++))
    FAILED_TESTS+=("${name} -> curl execution failed")
    echo "FAIL ${name} (curl execution failed)"
    LAST_BODY=""
    LAST_STATUS="000"
    return
  fi

  local expected_arr=()
  IFS=',' read -r -a expected_arr <<< "$expected_csv"

  LAST_BODY="$(cat "$out_file")"
  LAST_STATUS="$status"

  if contains_code "$status" "${expected_arr[@]}"; then
    ((PASS_COUNT++))
    echo "PASS ${name} (${status})"
  else
    ((FAIL_COUNT++))
    FAILED_TESTS+=("${name} -> expected [${expected_csv}] got [${status}] body: ${LAST_BODY}")
    echo "FAIL ${name} (${status})"
  fi
}

extract_json_token() {
  local body="$1"
  printf '%s' "$body" | sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
}

echo "Running endpoint tests against:"
echo "- bun_rag via ${RAG_BASE_URL}"
echo "- litellm via ${LITELLM_BASE_URL}"

echo

echo "--- Public endpoints ---"
run_test "bun openapi" "GET" "${RAG_BASE_URL}/openapi.json" "200" ""
run_test "bun console redirect" "GET" "${RAG_BASE_URL}/console" "200,301,302,307,308" ""
run_test "bun console index" "GET" "${RAG_BASE_URL}/console/" "200" ""
run_test "litellm health" "GET" "${LITELLM_BASE_URL}/health" "200" "" "" ""
run_test "litellm root" "GET" "${LITELLM_BASE_URL}/" "200" "" "" ""

echo
echo "--- bun_rag auth gate tests (all protected routes) ---"
run_test "GET /api/tools unauthorized" "GET" "${RAG_BASE_URL}/api/tools" "401"
run_test "POST /api/tools/list-documents unauthorized" "POST" "${RAG_BASE_URL}/api/tools/list-documents" "401" "" "{}"
run_test "POST /api/tools/search-documents unauthorized" "POST" "${RAG_BASE_URL}/api/tools/search-documents" "401" "" "{}"
run_test "POST /documents/ingest unauthorized" "POST" "${RAG_BASE_URL}/documents/ingest" "401" "" "{}"
run_test "GET /documents/ingest-status unauthorized" "GET" "${RAG_BASE_URL}/documents/ingest-status" "401"
run_test "POST /documents/recalculate-all-embeddings unauthorized" "POST" "${RAG_BASE_URL}/documents/recalculate-all-embeddings" "401"
run_test "POST /documents/recalculate-embeddings unauthorized" "POST" "${RAG_BASE_URL}/documents/recalculate-embeddings" "401" "" "{}"
run_test "POST /documents/update unauthorized" "POST" "${RAG_BASE_URL}/documents/update" "401" "" "{}"
run_test "POST /documents/update-content unauthorized" "POST" "${RAG_BASE_URL}/documents/update-content" "401" "" "{}"
run_test "POST /documents/delete unauthorized" "POST" "${RAG_BASE_URL}/documents/delete" "401" "" "{}"
run_test "POST /extract-markdown unauthorized" "POST" "${RAG_BASE_URL}/extract-markdown" "401" "" "{}"
run_test "POST /admin/check-key unauthorized" "POST" "${RAG_BASE_URL}/admin/check-key" "401"
run_test "POST /admin/issue-key unauthorized" "POST" "${RAG_BASE_URL}/admin/issue-key" "401" "" "{}"
run_test "POST /admin/delete-key unauthorized" "POST" "${RAG_BASE_URL}/admin/delete-key" "401" "" "{}"
run_test "POST /admin/keys unauthorized" "POST" "${RAG_BASE_URL}/admin/keys" "401" "" "{}"
run_test "POST /admin/disable-key unauthorized" "POST" "${RAG_BASE_URL}/admin/disable-key" "401" "" "{}"
run_test "POST /admin/enable-key unauthorized" "POST" "${RAG_BASE_URL}/admin/enable-key" "401" "" "{}"
run_test "POST /admin/routes unauthorized" "POST" "${RAG_BASE_URL}/admin/routes" "401"
run_test "POST /admin/organizations unauthorized" "POST" "${RAG_BASE_URL}/admin/organizations" "401"
run_test "POST /admin/projects unauthorized" "POST" "${RAG_BASE_URL}/admin/projects" "401" "" "{}"
run_test "POST /admin/add-project unauthorized" "POST" "${RAG_BASE_URL}/admin/add-project" "401" "" "{}"
run_test "POST /admin/delete-project unauthorized" "POST" "${RAG_BASE_URL}/admin/delete-project" "401" "" "{}"
run_test "POST /admin/add-organization unauthorized" "POST" "${RAG_BASE_URL}/admin/add-organization" "401" "" "{}"
run_test "POST /admin/delete-organization unauthorized" "POST" "${RAG_BASE_URL}/admin/delete-organization" "401" "" "{}"
run_test "GET /mcp unauthorized" "GET" "${RAG_BASE_URL}/mcp" "401"
run_test "POST /mcp unauthorized" "POST" "${RAG_BASE_URL}/mcp" "401" "" "{}"
run_test "DELETE /mcp unauthorized" "DELETE" "${RAG_BASE_URL}/mcp" "401"

echo
echo "--- bun_rag authorized sanity tests ---"
run_test "GET /api/tools authorized" "GET" "${RAG_BASE_URL}/api/tools" "200" "$DEFAULT_SUPERADMIN_API_KEY"
run_test "POST /admin/check-key authorized" "POST" "${RAG_BASE_URL}/admin/check-key" "200" "$DEFAULT_SUPERADMIN_API_KEY"
run_test "POST /admin/routes authorized" "POST" "${RAG_BASE_URL}/admin/routes" "200" "$DEFAULT_SUPERADMIN_API_KEY"
run_test "POST /admin/organizations authorized" "POST" "${RAG_BASE_URL}/admin/organizations" "200" "$DEFAULT_SUPERADMIN_API_KEY"
run_test "POST /admin/projects authorized" "POST" "${RAG_BASE_URL}/admin/projects" "200" "$DEFAULT_SUPERADMIN_API_KEY" "{}"

echo
echo "--- LiteLLM endpoint tests ---"
run_test "POST /llm/auth" "POST" "${LITELLM_BASE_URL}/auth" "200" "" "{\"site\":\"${LITELLM_SITE}\"}"

LITELLM_TOKEN=""
if [[ "$LAST_STATUS" == "200" ]]; then
  LITELLM_TOKEN="$(extract_json_token "$LAST_BODY")"
fi

run_test "POST /llm/update_config invalid key" "POST" "${LITELLM_BASE_URL}/update_config" "403" "" "{\"reload_key\":\"invalid\"}"
run_test "POST /llm/responses missing token" "POST" "${LITELLM_BASE_URL}/responses" "403" "" "{\"input\":\"ping\",\"site\":\"${LITELLM_SITE}\"}"

if [[ -n "$LITELLM_TOKEN" ]]; then
  run_test "POST /llm/responses token flow" "POST" "${LITELLM_BASE_URL}/responses" "200,500" "$LITELLM_TOKEN" "{\"input\":\"health test\",\"site\":\"${LITELLM_SITE}\"}"
else
  ((FAIL_COUNT++))
  FAILED_TESTS+=("POST /llm/responses token flow -> could not parse token from /llm/auth")
  echo "FAIL POST /llm/responses token flow (missing token)"
fi

echo
echo "=============================="
echo "Passed: ${PASS_COUNT}"
echo "Failed: ${FAIL_COUNT}"

if [[ "$FAIL_COUNT" -gt 0 ]]; then
  echo "Failed tests:"
  for item in "${FAILED_TESTS[@]}"; do
    echo "- ${item}"
  done
  exit 1
fi

echo "All endpoint tests passed."
