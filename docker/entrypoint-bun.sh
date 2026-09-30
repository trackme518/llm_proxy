#!/usr/bin/env bash
set -euo pipefail

ENV_FILE=${ENV_FILE:-/run/secrets/rag.env}
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

cd /app/bun_rag
exec bun run src/api.ts
