#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_DIR="$SCRIPT_DIR/example_env"
SECRETS_DIR="$SCRIPT_DIR/secrets"

if [[ ! -d "$TEMPLATE_DIR" ]]; then
  echo "Error: template directory not found: $TEMPLATE_DIR" >&2
  exit 1
fi

for cmd in openssl htpasswd awk; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Error: required command not found: $cmd" >&2
    exit 1
  fi
done

mkdir -p "$SECRETS_DIR"

process_file() {
  local src="$1"
  local dst="$2"

  cp "$src" "$dst"

  local traefik_plain=""

  # Replace Traefik placeholder hash token only when present.
  if grep -q '{SHA}samplepassword=' "$dst"; then
    local traefik_hash
    traefik_plain="$(openssl rand -hex 32)"
    traefik_hash="$(htpasswd -nbs admin "$traefik_plain" | cut -d: -f2-)"

    awk -v hash="$traefik_hash" -v plain="$traefik_plain" '
    {
      line = $0
      if (line ~ /\{SHA\}samplepassword=/) {
        print "# TRAEFIK_PLAIN_PASSWORD=" plain
      }
      gsub(/\{SHA\}samplepassword=/, hash, line)
      print line
    }
    ' "$dst" > "$dst.tmp"
    mv "$dst.tmp" "$dst"
  fi

  # Replace every remaining occurrence of 'samplepassword' with a new random value.
  awk '
  {
    line = $0
    while (match(line, /samplepassword/)) {
      cmd = "openssl rand -hex 32"
      cmd | getline pw
      close(cmd)
      line = substr(line, 1, RSTART - 1) pw substr(line, RSTART + RLENGTH)
    }
    print line
  }
  ' "$dst" > "$dst.tmp"
  mv "$dst.tmp" "$dst"

  # Replace mcp_token with DEFAULT_ADMIN_API_KEY (append if missing) in one pass.
  awk 'BEGIN{a=""} /^[[:space:]]*DEFAULT_ADMIN_API_KEY[[:space:]]*=/{a=$0;sub(/^[[:space:]]*DEFAULT_ADMIN_API_KEY[[:space:]]*=[[:space:]]*/,"",a)} {l[NR]=$0} END{for(i=1;i<=NR;i++){if(l[i] ~ /^[[:space:]]*mcp_token[[:space:]]*=/ && a!=""){print "mcp_token=" a;s=1}else print l[i]} if(!s && a!="") print "mcp_token=" a}' "$dst" > "$dst.tmp" && mv "$dst.tmp" "$dst"

  echo "Created: $dst"
  if [[ -n "$traefik_plain" ]]; then
    echo "TRAEFIK admin password for $(basename "$dst"): $traefik_plain"
  fi
  }

process_file "$TEMPLATE_DIR/local.txt" "$SECRETS_DIR/local.env"
process_file "$TEMPLATE_DIR/vps.txt" "$SECRETS_DIR/vps.env"

echo "Done. Generated local.env and vps.env in $SECRETS_DIR"
