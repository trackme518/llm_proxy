#!/usr/bin/env bash
set -euo pipefail

cd /app/crawler
exec gunicorn -k uvicorn.workers.UvicornWorker -w 2 -b 0.0.0.0:11235 main:app --timeout 180
