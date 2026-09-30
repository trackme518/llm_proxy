#!/usr/bin/env bash
set -euo pipefail

cd /app/litellm
exec gunicorn main:app \
  --workers 2 \
  --worker-class uvicorn.workers.UvicornWorker \
  --bind 0.0.0.0:8001 \
  --timeout 120 \
  --access-logfile -
