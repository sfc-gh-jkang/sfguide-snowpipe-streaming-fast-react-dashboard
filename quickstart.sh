#!/usr/bin/env bash
# =============================================================================
# quickstart.sh — one command to stand up the whole demo on a fresh account.
#
# No GCP, no cloud VM, no public IP: the Snowpipe Streaming producer + a
# Cloudflare "quick tunnel" run locally in Docker on your laptop. This script
# breaks the bootstrap/tunnel/user chicken-and-egg by ordering the steps:
#   prereqs -> .env -> keypair -> provision Snowflake objects (--infra-only)
#   -> create ingest user from the pubkey -> start producer + quick tunnel
#   -> capture the tunnel URL -> deploy the app + push config.
#
# Usage:
#   ./quickstart.sh <snow-connection-name>   # first run on a fresh account
#   ./quickstart.sh                          # reuse SNOWFLAKE_CONNECTION from .env
#   ./quickstart.sh --down                   # stop the local producer + tunnel
#
# Prereqs: snow CLI (3.0+) with an ACCOUNTADMIN connection, Docker (running),
#          openssl, python3.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"
VM_DIR="$SCRIPT_DIR/vm-ingest"
KEYS_DIR="$VM_DIR/keys"
QUICK_TUNNEL_CONTAINER="credit-cloudflared-quick"

green() { printf '\033[0;32m%s\033[0m\n' "$1"; }
info()  { printf '\n==> %s\n' "$1"; }
die()   { printf '\033[0;31mERROR: %s\033[0m\n' "$1" >&2; exit 1; }

# --- --down: tear down the local producer + tunnel and exit ---------------
if [[ "${1:-}" == "--down" ]]; then
  info "Stopping local producer + quick tunnel..."
  ( cd "$VM_DIR" && docker compose --profile quick down )
  green "Stopped. (Snowflake objects are left intact.)"
  exit 0
fi

# --- 1. Prereqs -----------------------------------------------------------
info "Checking prerequisites..."
for bin in snow docker openssl python3; do
  command -v "$bin" >/dev/null 2>&1 || die "'$bin' not found on PATH. Install it and re-run."
done
docker info >/dev/null 2>&1 || die "Docker daemon is not running. Start Docker Desktop and re-run."
green "  snow, docker, openssl, python3 present; docker daemon up."

# --- Small .env key upsert helper (preserves position) --------------------
set_env() {
  local key="$1" val="$2" file="$3"
  if grep -qE "^${key}=" "$file"; then
    awk -v k="$key" -v v="$val" 'BEGIN{FS=OFS="="} $1==k{print k"="v; next} {print}' "$file" >"$file.tmp" && mv "$file.tmp" "$file"
  else
    printf '%s=%s\n' "$key" "$val" >>"$file"
  fi
}
is_placeholder() { [[ -z "${1:-}" || "$1" == "<"*">" ]]; }

# --- 2. .env scaffold -----------------------------------------------------
info "Preparing .env..."
if [[ ! -f "$ENV_FILE" ]]; then
  cp "$SCRIPT_DIR/.env.example" "$ENV_FILE"
  green "  created .env from .env.example"
fi
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

# Connection: arg wins, else existing .env value.
CONN="${1:-${SNOWFLAKE_CONNECTION:-}}"
if is_placeholder "$CONN"; then
  die "No Snowflake connection. Pass one: ./quickstart.sh <connection-name>  (see 'snow connection list')."
fi
set_env SNOWFLAKE_CONNECTION "$CONN" "$ENV_FILE"
green "  connection: $CONN"

# Account: auto-derive from the connection if still a placeholder.
if is_placeholder "${SNOWFLAKE_ACCOUNT:-}"; then
  info "Auto-detecting SNOWFLAKE_ACCOUNT from connection '$CONN'..."
  ACCT="$(snow connection list --format json 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for c in data:
    if c.get('connection_name') == '$CONN':
        print((c.get('parameters') or {}).get('account', '') or '')
        break
" || true)"
  [[ -n "$ACCT" ]] || die "Could not auto-detect the account. Set SNOWFLAKE_ACCOUNT in .env manually (from 'snow connection list')."
  set_env SNOWFLAKE_ACCOUNT "$ACCT" "$ENV_FILE"
  SNOWFLAKE_ACCOUNT="$ACCT"
  green "  account: $ACCT"
fi

# API key: generate a strong random one if still a placeholder.
if is_placeholder "${INGEST_API_KEY:-}"; then
  INGEST_API_KEY="$(openssl rand -hex 24)"
  set_env INGEST_API_KEY "$INGEST_API_KEY" "$ENV_FILE"
  green "  generated a random INGEST_API_KEY"
fi

# Re-source so later steps see the freshly written values.
set -a; source "$ENV_FILE"; set +a

