#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DOCKER_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
PROJECT_ROOT=$(cd "$DOCKER_DIR/.." && pwd)
source "$SCRIPT_DIR/helpers.sh"

LOCAL_ENV_FILE="$DOCKER_DIR/secrets/local.env"
VPS_ENV_FILE="$DOCKER_DIR/secrets/vps.env"
VPS_COMPOSE_FILE="$DOCKER_DIR/docker-compose.yml"
LOCAL_LITELLM_CONFIG_FILE="$PROJECT_ROOT/litellm/config.json"
LOCAL_SECRETS_GENERATED_DIR="$DOCKER_DIR/secrets/generated"

USE_VPS=0
UPDATE_ENV_ONLY=0
PRUNE_IMAGES=0
NO_CACHE=0

usage() {
  cat <<'EOF'
Usage: ./docker/deploy/deploy.sh [--vps] [--update-env] [--prune] [--no-cache]

Behavior:
- local.env is always loaded first
- if --vps is used, vps.env is loaded on top (override/add)

Modes:
  default: local deploy (build for host architecture)
  --vps:  VPS deploy (build for VPS_ARCH and upload only changed images)

Flags:
  --update-env   Skip build/image transfer and only recreate containers with updated env
  --prune        Run docker image prune -f after deploy
  --no-cache     Rebuild images from scratch, bypassing the Docker build cache
  --help|-h      Show help

Required vps.env vars for --vps:
  VPS_HOST, VPS_USER, VPS_PORT, SSH_KEY_PATH, VPS_REMOTE_DIR
  VPS_ARCH (amd64|arm64|linux/amd64|linux/arm64)

Optional vps.env vars:
  LOCAL_ARCHIVE_DIR (default: docker/dist)
  ARCHIVE_BASENAME (default: rag-images)
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
    --no-cache)
      NO_CACHE=1
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

# Expanded unquoted so it is either empty or a single --no-cache flag.
NO_CACHE_FLAG=""
if [[ "$NO_CACHE" -eq 1 ]]; then
  NO_CACHE_FLAG="--no-cache"
fi

# Use a temporary workspace for merged env, resolved compose output, and image state snapshots.
TMP_DIR=$(mktemp -d)
MERGED_ENV="$TMP_DIR/merged.env"
COMPOSE_RESOLVED="$TMP_DIR/compose.resolved.yml"
LOCAL_STATE_FILE="$TMP_DIR/.image-ids.local"
REMOTE_STATE_FILE="$TMP_DIR/.image-ids.remote"
trap 'rm -rf "$TMP_DIR"' EXIT

# Merge base env with optional VPS overrides so all later steps read one file.
merge_env_files() {
  cat "$LOCAL_ENV_FILE" > "$MERGED_ENV"
  if [[ "$USE_VPS" -eq 1 ]]; then
    [[ -f "$VPS_ENV_FILE" ]] || { echo "Missing file: $VPS_ENV_FILE" >&2; exit 1; }
    printf '\n# --- vps.env overrides ---\n' >> "$MERGED_ENV"
    cat "$VPS_ENV_FILE" >> "$MERGED_ENV"
  fi
}

# Read the last value for KEY from an env-style file, ignoring comments and export prefixes.
env_get() {
  local key="$1"
  local file="$2"
  awk -v wanted="$key" '
    function trim(s){ gsub(/^[[:space:]]+|[[:space:]]+$/, "", s); return s }
    /^[[:space:]]*#/ { next }
    {
      line=$0
      sub(/^[[:space:]]*export[[:space:]]+/, "", line)
      if (line !~ /^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=/) next
      eq=index(line, "=")
      k=trim(substr(line,1,eq-1))
      v=trim(substr(line,eq+1))
      if (k==wanted) last=v
    }
    END {
      if (last != "") {
        if (last ~ /^".*"$/ || last ~ /^'\''.*'\''$/) last=substr(last,2,length(last)-2)
        print last
      }
    }
  ' "$file"
}

