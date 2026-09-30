#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCKER_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
PROJECT_ROOT="$(cd "$DOCKER_DIR/.." && pwd)"
source "$SCRIPT_DIR/helpers.sh"

LOCAL_ENV_FILE="$DOCKER_DIR/secrets/local.env"
VPS_ENV_FILE="$DOCKER_DIR/secrets/vps.env"
VPS_COMPOSE_FILE="$DOCKER_DIR/docker-compose.yml"
LOCAL_LITELLM_CONFIG_FILE="$PROJECT_ROOT/litellm/config.json"
LOCAL_SECRETS_GENERATED_DIR="$DOCKER_DIR/secrets/generated"

USE_VPS=0
UPDATE_ENV_ONLY=0
PRUNE_IMAGES=0
IMAGE_TAG="${IMAGE_TAG:-latest}"

usage() {
  cat <<'EOF'
Usage: ./docker/deploy/deploy.sh [--vps] [--update-env] [--prune] [--version <tag>]

Pulls the application images from GHCR (built and published with build.sh)
and runs the stack with docker compose.

Modes:
  default: local deploy (pull images and run locally)
  --vps:   deploy on the VPS (upload env/secrets via SSH, pull images remotely)

Flags:
  --update-env       Skip image pull and only recreate containers with updated env
  --prune            Run docker image prune -f after deploy
  --version <tag>    Image tag to pull (default: latest)
  --help|-h          Show help

Required vps.env vars for --vps:
  VPS_HOST, VPS_USER, VPS_PORT, SSH_KEY_PATH, VPS_REMOTE_DIR
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --vps)
      USE_VPS=1
      ;;
    --update-env)
      UPDATE_ENV_ONLY=1
      ;;
    --prune|--prune-images|-p)
      PRUNE_IMAGES=1
      ;;
    --version)
      [[ $# -ge 2 ]] || { echo "Missing value for $1" >&2; exit 1; }
      IMAGE_TAG="$2"
      shift
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
[[ -f "$VPS_COMPOSE_FILE" ]] || { echo "Missing file: $VPS_COMPOSE_FILE" >&2; exit 1; }

# Use a temporary workspace for merged env.
TMP_DIR=$(mktemp -d)
MERGED_ENV="$TMP_DIR/merged.env"
trap 'rm -rf "$TMP_DIR"' EXIT

merge_env_files "$LOCAL_ENV_FILE" "$VPS_ENV_FILE" "$USE_VPS" "$MERGED_ENV"

generate_compose_defined_secrets() {
  local generated_count=0

  rm -rf "$LOCAL_SECRETS_GENERATED_DIR"
  mkdir -p "$LOCAL_SECRETS_GENERATED_DIR"

  while IFS='|' read -r secret_name secret_path; do
    [[ -n "$secret_name" && -n "$secret_path" ]] || continue

    local resolved_path
    resolved_path=$(resolve_compose_secret_path "$secret_path")

    case "$resolved_path" in
      "$LOCAL_SECRETS_GENERATED_DIR"/*)
        ;;
      *)
        continue
        ;;
    esac

    local secret_var_name
    secret_var_name=$(basename "$resolved_path")
    local secret_value
    secret_value=$(env_get "$secret_var_name" "$MERGED_ENV")
    require_var "$secret_var_name" "$secret_value"

    mkdir -p "$(dirname "$resolved_path")"
    printf '%s' "$secret_value" > "$resolved_path"
    chmod 600 "$resolved_path"
    generated_count=$((generated_count + 1))
  done < <(collect_compose_secret_specs)

  if [[ "$generated_count" -eq 0 ]]; then
    echo "No compose-defined generated secrets were created under $LOCAL_SECRETS_GENERATED_DIR" >&2
    exit 1
  fi
}

resolve_compose_secret_path() {
  local raw_path="$1"
  local resolved="$raw_path"
  resolved="${resolved//\$\{SECRETS_GENERATED_DIR:-.\/secrets\/generated\}/$LOCAL_SECRETS_GENERATED_DIR}"
  echo "$resolved"
}

collect_compose_secret_specs() {
  awk '
    /^secrets:[[:space:]]*$/ { in_secrets=1; next }
    in_secrets && /^[^[:space:]]/ { in_secrets=0 }
    !in_secrets { next }

    /^  [A-Za-z0-9_.-]+:[[:space:]]*$/ {
      secret_name=$1
      sub(/:$/, "", secret_name)
      next
    }

    secret_name != "" && /^    file:[[:space:]]*/ {
      file_path=$0
      sub(/^    file:[[:space:]]*/, "", file_path)
      gsub(/^[\"'\'' ]+|[\"'\'' ]+$/, "", file_path)
      print secret_name "|" file_path
      secret_name=""
    }
  ' "$VPS_COMPOSE_FILE"
}

generate_compose_defined_secrets

# ---- local deploy mode ----
if [[ "$USE_VPS" -eq 0 ]]; then
  [[ -f "$LOCAL_LITELLM_CONFIG_FILE" ]] || { echo "Missing file: $LOCAL_LITELLM_CONFIG_FILE" >&2; exit 1; }
  # Always pin local compose secret source to the local litellm/config.json.
  printf '\nLITELLM_CONFIG_SECRET_FILE=%s\n' "$LOCAL_LITELLM_CONFIG_FILE" >> "$MERGED_ENV"
  printf '\nSECRETS_GENERATED_DIR=%s\n' "$LOCAL_SECRETS_GENERATED_DIR" >> "$MERGED_ENV"
  printf '\nIMAGE_TAG=%s\n' "$IMAGE_TAG" >> "$MERGED_ENV"

  TARGET_PLATFORM=$(detect_host_platform)
  set_compose_platform_env "$MERGED_ENV" 0

  echo "Local deploy mode"
  echo "Using image tag: $IMAGE_TAG"

  if [[ "$UPDATE_ENV_ONLY" -eq 1 ]]; then
    # Skip image pull and just recreate containers with updated environment.
    docker compose --env-file "$MERGED_ENV" -f "$VPS_COMPOSE_FILE" up -d --remove-orphans --force-recreate
  else
    docker compose --env-file "$MERGED_ENV" -f "$VPS_COMPOSE_FILE" pull
    docker compose --env-file "$MERGED_ENV" -f "$VPS_COMPOSE_FILE" up -d --remove-orphans --force-recreate
  fi

  if [[ "$PRUNE_IMAGES" -eq 1 ]]; then
    docker image prune -f
  fi

  echo "Local deploy finished successfully."
  exit 0
fi

# ---- vps deploy mode ----
VPS_HOST=$(env_get "VPS_HOST" "$MERGED_ENV")
VPS_USER=$(env_get "VPS_USER" "$MERGED_ENV")
VPS_PORT=$(env_get "VPS_PORT" "$MERGED_ENV")
SSH_KEY_PATH_RAW=$(env_get "SSH_KEY_PATH" "$MERGED_ENV")
VPS_REMOTE_DIR=$(env_get "VPS_REMOTE_DIR" "$MERGED_ENV")
VPS_ARCH_RAW=$(env_get "VPS_ARCH" "$MERGED_ENV")

require_var VPS_HOST "$MERGED_ENV"
require_var VPS_USER "$MERGED_ENV"
require_var VPS_PORT "$MERGED_ENV"
require_var SSH_KEY_PATH "$MERGED_ENV"
require_var VPS_REMOTE_DIR "$MERGED_ENV"
require_var VPS_ARCH "$MERGED_ENV"

SSH_KEY_PATH=$(resolve_path "$PROJECT_ROOT" "$SSH_KEY_PATH_RAW")
[[ -f "$SSH_KEY_PATH" ]] || { echo "Missing SSH key: $SSH_KEY_PATH" >&2; exit 1; }

ensure_ssh_agent_key "$SSH_KEY_PATH"

SSH_TARGET="$VPS_USER@$VPS_HOST"
SSH_OPTS=(-i "$SSH_KEY_PATH" -p "$VPS_PORT" -o StrictHostKeyChecking=accept-new)
SCP_OPTS=(-i "$SSH_KEY_PATH" -P "$VPS_PORT" -o StrictHostKeyChecking=accept-new)
REMOTE_ENV_FILENAME=".env"
REMOTE_COMPOSE_FILENAME=$(basename "$VPS_COMPOSE_FILE")
REMOTE_LITELLM_CONFIG_SECRET_FILENAME="litellm-config.secret.json"

[[ -f "$LOCAL_LITELLM_CONFIG_FILE" ]] || { echo "Missing file: $LOCAL_LITELLM_CONFIG_FILE" >&2; exit 1; }

TARGET_PLATFORM=$(normalize_platform "$VPS_ARCH_RAW")
set_compose_platform_env "$MERGED_ENV" 1
printf '\nIMAGE_TAG=%s\n' "$IMAGE_TAG" >> "$MERGED_ENV"

echo "Preparing remote directory..."
ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "mkdir -p '$VPS_REMOTE_DIR'"
scp "${SCP_OPTS[@]}" "$MERGED_ENV" "$SSH_TARGET:$VPS_REMOTE_DIR/$REMOTE_ENV_FILENAME"
scp "${SCP_OPTS[@]}" "$VPS_COMPOSE_FILE" "$SSH_TARGET:$VPS_REMOTE_DIR/$REMOTE_COMPOSE_FILENAME"
scp "${SCP_OPTS[@]}" "$LOCAL_LITELLM_CONFIG_FILE" "$SSH_TARGET:$VPS_REMOTE_DIR/$REMOTE_LITELLM_CONFIG_SECRET_FILENAME"
ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "rm -rf '$VPS_REMOTE_DIR/secrets/generated' && mkdir -p '$VPS_REMOTE_DIR/secrets'"
scp -r "${SCP_OPTS[@]}" "$LOCAL_SECRETS_GENERATED_DIR" "$SSH_TARGET:$VPS_REMOTE_DIR/secrets/"
ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "find '$VPS_REMOTE_DIR/secrets/generated' -type f -exec chmod 600 {} +"
ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "chmod 600 '$VPS_REMOTE_DIR/$REMOTE_LITELLM_CONFIG_SECRET_FILENAME'"

echo "Deploying on VPS (image tag: $IMAGE_TAG)..."
ssh "${SSH_OPTS[@]}" "$SSH_TARGET" bash -s -- \
  "$VPS_REMOTE_DIR" "$REMOTE_ENV_FILENAME" "$REMOTE_COMPOSE_FILENAME" "$UPDATE_ENV_ONLY" "$PRUNE_IMAGES" <<'EOF'
set -euo pipefail

REMOTE_DIR="$1"
ENV_FILENAME="$2"
COMPOSE_FILENAME="$3"
UPDATE_ENV_ONLY="$4"
PRUNE_IMAGES="$5"

cd "$REMOTE_DIR"
chmod 600 "$ENV_FILENAME"

if [[ "$UPDATE_ENV_ONLY" -ne 1 ]]; then
  docker compose --env-file "$ENV_FILENAME" -f "$COMPOSE_FILENAME" pull
fi

docker compose --env-file "$ENV_FILENAME" -f "$COMPOSE_FILENAME" up -d --remove-orphans --force-recreate

if [[ "$PRUNE_IMAGES" -eq 1 ]]; then
  docker image prune -f
fi
EOF

echo "VPS deployment finished successfully."
