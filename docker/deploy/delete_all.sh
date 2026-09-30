#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
source "$SCRIPT_DIR/helpers.sh"

LOCAL_ENV_FILE="$PROJECT_ROOT/docker/secrets/local.env"
VPS_ENV_FILE="$PROJECT_ROOT/docker/secrets/vps.env"
COMPOSE_FILE="$PROJECT_ROOT/docker/docker-compose.yml"

USE_VPS=0

require_fzf() {
  if ! command -v fzf >/dev/null 2>&1; then
    echo "Missing required command: fzf" >&2
    echo "Install it (macOS): brew install fzf" >&2
    exit 1
  fi
}

gather_local_containers() {
  local services service container_id container_name
  services="$(docker compose --env-file "$MERGED_ENV_FILE" -f "$COMPOSE_FILE" config --services)"

  while IFS= read -r service; do
    [[ -n "$service" ]] || continue
    container_id="$(docker compose --env-file "$MERGED_ENV_FILE" -f "$COMPOSE_FILE" ps -a -q "$service" 2>/dev/null || true)"
    [[ -n "$container_id" ]] || continue

    container_name="$(docker inspect --format '{{.Name}}' "$container_id" 2>/dev/null | sed 's#^/##' || true)"
    [[ -n "$container_name" ]] || container_name="$service"

    printf '%s|%s\n' "$container_name" "$container_id"
  done <<< "$services"
}

gather_vps_containers() {
  local ssh_target="$1"
  shift
  local -a ssh_opts=("$@")

  ssh "${ssh_opts[@]}" "$ssh_target" bash -s -- "$VPS_REMOTE_DIR" <<'EOF'
set -euo pipefail
REMOTE_DIR="$1"
cd "$REMOTE_DIR"

services="$(docker compose --env-file .env -f docker-compose.yml config --services)"
while IFS= read -r service; do
  [[ -n "$service" ]] || continue
  container_id="$(docker compose --env-file .env -f docker-compose.yml ps -a -q "$service" 2>/dev/null || true)"
  [[ -n "$container_id" ]] || continue

  container_name="$(docker inspect --format '{{.Name}}' "$container_id" 2>/dev/null | sed 's#^/##' || true)"
  [[ -n "$container_name" ]] || container_name="$service"

  printf '%s|%s\n' "$container_name" "$container_id"
done <<< "$services"
EOF
}

choose_containers() {
  local container_list="$1"
  local selection line container_name container_id

  [[ -n "$container_list" ]] || { echo "No deployed containers found."; exit 0; }

  selection="$(printf '%s\n' "$container_list" | fzf --multi --bind='space:toggle' --prompt='Select containers > ' --header='Space to select, Enter to confirm')" || {
    echo "Aborted."
    exit 0
  }

  [[ -n "$selection" ]] || { echo "No containers selected. Aborted."; exit 0; }

  SELECTED_NAMES=()
  SELECTED_IDS=()

  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    container_name="${line%%|*}"
    container_id="${line#*|}"
    SELECTED_NAMES+=("$container_name")
    SELECTED_IDS+=("$container_id")
  done <<< "$selection"
}

confirm_selection() {
  local name

  echo "Do you want to delete these containers and volumes?"
  for name in "${SELECTED_NAMES[@]}"; do
    echo "  - $name"
  done
  echo
  echo "Press Enter to proceed, or Ctrl+C to abort."
  read -r
}

delete_local_selected() {
  local container_id volume_name
  local volumes_file
  volumes_file="$(mktemp)"
  trap 'rm -f "$volumes_file"' RETURN

  for container_id in "${SELECTED_IDS[@]}"; do
    docker inspect --format '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}{{"\n"}}{{end}}{{end}}' "$container_id" >> "$volumes_file" 2>/dev/null || true
  done

  for container_id in "${SELECTED_IDS[@]}"; do
    docker rm -f -v "$container_id" >/dev/null
  done

  sort -u "$volumes_file" | while IFS= read -r volume_name; do
    [[ -n "$volume_name" ]] || continue
    docker volume rm "$volume_name" >/dev/null 2>&1 || true
  done
}

delete_vps_selected() {
  ssh "${SSH_OPTS[@]}" "$SSH_TARGET" bash -s -- "$VPS_REMOTE_DIR" "$@" <<'EOF'
set -euo pipefail
REMOTE_DIR="$1"
shift
cd "$REMOTE_DIR"

volumes_file="$(mktemp)"
trap 'rm -f "$volumes_file"' EXIT

for container_id in "$@"; do
  docker inspect --format '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}{{"\n"}}{{end}}{{end}}' "$container_id" >> "$volumes_file" 2>/dev/null || true
done

for container_id in "$@"; do
  docker rm -f -v "$container_id" >/dev/null
done

sort -u "$volumes_file" | while IFS= read -r volume_name; do
  [[ -n "$volume_name" ]] || continue
  docker volume rm "$volume_name" >/dev/null 2>&1 || true
done
EOF
}

usage() {
  cat <<'EOF'
Usage: ./docker/deploy/delete_all.sh [--vps]

Deletes only the containers, networks, and volumes created by the compose file.
Prompts before doing anything destructive.
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
require_fzf

declare -a SELECTED_NAMES=()
declare -a SELECTED_IDS=()

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

  CONTAINER_LIST="$(gather_vps_containers "$SSH_TARGET" "${SSH_OPTS[@]}")"
  choose_containers "$CONTAINER_LIST"
  confirm_selection
  delete_vps_selected "${SELECTED_IDS[@]}"

  echo "Selected containers and volumes deleted on VPS."
  exit 0
fi

CONTAINER_LIST="$(gather_local_containers)"
choose_containers "$CONTAINER_LIST"
confirm_selection
delete_local_selected

echo "Selected containers and volumes deleted."