# --- 3. Keypair for the ingest service user -------------------------------
info "Ensuring the ingest keypair exists..."
if [[ ! -f "$KEYS_DIR/credit_ingest.p8" ]]; then
  mkdir -p "$KEYS_DIR"
  openssl genrsa 2048 2>/dev/null | openssl pkcs8 -topk8 -inform PEM -out "$KEYS_DIR/credit_ingest.p8" -nocrypt
  openssl rsa -in "$KEYS_DIR/credit_ingest.p8" -pubout -out "$KEYS_DIR/credit_ingest.pub" 2>/dev/null
  chmod 600 "$KEYS_DIR/credit_ingest.p8"
  green "  generated vm-ingest/keys/credit_ingest.{p8,pub} (git-ignored)"
else
  green "  reusing existing vm-ingest/keys/credit_ingest.p8"
fi

# --- 4. Provision Snowflake objects (no tunnel host needed yet) -----------
info "Provisioning Snowflake objects (deploy-app.sh --infra-only)..."
"$SCRIPT_DIR/deploy-app.sh" --infra-only

# --- 5. Create the ingest service user from the public key ----------------
info "Creating the ${INGEST_ROLE} service user CREDIT_INGEST_USR..."
PUBKEY="$(grep -v -- '-----' "$KEYS_DIR/credit_ingest.pub" | tr -d '\n')"
[[ -n "$PUBKEY" ]] || die "Failed to read the public key from $KEYS_DIR/credit_ingest.pub"
snow sql --connection "$CONN" --enable-templating NONE -q "
CREATE USER IF NOT EXISTS CREDIT_INGEST_USR
  TYPE = SERVICE
  RSA_PUBLIC_KEY = '${PUBKEY}'
  COMMENT = 'Snowpipe Streaming producer service account (quickstart)';
-- Keep the key in sync with the local keypair even if the user pre-existed
-- (a stale key would fail the producer's JWT auth with a confusing error).
ALTER USER CREDIT_INGEST_USR SET RSA_PUBLIC_KEY = '${PUBKEY}';
GRANT ROLE ${INGEST_ROLE} TO USER CREDIT_INGEST_USR;
"
green "  CREDIT_INGEST_USR ready (keypair auth)"

# --- 6. Start the local producer + Cloudflare quick tunnel ----------------
info "Starting the producer + quick tunnel (Docker)..."
# The producer container reads SNOWFLAKE_ACCOUNT + INGEST_API_KEY from vm-ingest/.env.
cat >"$VM_DIR/.env" <<EOF
# Generated by quickstart.sh — do not commit (git-ignored).
SNOWFLAKE_ACCOUNT=${SNOWFLAKE_ACCOUNT}
INGEST_API_KEY=${INGEST_API_KEY}
EOF
( cd "$VM_DIR" && docker compose --profile quick up -d --build )
green "  containers up (credit-ingest + $QUICK_TUNNEL_CONTAINER)"

# --- 7. Capture the ephemeral *.trycloudflare.com hostname ----------------
info "Waiting for the quick tunnel URL..."
TUNNEL_HOST=""
for _ in $(seq 1 45); do
  URL="$(docker logs "$QUICK_TUNNEL_CONTAINER" 2>&1 | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | head -1 || true)"
  if [[ -n "$URL" ]]; then
    TUNNEL_HOST="${URL#https://}"
    break
  fi
  sleep 1
done
[[ -n "$TUNNEL_HOST" ]] || die "Timed out waiting for the tunnel URL. Check: docker logs $QUICK_TUNNEL_CONTAINER"
set_env INGEST_TUNNEL_HOST "$TUNNEL_HOST" "$ENV_FILE"
green "  tunnel host: $TUNNEL_HOST"

# --- 8. Deploy the app + push tunnel config -------------------------------
info "Deploying the dashboard (deploy-app.sh)..."
"$SCRIPT_DIR/deploy-app.sh"

# --- 9. Health check + done ----------------------------------------------
info "Health-checking the producer through the tunnel..."
if curl -fsS --max-time 15 "https://${TUNNEL_HOST}/health" >/dev/null 2>&1; then
  green "  producer /health OK via tunnel"
else
  printf '  (health check did not pass yet — the producer may still be warming up)\n'
fi

echo ""
green "Quickstart complete."
echo "  • Open the dashboard:  snow app open --connection $CONN"
echo "  • Fire events on the Live Credit Desk tab, or click 'Live Market' on /demo"
echo "  • Stop the local producer + tunnel when done:  ./quickstart.sh --down"
echo ""
echo "Note: the quick tunnel URL is ephemeral (changes on container restart)."
echo "Re-run ./quickstart.sh after a restart to recapture it, or use a named"
echo "Cloudflare tunnel (vm-ingest/README.md, Path B) for a stable hostname."