require_var() {
  local name="$1"
  local _value="$2"
  grep -Eq "^[[:space:]]*(export[[:space:]]+)?${name}[[:space:]]*=" "$MERGED_ENV" \
    || { echo "Missing required variable: $name" >&2; exit 1; }
}

normalize_platform() {
  case "$1" in
    amd64|x86_64) echo "linux/amd64" ;;
    arm64|aarch64) echo "linux/arm64" ;;
    linux/amd64|linux/arm64) echo "$1" ;;
    *)
      echo "Unsupported platform/arch: $1" >&2
      exit 1
      ;;
  esac
}

detect_host_platform() {
  case "$(uname -m)" in
    x86_64|amd64) echo "linux/amd64" ;;
    arm64|aarch64) echo "linux/arm64" ;;
    *) echo "Unsupported host architecture: $(uname -m)" >&2; exit 1 ;;
  esac
}

ensure_buildx() {
  if docker buildx version >/dev/null 2>&1; then
    return 0
  fi
  echo "docker buildx not found. Attempting install..."
  if [[ "$(uname -s)" == "Darwin" ]] && command -v brew >/dev/null 2>&1; then
    brew install docker-buildx
  else
    echo "Install docker buildx manually and retry." >&2
    exit 1
  fi
}

ensure_ssh_agent_key() {
  local key_path="$1"

  if [[ -z "${SSH_AUTH_SOCK:-}" ]] || ! ssh-add -l >/dev/null 2>&1; then
    echo "Starting ssh-agent..."
    eval "$(ssh-agent -s)" >/dev/null
  fi

  if ! ssh-add -l 2>/dev/null | grep -Fq "$key_path"; then
    echo "Adding SSH key to agent: $key_path"
    ssh-add "$key_path"
  fi
}

