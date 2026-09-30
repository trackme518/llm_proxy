#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
source "$SCRIPT_DIR/helpers.sh"

LOCAL_ENV_FILE="$PROJECT_ROOT/docker/secrets/local.env"
VPS_ENV_FILE="$PROJECT_ROOT/docker/secrets/vps.env"
COMPOSE_FILE="$PROJECT_ROOT/docker/docker-compose.yml"

USE_VPS=0

usage() {
  cat <<'EOF'
Usage: ./docker/deploy/backup_db.sh [--vps]

Downloads a complete backup of the MariaDB database as a gzipped SQL dump
to the directory containing this script.

Modes:
  default: dump the local Docker MariaDB
  --vps:   dump the MariaDB running on the VPS (streamed over SSH)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --vps)
      USE_VPS=1
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

[[ -f "$LOCAL_ENV_FILE" ]] || { echo "Missing file: $LOCAL_ENV_FILE" >&2; exit 1; }
[[ -f "$COMPOSE_FILE" ]] || { echo "Missing file: $COMPOSE_FILE" >&2; exit 1; }

TMP_DIR=$(mktemp -d)
MERGED_ENV="$TMP_DIR/merged.env"
trap 'rm -rf "$TMP_DIR"' EXIT

merge_env_files "$LOCAL_ENV_FILE" "$VPS_ENV_FILE" "$USE_VPS" "$MERGED_ENV"
set_compose_platform_env "$MERGED_ENV" "$USE_VPS"

# Dump runs inside the mariadb container; root password is read from the
# mounted docker secret and passed via MYSQL_PWD (never on the command line).
MARIADB_DUMP_CMD='export MYSQL_PWD="$(cat /run/secrets/MARIADB_ROOT_PASSWORD)"; exec mariadb-dump -uroot --single-transaction --all-databases'

BACKUP_DIR="$SCRIPT_DIR/db_backup"
mkdir -p "$BACKUP_DIR"
BACKUP_FILE="$BACKUP_DIR/mariadb_backup_$(date +%Y%m%d_%H%M%S).sql.gz"

if [[ "$USE_VPS" -eq 0 ]]; then
  echo "Dumping local MariaDB..."
  docker compose --env-file "$MERGED_ENV" -f "$COMPOSE_FILE" exec -T mariadb sh -c "$MARIADB_DUMP_CMD" | gzip > "$BACKUP_FILE"
else
  VPS_HOST=$(env_get "VPS_HOST" "$MERGED_ENV")
  VPS_USER=$(env_get "VPS_USER" "$MERGED_ENV")
  VPS_PORT=$(env_get "VPS_PORT" "$MERGED_ENV")
  SSH_KEY_PATH_RAW=$(env_get "SSH_KEY_PATH" "$MERGED_ENV")
  VPS_REMOTE_DIR=$(env_get "VPS_REMOTE_DIR" "$MERGED_ENV")

  require_var VPS_HOST "$MERGED_ENV"
  require_var VPS_USER "$MERGED_ENV"
  require_var VPS_PORT "$MERGED_ENV"
  require_var SSH_KEY_PATH "$MERGED_ENV"
  require_var VPS_REMOTE_DIR "$MERGED_ENV"

  SSH_KEY_PATH=$(resolve_path "$PROJECT_ROOT" "$SSH_KEY_PATH_RAW")
  [[ -f "$SSH_KEY_PATH" ]] || { echo "Missing SSH key: $SSH_KEY_PATH" >&2; exit 1; }

  ensure_ssh_agent_key "$SSH_KEY_PATH"

  SSH_TARGET="$VPS_USER@$VPS_HOST"
  SSH_OPTS=(-i "$SSH_KEY_PATH" -p "$VPS_PORT" -o StrictHostKeyChecking=accept-new)

  echo "Dumping MariaDB on VPS..."
  # Stream the remote dump over SSH and compress locally.
  ssh "${SSH_OPTS[@]}" "$SSH_TARGET" \
    "cd '$VPS_REMOTE_DIR' && docker compose --env-file .env -f docker-compose.yml exec -T mariadb sh -c '$MARIADB_DUMP_CMD'" \
    | gzip > "$BACKUP_FILE"
fi

[[ -s "$BACKUP_FILE" ]] || { echo "Backup failed: $BACKUP_FILE is empty" >&2; rm -f "$BACKUP_FILE"; exit 1; }
chmod 600 "$BACKUP_FILE"

echo "Backup saved to: $BACKUP_FILE"
echo "Size: $(du -h "$BACKUP_FILE" | cut -f1)"
