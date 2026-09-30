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
Usage: ./docker/deploy/update_mariadb_password.sh [--vps]

Reads MARIADB_ROOT_PASSWORD from docker/secrets/local.env by default.
Use --vps to overlay docker/secrets/vps.env on top of local.env.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --vps) USE_VPS=1 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 1 ;;
  esac
  shift
done

[[ -f "$LOCAL_ENV_FILE" ]] || { echo "Missing file: $LOCAL_ENV_FILE" >&2; exit 1; }
[[ -f "$COMPOSE_FILE" ]] || { echo "Missing file: $COMPOSE_FILE" >&2; exit 1; }
if [[ "$USE_VPS" -eq 1 ]]; then
  [[ -f "$VPS_ENV_FILE" ]] || { echo "Missing file: $VPS_ENV_FILE" >&2; exit 1; }
fi

TMP_DIR="$(mktemp -d)"
MERGED_ENV_FILE="$TMP_DIR/merged.env"
trap 'rm -rf "$TMP_DIR"' EXIT

merge_env_files "$LOCAL_ENV_FILE" "$VPS_ENV_FILE" "$USE_VPS" "$MERGED_ENV_FILE"
set_compose_platform_env "$MERGED_ENV_FILE" "$USE_VPS"

sql_escape() { printf '%s' "$1" | sed "s/'/''/g"; }

DESIRED_PASSWORD="$(env_get MARIADB_ROOT_PASSWORD "$MERGED_ENV_FILE")"
[[ -n "$DESIRED_PASSWORD" ]] || { echo "Missing MARIADB_ROOT_PASSWORD in env file(s)." >&2; exit 1; }

if [[ "$USE_VPS" -eq 1 ]]; then
  VPS_HOST=$(env_get VPS_HOST "$MERGED_ENV_FILE")
  VPS_USER=$(env_get VPS_USER "$MERGED_ENV_FILE")
  VPS_PORT=$(env_get VPS_PORT "$MERGED_ENV_FILE")
  SSH_KEY_PATH_RAW=$(env_get SSH_KEY_PATH "$MERGED_ENV_FILE")
  VPS_REMOTE_DIR=$(env_get VPS_REMOTE_DIR "$MERGED_ENV_FILE")

  require_var VPS_HOST "$MERGED_ENV_FILE"
  require_var VPS_USER "$MERGED_ENV_FILE"
  require_var VPS_PORT "$MERGED_ENV_FILE"
  require_var SSH_KEY_PATH "$MERGED_ENV_FILE"
  require_var VPS_REMOTE_DIR "$MERGED_ENV_FILE"

  SSH_KEY_PATH=$(resolve_path "$PROJECT_ROOT" "$SSH_KEY_PATH_RAW")
  [[ -f "$SSH_KEY_PATH" ]] || { echo "Missing SSH key: $SSH_KEY_PATH" >&2; exit 1; }

  ensure_ssh_agent_key "$SSH_KEY_PATH"

  SSH_TARGET="$VPS_USER@$VPS_HOST"
  SSH_OPTS=(-i "$SSH_KEY_PATH" -p "$VPS_PORT" -o StrictHostKeyChecking=accept-new)

  echo "Updating MariaDB password on VPS..."
  ssh "${SSH_OPTS[@]}" "$SSH_TARGET" bash -s -- "$VPS_REMOTE_DIR" "$DESIRED_PASSWORD" <<'EOF'
set -euo pipefail
REMOTE_DIR="$1"
NEW_PASSWORD="$2"
cd "$REMOTE_DIR"

CURRENT_PASSWORD="$(docker compose --env-file .env -f docker-compose.yml exec -T mariadb sh -lc 'cat /run/secrets/MARIADB_ROOT_PASSWORD')"
ROOT_HOSTS=()
while IFS= read -r host; do
  [[ -n "$host" ]] && ROOT_HOSTS+=("$host")
done < <(
  docker compose --env-file .env -f docker-compose.yml exec -T -e MYSQL_PWD="$CURRENT_PASSWORD" mariadb mariadb -uroot -N -B -e "SELECT Host FROM mysql.user WHERE User='root' ORDER BY Host;"
)

if [[ ${#ROOT_HOSTS[@]} -eq 0 ]]; then
  echo "No root accounts found in MariaDB." >&2
  exit 1
fi

{
  for host in "${ROOT_HOSTS[@]}"; do
    printf "ALTER USER 'root'@'%s' IDENTIFIED BY '%s';\n" "$(printf '%s' "$host" | sed "s/'/''/g")" "$(printf '%s' "$NEW_PASSWORD" | sed "s/'/''/g")"
  done
  printf 'FLUSH PRIVILEGES;\n'
} | docker compose --env-file .env -f docker-compose.yml exec -T -e MYSQL_PWD="$CURRENT_PASSWORD" mariadb mariadb -uroot

mkdir -p secrets/generated/mariadb
printf '%s' "$NEW_PASSWORD" > secrets/generated/mariadb/MARIADB_ROOT_PASSWORD
chmod 600 secrets/generated/mariadb/MARIADB_ROOT_PASSWORD

docker compose --env-file .env -f docker-compose.yml up -d --remove-orphans --force-recreate
EOF

  echo "MariaDB password updated on VPS."
  exit 0
fi

CURRENT_PASSWORD="$(docker compose --env-file "$MERGED_ENV_FILE" -f "$COMPOSE_FILE" exec -T mariadb sh -lc 'cat /run/secrets/MARIADB_ROOT_PASSWORD')"
[[ -n "$CURRENT_PASSWORD" ]] || { echo "Could not read current MariaDB password from running container." >&2; exit 1; }

ROOT_HOSTS=()
while IFS= read -r host; do
  [[ -n "$host" ]] && ROOT_HOSTS+=("$host")
done < <(
  docker compose --env-file "$MERGED_ENV_FILE" -f "$COMPOSE_FILE" exec -T -e MYSQL_PWD="$CURRENT_PASSWORD" mariadb mariadb -uroot -N -B -e "SELECT Host FROM mysql.user WHERE User='root' ORDER BY Host;"
)

if [[ ${#ROOT_HOSTS[@]} -eq 0 ]]; then
  echo "No root accounts found in MariaDB." >&2
  exit 1
fi

{
  for host in "${ROOT_HOSTS[@]}"; do
    printf "ALTER USER 'root'@'%s' IDENTIFIED BY '%s';\n" "$(sql_escape "$host")" "$(sql_escape "$DESIRED_PASSWORD")"
  done
  printf 'FLUSH PRIVILEGES;\n'
} | docker compose --env-file "$MERGED_ENV_FILE" -f "$COMPOSE_FILE" exec -T -e MYSQL_PWD="$CURRENT_PASSWORD" mariadb mariadb -uroot

docker compose --env-file "$MERGED_ENV_FILE" -f "$COMPOSE_FILE" exec -T -e MYSQL_PWD="$DESIRED_PASSWORD" mariadb mariadb -uroot -e "SELECT 1" >/dev/null

echo "MariaDB password updated successfully."