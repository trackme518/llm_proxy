#!/usr/bin/env bash

merge_env_files() {
  local local_env_file="$1"
  local vps_env_file="$2"
  local use_vps="$3"
  local merged_env_file="$4"

  cat "$local_env_file" > "$merged_env_file"
  if [[ "$use_vps" -eq 1 ]]; then
    [[ -f "$vps_env_file" ]] || { echo "Missing file: $vps_env_file" >&2; exit 1; }
    printf '\n# --- vps.env overrides ---\n' >> "$merged_env_file"
    cat "$vps_env_file" >> "$merged_env_file"
  fi
}

env_get() {
  local key="$1"
  local file="$2"
  local line current_value

  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]] || continue
    [[ "${BASH_REMATCH[1]}" == "$key" ]] || continue

    current_value="${BASH_REMATCH[2]}"
    if [[ "$current_value" =~ ^"(.*)"$ ]]; then
      current_value="${BASH_REMATCH[1]}"
    elif [[ "$current_value" =~ ^'(.*)'$ ]]; then
      current_value="${BASH_REMATCH[1]}"
    fi

    printf '%s\n' "$current_value"
    return 0
  done < "$file"
}

require_var() {
  local name="$1"
  local file="$2"
  grep -Eq "^[[:space:]]*${name}[[:space:]]*=" "$file" \
    || { echo "Missing required variable: $name" >&2; exit 1; }
}

resolve_path() {
  local project_root="$1"
  local p="$2"
  if [[ "$p" == "~" ]]; then
    p="$HOME"
  elif [[ "${p:0:2}" == "~/" ]]; then
    p="$HOME/${p:2}"
  fi

  if [[ "$p" == /* ]]; then
    echo "$p"
  else
    echo "$project_root/$p"
  fi
}

ensure_ssh_agent_key() {
  local key_path="$1"

  if [[ -z "${SSH_AUTH_SOCK:-}" ]] || ! ssh-add -l >/dev/null 2>&1; then
    eval "$(ssh-agent -s)" >/dev/null
  fi

  if ! ssh-add -l 2>/dev/null | grep -Fq "$key_path"; then
    ssh-add "$key_path"
  fi
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
    *)
      echo "Unsupported host architecture: $(uname -m)" >&2
      exit 1
      ;;
  esac
}

set_compose_platform_env() {
  local merged_env_file="$1"
  local use_vps="$2"

  if grep -Eq '^[[:space:]]*COMPOSE_PLATFORM[[:space:]]*=' "$merged_env_file"; then
    return 0
  fi

  local platform
  if [[ "$use_vps" -eq 1 ]]; then
    local vps_arch
    vps_arch="$(env_get VPS_ARCH "$merged_env_file")"
    if [[ -n "$vps_arch" ]]; then
      platform="$(normalize_platform "$vps_arch")"
    else
      platform="$(detect_host_platform)"
    fi
  else
    platform="$(detect_host_platform)"
  fi

  printf '\nCOMPOSE_PLATFORM=%s\n' "$platform" >> "$merged_env_file"
}