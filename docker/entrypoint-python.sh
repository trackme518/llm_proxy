#!/usr/bin/env bash
set -euo pipefail

cd /app/embedding
exec python /app/embedding/embedings.py
