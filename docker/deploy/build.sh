#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
source "$SCRIPT_DIR/helpers.sh"

GHCR_OWNER="${GHCR_OWNER:-trackme518}"
VERSION="v1.0.0"
NO_CACHE=0
PUSH=1

BUILDER_NAME="mcp-rag-builder"

usage() {
  cat <<EOF
Usage: ./docker/deploy/build.sh [--version vX.Y.Z] [--no-cache] [--no-push] [--owner <ghcr-owner>]

Builds all application images for linux/amd64 + linux/arm64 and pushes them
to GHCR (GitHub Container Registry) tagged with the given version and 'latest'.

Images: rag-bun, rag-embedding, rag-crawler, rag-litellm, rag-nginx

Flags:
  --version <vX.Y.Z>  Version tag to push (also pushed as 'latest'). Default: v1.0.0
  --no-cache          Rebuild from scratch, bypassing the Docker build cache
  --no-push           Build locally (per-platform, loaded into docker) without pushing.
                      Useful to verify builds without publishing.
  --owner <name>      GHCR owner/namespace (default: trackme518, or GHCR_OWNER env var)
  --help|-h           Show help

Pushing requires: docker login ghcr.io (PAT with write:packages)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      [[ $# -ge 2 ]] || { echo "Missing value for $1" >&2; exit 1; }
      VERSION="$2"
      shift
      ;;
    --owner)
      [[ $# -ge 2 ]] || { echo "Missing value for $1" >&2; exit 1; }
      GHCR_OWNER="$2"
      shift
      ;;
    --no-cache)
      NO_CACHE=1
      ;;
    --no-push)
      PUSH=0
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

[[ -f "$PROJECT_ROOT/Dockerfile" ]] || { echo "Missing Dockerfile in $PROJECT_ROOT" >&2; exit 1; }

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

ensure_buildx

# Multi-platform builds need a docker-container driver builder.
ensure_builder() {
  if ! docker buildx inspect "$BUILDER_NAME" >/dev/null 2>&1; then
    echo "Creating buildx builder: $BUILDER_NAME"
    docker buildx create --name "$BUILDER_NAME" --driver docker-container
  fi
  docker buildx use "$BUILDER_NAME"
}

ensure_builder

# Expanded unquoted so it is either empty or a single --no-cache flag.
NO_CACHE_FLAG=""
if [[ "$NO_CACHE" -eq 1 ]]; then
  NO_CACHE_FLAG="--no-cache"
fi

# target|image-name pairs (mariadb uses the stock library image, not built here).
IMAGES=(
  "bun-runtime|rag-bun"
  "embedding-runtime|rag-embedding"
  "crawler-runtime|rag-crawler"
  "litellm-runtime|rag-litellm"
  "nginx-runtime|rag-nginx"
)

for entry in "${IMAGES[@]}"; do
  target="${entry%%|*}"
  name="${entry##*|}"

  echo "Building ${GHCR_OWNER}/${name}:${VERSION} (target: ${target})..."

  if [[ "$PUSH" -eq 1 ]]; then
    docker buildx build \
      --platform linux/amd64,linux/arm64 \
      $NO_CACHE_FLAG \
      --target "$target" \
      -t "ghcr.io/${GHCR_OWNER}/${name}:${VERSION}" \
      -t "ghcr.io/${GHCR_OWNER}/${name}:latest" \
      --push \
      "$PROJECT_ROOT"
  else
    for platform in linux/amd64 linux/arm64; do
      arch="${platform##*/}"
      docker buildx build \
        --platform "$platform" \
        $NO_CACHE_FLAG \
        --target "$target" \
        -t "ghcr.io/${GHCR_OWNER}/${name}:${VERSION}-${arch}" \
        --load \
        "$PROJECT_ROOT"
    done
  fi
done

if [[ "$PUSH" -eq 1 ]]; then
  echo "Pushed ${GHCR_OWNER}/{rag-bun,rag-embedding,rag-crawler,rag-litellm,rag-nginx}:${VERSION} (+latest) for linux/amd64 and linux/arm64."
else
  echo "Built images locally (not pushed):"
  docker images --format '{{.Repository}}:{{.Tag}}' "ghcr.io/${GHCR_OWNER}/*" | sort
fi