compose_service_image() {
  local service_name="$1"
  awk -v svc="$service_name" '
    $0 ~ "^  " svc ":$" { in_service=1; next }
    in_service && $0 ~ "^  [A-Za-z0-9_-]+:" { in_service=0 }
    in_service && $0 ~ "^    image:" {
      sub(/^    image:[[:space:]]*/, "", $0)
      print $0
      exit
    }
  ' "$COMPOSE_RESOLVED"
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

resolve_compose_secret_path() {
  local raw_path="$1"
  local resolved="$raw_path"
  resolved="${resolved//\$\{SECRETS_GENERATED_DIR:-.\/secrets\/generated\}/$LOCAL_SECRETS_GENERATED_DIR}"
  echo "$resolved"
}

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

set_compose_platform_env() {
  local platform="$1"
  # COMPOSE_PLATFORM is used by docker-compose.yml service platform fields.
  printf '\nCOMPOSE_PLATFORM=%s\n' "$platform" >> "$MERGED_ENV"
  # Keep docker/.env in sync for compose variable interpolation.
  cp "$MERGED_ENV" "$DOCKER_DIR/.env"
}

merge_env_files
generate_compose_defined_secrets

# ---- local deploy mode ----
if [[ "$USE_VPS" -eq 0 ]]; then
  # Local mode builds all app images for host architecture and deploys directly.
  [[ -f "$LOCAL_LITELLM_CONFIG_FILE" ]] || { echo "Missing file: $LOCAL_LITELLM_CONFIG_FILE" >&2; exit 1; }
  # Always pin local compose secret source to the local litellm/config.json.
  # This avoids stale values from a previous VPS deploy written into docker/.env.
  printf '\nLITELLM_CONFIG_SECRET_FILE=%s\n' "$LOCAL_LITELLM_CONFIG_FILE" >> "$MERGED_ENV"
  printf '\nSECRETS_GENERATED_DIR=%s\n' "$LOCAL_SECRETS_GENERATED_DIR" >> "$MERGED_ENV"

  TARGET_PLATFORM=$(detect_host_platform)
  set_compose_platform_env "$TARGET_PLATFORM"

  docker compose --env-file "$MERGED_ENV" -f "$VPS_COMPOSE_FILE" config > "$COMPOSE_RESOLVED"

  MARIADB_IMAGE_TAG=$(compose_service_image "mariadb")
  BUN_RAG_IMAGE_TAG=$(compose_service_image "bun-rag")
  EMBEDDING_IMAGE_TAG=$(compose_service_image "embedding")
  CRAWLER_IMAGE_TAG=$(compose_service_image "crawler")
  LITELLM_IMAGE_TAG=$(compose_service_image "litellm")
  NGINX_IMAGE_TAG=$(compose_service_image "nginx")

  if [[ -z "$MARIADB_IMAGE_TAG" || -z "$BUN_RAG_IMAGE_TAG" || -z "$EMBEDDING_IMAGE_TAG" || -z "$CRAWLER_IMAGE_TAG" || -z "$LITELLM_IMAGE_TAG" || -z "$NGINX_IMAGE_TAG" ]]; then
    echo "Failed to resolve image tags for mariadb/bun-rag/embedding/crawler/litellm/nginx" >&2
    exit 1
  fi

  echo "Local deploy mode"
  echo "Using platform: $TARGET_PLATFORM"

  if [[ "$UPDATE_ENV_ONLY" -eq 1 ]]; then
    # Skip image build and just recreate containers with updated environment.
    docker compose --env-file "$MERGED_ENV" -f "$VPS_COMPOSE_FILE" up -d --remove-orphans --force-recreate
  else
    ensure_buildx
    docker buildx build --platform "$TARGET_PLATFORM" $NO_CACHE_FLAG --target mariadb-runtime -t "$MARIADB_IMAGE_TAG" --load "$PROJECT_ROOT"
    docker buildx build --platform "$TARGET_PLATFORM" $NO_CACHE_FLAG --target embedding-runtime -t "$EMBEDDING_IMAGE_TAG" --load "$PROJECT_ROOT"
    docker buildx build --platform "$TARGET_PLATFORM" $NO_CACHE_FLAG --target crawler-runtime -t "$CRAWLER_IMAGE_TAG" --load "$PROJECT_ROOT"
    docker buildx build --platform "$TARGET_PLATFORM" $NO_CACHE_FLAG --target bun-runtime -t "$BUN_RAG_IMAGE_TAG" --load "$PROJECT_ROOT"
    docker buildx build --platform "$TARGET_PLATFORM" $NO_CACHE_FLAG --target litellm-runtime -t "$LITELLM_IMAGE_TAG" --load "$PROJECT_ROOT"
    docker buildx build --platform "$TARGET_PLATFORM" $NO_CACHE_FLAG --target nginx-runtime -t "$NGINX_IMAGE_TAG" --load "$PROJECT_ROOT"

    docker compose --env-file "$MERGED_ENV" -f "$VPS_COMPOSE_FILE" up -d --remove-orphans --force-recreate
  fi

  if [[ "$PRUNE_IMAGES" -eq 1 ]]; then
    docker image prune -f
  fi

  echo "Local deploy finished successfully."
  exit 0
fi

# ---- vps deploy mode ----
# VPS mode builds for target architecture, uploads changed artifacts, and redeploys remotely.
VPS_HOST=$(env_get "VPS_HOST" "$MERGED_ENV")
VPS_USER=$(env_get "VPS_USER" "$MERGED_ENV")
VPS_PORT=$(env_get "VPS_PORT" "$MERGED_ENV")
SSH_KEY_PATH_RAW=$(env_get "SSH_KEY_PATH" "$MERGED_ENV")
VPS_REMOTE_DIR=$(env_get "VPS_REMOTE_DIR" "$MERGED_ENV")
VPS_ARCH_RAW=$(env_get "VPS_ARCH" "$MERGED_ENV")
LOCAL_ARCHIVE_DIR_RAW=$(env_get "LOCAL_ARCHIVE_DIR" "$MERGED_ENV")
ARCHIVE_BASENAME=$(env_get "ARCHIVE_BASENAME" "$MERGED_ENV")

LOCAL_ARCHIVE_DIR_RAW=${LOCAL_ARCHIVE_DIR_RAW:-docker/dist}
ARCHIVE_BASENAME=${ARCHIVE_BASENAME:-rag-images}

require_var VPS_HOST "$VPS_HOST"
require_var VPS_USER "$VPS_USER"
require_var VPS_PORT "$VPS_PORT"
require_var SSH_KEY_PATH "$SSH_KEY_PATH_RAW"
require_var VPS_REMOTE_DIR "$VPS_REMOTE_DIR"
require_var VPS_ARCH "$VPS_ARCH_RAW"

SSH_KEY_PATH=$(resolve_path "$PROJECT_ROOT" "$SSH_KEY_PATH_RAW")
LOCAL_ARCHIVE_PATH=$(resolve_path "$PROJECT_ROOT" "$LOCAL_ARCHIVE_DIR_RAW")
[[ -f "$SSH_KEY_PATH" ]] || { echo "Missing SSH key: $SSH_KEY_PATH" >&2; exit 1; }

TARGET_PLATFORM=$(normalize_platform "$VPS_ARCH_RAW")
set_compose_platform_env "$TARGET_PLATFORM"

ensure_ssh_agent_key "$SSH_KEY_PATH"
ensure_buildx

SSH_TARGET="$VPS_USER@$VPS_HOST"
SSH_OPTS=(-i "$SSH_KEY_PATH" -p "$VPS_PORT" -o StrictHostKeyChecking=accept-new)
SCP_OPTS=(-i "$SSH_KEY_PATH" -P "$VPS_PORT" -o StrictHostKeyChecking=accept-new)
REMOTE_ENV_FILENAME=".env"
REMOTE_COMPOSE_FILENAME=$(basename "$VPS_COMPOSE_FILE")
REMOTE_LITELLM_CONFIG_SECRET_FILENAME="litellm-config.secret.json"

[[ -f "$LOCAL_LITELLM_CONFIG_FILE" ]] || { echo "Missing file: $LOCAL_LITELLM_CONFIG_FILE" >&2; exit 1; }
# Point compose secret source to a file in the remote deploy directory.
printf '\nLITELLM_CONFIG_SECRET_FILE=./%s\n' "$REMOTE_LITELLM_CONFIG_SECRET_FILENAME" >> "$MERGED_ENV"
printf '\nSECRETS_GENERATED_DIR=./secrets/generated\n' >> "$MERGED_ENV"

echo "Preparing remote directory..."
ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "mkdir -p '$VPS_REMOTE_DIR'"
scp "${SCP_OPTS[@]}" "$MERGED_ENV" "$SSH_TARGET:$VPS_REMOTE_DIR/$REMOTE_ENV_FILENAME"
scp "${SCP_OPTS[@]}" "$VPS_COMPOSE_FILE" "$SSH_TARGET:$VPS_REMOTE_DIR/$REMOTE_COMPOSE_FILENAME"
# Upload secret config directly (sequential deploy flow).
scp "${SCP_OPTS[@]}" "$LOCAL_LITELLM_CONFIG_FILE" "$SSH_TARGET:$VPS_REMOTE_DIR/$REMOTE_LITELLM_CONFIG_SECRET_FILENAME"
ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "rm -rf '$VPS_REMOTE_DIR/secrets/generated' && mkdir -p '$VPS_REMOTE_DIR/secrets'"
scp -r "${SCP_OPTS[@]}" "$LOCAL_SECRETS_GENERATED_DIR" "$SSH_TARGET:$VPS_REMOTE_DIR/secrets/"
ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "find '$VPS_REMOTE_DIR/secrets/generated' -type f -exec chmod 600 {} +"
ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "chmod 600 '$VPS_REMOTE_DIR/$REMOTE_LITELLM_CONFIG_SECRET_FILENAME'"

if [[ "$UPDATE_ENV_ONLY" -eq 1 ]]; then
  # Remote env-only update: no build/upload, only container recreation.
  echo "Applying env-only update on VPS..."
  ssh "${SSH_OPTS[@]}" "$SSH_TARGET" bash -s -- \
    "$VPS_REMOTE_DIR" "$REMOTE_ENV_FILENAME" "$REMOTE_COMPOSE_FILENAME" "$PRUNE_IMAGES" <<'EOF'
set -euo pipefail
REMOTE_DIR="$1"
ENV_FILENAME="$2"
COMPOSE_FILENAME="$3"
PRUNE_IMAGES="$4"
cd "$REMOTE_DIR"
chmod 600 "$ENV_FILENAME"
docker compose --env-file "$ENV_FILENAME" -f "$COMPOSE_FILENAME" up -d --remove-orphans --force-recreate
if [[ "$PRUNE_IMAGES" -eq 1 ]]; then
  docker image prune -f
fi
EOF

  echo "VPS env update finished successfully."
  exit 0
fi

docker compose --env-file "$MERGED_ENV" -f "$VPS_COMPOSE_FILE" config > "$COMPOSE_RESOLVED"

BUN_RAG_IMAGE_TAG=$(compose_service_image "bun-rag")
EMBEDDING_IMAGE_TAG=$(compose_service_image "embedding")
CRAWLER_IMAGE_TAG=$(compose_service_image "crawler")
LITELLM_IMAGE_TAG=$(compose_service_image "litellm")
NGINX_IMAGE_TAG=$(compose_service_image "nginx")

if [[ -z "$BUN_RAG_IMAGE_TAG" || -z "$EMBEDDING_IMAGE_TAG" || -z "$CRAWLER_IMAGE_TAG" || -z "$LITELLM_IMAGE_TAG" || -z "$NGINX_IMAGE_TAG" ]]; then
  echo "Failed to resolve image tags for bun-rag/embedding/crawler/litellm/nginx" >&2
  exit 1
fi

echo "Building images for $TARGET_PLATFORM..."
docker buildx build --platform "$TARGET_PLATFORM" $NO_CACHE_FLAG --target bun-runtime -t "$BUN_RAG_IMAGE_TAG" --load "$PROJECT_ROOT"
docker buildx build --platform "$TARGET_PLATFORM" $NO_CACHE_FLAG --target embedding-runtime -t "$EMBEDDING_IMAGE_TAG" --load "$PROJECT_ROOT"
docker buildx build --platform "$TARGET_PLATFORM" $NO_CACHE_FLAG --target crawler-runtime -t "$CRAWLER_IMAGE_TAG" --load "$PROJECT_ROOT"
docker buildx build --platform "$TARGET_PLATFORM" $NO_CACHE_FLAG --target litellm-runtime -t "$LITELLM_IMAGE_TAG" --load "$PROJECT_ROOT"
docker buildx build --platform "$TARGET_PLATFORM" $NO_CACHE_FLAG --target nginx-runtime -t "$NGINX_IMAGE_TAG" --load "$PROJECT_ROOT"

BUILT_IMAGES=("$BUN_RAG_IMAGE_TAG" "$EMBEDDING_IMAGE_TAG" "$CRAWLER_IMAGE_TAG" "$LITELLM_IMAGE_TAG" "$NGINX_IMAGE_TAG")

IMAGES=()
while IFS= read -r image; do
  [[ -n "$image" ]] && IMAGES+=("$image")
done < <(docker compose --env-file "$MERGED_ENV" -f "$VPS_COMPOSE_FILE" config --images | sort -u)
[[ ${#IMAGES[@]} -gt 0 ]] || { echo "No images resolved from compose." >&2; exit 1; }

is_built_image() {
  local candidate="$1"
  local built
  for built in "${BUILT_IMAGES[@]}"; do
    [[ "$candidate" == "$built" ]] && return 0
  done
  return 1
}

echo "Pulling non-built images for $TARGET_PLATFORM..."
for image in "${IMAGES[@]}"; do
  if ! is_built_image "$image"; then
    docker pull --platform "$TARGET_PLATFORM" "$image"
  fi
done

# Capture image IDs locally and compare with remote state to upload only changed images.
: > "$LOCAL_STATE_FILE"
for image in "${IMAGES[@]}"; do
  image_id=$(docker image inspect --format '{{.Id}}' "$image")
  printf '%s|%s\n' "$image" "$image_id" >> "$LOCAL_STATE_FILE"
done

ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "cat '$VPS_REMOTE_DIR/.image-ids' 2>/dev/null || true" > "$REMOTE_STATE_FILE"

CHANGED_IMAGES=()
while IFS='|' read -r image image_id; do
  [[ -z "$image" ]] && continue
  remote_id=$(awk -F'|' -v img="$image" '$1 == img { print $2; exit }' "$REMOTE_STATE_FILE")
  if [[ "$remote_id" != "$image_id" ]]; then
    CHANGED_IMAGES+=("$image")
  fi
done < "$LOCAL_STATE_FILE"

mkdir -p "$LOCAL_ARCHIVE_PATH"
ARCHIVE_TAR="$LOCAL_ARCHIVE_PATH/$ARCHIVE_BASENAME.tar"
ARCHIVE_GZ="$ARCHIVE_TAR.gz"
rm -f "$ARCHIVE_TAR" "$ARCHIVE_GZ"

if [[ ${#CHANGED_IMAGES[@]} -gt 0 ]]; then
  echo "Packing changed images (${#CHANGED_IMAGES[@]})..."
  docker save "${CHANGED_IMAGES[@]}" -o "$ARCHIVE_TAR"
  gzip -f "$ARCHIVE_TAR"

  ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "rm -f '$VPS_REMOTE_DIR/$ARCHIVE_BASENAME.tar' '$VPS_REMOTE_DIR/$ARCHIVE_BASENAME.tar.gz'"
  scp "${SCP_OPTS[@]}" "$ARCHIVE_GZ" "$SSH_TARGET:$VPS_REMOTE_DIR/$ARCHIVE_BASENAME.tar.gz"
else
  echo "No image changes detected. Skipping image upload."
fi

scp "${SCP_OPTS[@]}" "$LOCAL_STATE_FILE" "$SSH_TARGET:$VPS_REMOTE_DIR/.image-ids.new"

echo "Deploying on VPS..."
# Remote phase: load uploaded images (if any), run compose up, optionally prune, and persist image state.
ssh "${SSH_OPTS[@]}" "$SSH_TARGET" bash -s -- \
  "$VPS_REMOTE_DIR" "$ARCHIVE_BASENAME" "$REMOTE_ENV_FILENAME" "$REMOTE_COMPOSE_FILENAME" "${#CHANGED_IMAGES[@]}" "$PRUNE_IMAGES" <<'EOF'
set -euo pipefail

REMOTE_DIR="$1"
ARCHIVE_BASE="$2"
ENV_FILENAME="$3"
COMPOSE_FILENAME="$4"
CHANGED_COUNT="$5"
PRUNE_IMAGES="$6"

cd "$REMOTE_DIR"
chmod 600 "$ENV_FILENAME"

if [[ "$CHANGED_COUNT" -gt 0 ]]; then
  rm -f "$ARCHIVE_BASE.tar"
  gunzip -f "$ARCHIVE_BASE.tar.gz"
  docker load -i "$ARCHIVE_BASE.tar"
  rm -f "$ARCHIVE_BASE.tar"
fi

docker compose --env-file "$ENV_FILENAME" -f "$COMPOSE_FILENAME" up -d --remove-orphans --force-recreate

if [[ "$PRUNE_IMAGES" -eq 1 ]]; then
  docker image prune -f
fi

mv -f .image-ids.new .image-ids
EOF

echo "VPS deployment finished successfully."
