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
QUICK_TUNNEL_CONTAINER="credit-cloudflared-quick-local"   # overridden per-connection below

green() { printf '\033[0;32m%s\033[0m\n' "$1"; }
info()  { printf '\n==> %s\n' "$1"; }
die()   { printf '\033[0;31mERROR: %s\033[0m\n' "$1" >&2; exit 1; }

# Derive a docker-safe instance id from a connection name (lowercase, [a-z0-9-]).
# This namespaces the compose project + container names + host port so multiple
# accounts can run side-by-side on one laptop with NO hand-editing.
sanitize_instance() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' \
    | sed -e 's/[^a-z0-9]/-/g' -e 's/-\{2,\}/-/g' -e 's/^-//' -e 's/-$//'
}

# First free host TCP port at/after $1 (default 8080), so a second instance
# doesn't collide on the producer's debug port publish.
free_port() {
  local p="${1:-8080}" tries=0
  while nc -z 127.0.0.1 "$p" >/dev/null 2>&1; do
    p=$((p + 1)); tries=$((tries + 1)); [[ $tries -gt 100 ]] && break
  done
  printf '%s' "$p"
}

# --- Parse args: connection name + optional flags -------------------------
CONN_ARG=""
WATCH=false
DOWN=false
TEARDOWN=false
for a in "$@"; do
  case "$a" in
    --down)     DOWN=true ;;
    --teardown) TEARDOWN=true ;;
    --watch)    WATCH=true ;;
    --*)        die "Unknown flag: $a  (--watch self-heals the quick tunnel, --down stops containers, --teardown stops containers + drops the SPCS app)" ;;
    *)          CONN_ARG="$a" ;;
  esac
done

# --- --down: tear down the local producer + tunnel(s) and exit ------------
if [[ "$DOWN" == "true" ]]; then
  info "Stopping local producer + tunnel(s)..."
  # Scope to this connection's project if given; else rely on vm-ingest/.env
  # (which carries COMPOSE_PROJECT_NAME from the last run in this clone).
  if [[ -n "$CONN_ARG" ]]; then
    ( cd "$VM_DIR" && docker compose -p "credit-$(sanitize_instance "$CONN_ARG")" --profile quick --profile tunnel --profile observe down )
  else
    ( cd "$VM_DIR" && docker compose --profile quick --profile tunnel --profile observe down )
  fi
  green "Stopped. (Snowflake objects are left intact.)"
  exit 0
fi

# --- --teardown: stop containers AND drop the deployed SPCS app -----------
# Full "app instance" removal for a demo account you're done with. Keeps the
# demo DB objects (schema / warehouses / pool / role / EAI) so a later
# ./quickstart.sh redeploys quickly. Requires the connection name.
if [[ "$TEARDOWN" == "true" ]]; then
  [[ -n "$CONN_ARG" ]] || die "Pass the connection: ./quickstart.sh --teardown <connection-name>"
  info "Stopping local producer + tunnel(s) for '$CONN_ARG'..."
  ( cd "$VM_DIR" && docker compose -p "credit-$(sanitize_instance "$CONN_ARG")" --profile quick --profile tunnel --profile observe down ) || true
  info "Dropping the deployed SPCS app on '$CONN_ARG'..."
  # deploy-app.sh reads SNOWFLAKE_CONNECTION from this clone's .env (one clone
  # per account), which matches CONN_ARG in the normal flow.
  "$SCRIPT_DIR/deploy-app.sh" --teardown
  green "Teardown complete for '$CONN_ARG'. (Demo DB objects left intact.)"
  exit 0
fi

# --- 1. Prereqs -----------------------------------------------------------
info "Checking prerequisites..."
for bin in snow docker openssl python3 nc; do
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

# Parse KEY=VALUE lines WITHOUT `source` — placeholder values like
# `<your-connection>` contain `<`/`>` that break `source`. Reads literally.
load_env() {
  set -a
  while IFS= read -r _line || [[ -n "$_line" ]]; do
    [[ "$_line" =~ ^[[:space:]]*# ]] && continue
    [[ "$_line" != *"="* ]] && continue
    _key="${_line%%=*}"; _key="${_key//[[:space:]]/}"
    [[ -z "$_key" ]] && continue
    export "$_key=${_line#*=}"
  done <"$1"
  set +a
}

# Push a tunnel host into APP_CONFIG + the egress network rule. The running app
# re-reads APP_CONFIG every ~60s (see web/src/server/vm-proxy.ts CONFIG_TTL_MS),
# so this self-heals a rotated quick-tunnel URL with NO redeploy.
push_ingest_config() {
  local host="$1"
  snow sql --connection "$CONN" --enable-templating NONE -q "
USE WAREHOUSE ${STANDARD_WH};
MERGE INTO ${APP_DB}.${APP_SCHEMA}.${APP_CONFIG_TABLE} AS tgt
USING (SELECT 'INGEST_TUNNEL_HOST' AS KEY, '${host}' AS VALUE) AS src
ON tgt.KEY = src.KEY
WHEN MATCHED THEN UPDATE SET VALUE = src.VALUE, UPDATED = CURRENT_TIMESTAMP()
WHEN NOT MATCHED THEN INSERT (KEY, VALUE) VALUES (src.KEY, src.VALUE);
CREATE OR REPLACE NETWORK RULE ${APP_DB}.${APP_SCHEMA}.${INGEST_NETWORK_RULE}
  MODE = EGRESS TYPE = HOST_PORT VALUE_LIST = ('${host}:443')
  COMMENT = 'Dashboard egress to VM ingest tunnel';
"
}

# Read the current quick-tunnel *.trycloudflare.com host from container logs.
current_quick_host() {
  docker logs "$QUICK_TUNNEL_CONTAINER" 2>&1 \
    | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 | sed 's|https://||'
}

# --- 2. .env scaffold -----------------------------------------------------
info "Preparing .env..."
if [[ ! -f "$ENV_FILE" ]]; then
  cp "$SCRIPT_DIR/.env.example" "$ENV_FILE"
  green "  created .env from .env.example"
fi
load_env "$ENV_FILE"

# Connection: arg wins, else existing .env value.
CONN="${CONN_ARG:-${SNOWFLAKE_CONNECTION:-}}"
if is_placeholder "$CONN"; then
  die "No Snowflake connection. Pass one: ./quickstart.sh <connection-name>  (see 'snow connection list')."
fi
set_env SNOWFLAKE_CONNECTION "$CONN" "$ENV_FILE"
green "  connection: $CONN"

# --- Per-connection namespacing (multi-instance, no hand-editing) ---------
# Every instance is keyed off its connection name so two accounts can run
# side-by-side on one laptop: distinct compose project, container names, and
# host port. Run each account from its own clone (own .env); the Docker layer
# is auto-isolated here.
INSTANCE="$(sanitize_instance "$CONN")"; [[ -n "$INSTANCE" ]] || INSTANCE="local"
QUICK_TUNNEL_CONTAINER="credit-cloudflared-quick-${INSTANCE}"
export COMPOSE_PROJECT_NAME="credit-${INSTANCE}"
export CREDIT_INSTANCE="$INSTANCE"
# Host debug port: reuse the persisted one (idempotent re-runs) else pick a free one.
if is_placeholder "${INGEST_HOST_PORT:-}"; then
  INGEST_HOST_PORT="$(free_port 8080)"
  set_env INGEST_HOST_PORT "$INGEST_HOST_PORT" "$ENV_FILE"
fi
export INGEST_HOST_PORT
green "  instance: $INSTANCE  (compose project credit-$INSTANCE, host port $INGEST_HOST_PORT)"

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
load_env "$ENV_FILE"

# --- --watch: self-heal the quick tunnel (re-push URL on change), then exit --
# Runs after .env is loaded so CONN + APP_* vars are available. Leave it running
# (e.g. `./quickstart.sh --watch &`) alongside a quick tunnel: whenever the
# ephemeral *.trycloudflare.com URL rotates, it re-pushes APP_CONFIG + the
# network rule and the app picks it up within ~60s — no redeploy, no downtime.
if [[ "$WATCH" == "true" ]]; then
  docker ps --format '{{.Names}}' | grep -qx "$QUICK_TUNNEL_CONTAINER" \
    || die "Quick tunnel container '$QUICK_TUNNEL_CONTAINER' is not running. Start it with ./quickstart.sh first."
  info "Watching the quick tunnel for URL changes (Ctrl-C to stop)..."
  last=""
  while true; do
    host="$(current_quick_host || true)"
    if [[ -n "$host" && "$host" != "$last" ]]; then
      info "tunnel host → $host  (re-pushing APP_CONFIG + network rule)"
      if push_ingest_config "$host"; then
        set_env INGEST_TUNNEL_HOST "$host" "$ENV_FILE"
        last="$host"
        green "  pushed — app self-heals within ~60s"
      else
        printf '  (push failed; will retry)\n'
      fi
    fi
    sleep 15
  done
fi

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
  DEFAULT_WAREHOUSE = ${STANDARD_WH}
  DEFAULT_ROLE = ${INGEST_ROLE}
  COMMENT = 'Snowpipe Streaming producer service account (quickstart)';
-- Keep the key + defaults in sync even if the user pre-existed. The producer's
-- non-streaming queries (load POSITIONS_DIM, hydrate book from RAW_EVENTS) need
-- an active warehouse + role; without DEFAULT_WAREHOUSE they fail with
-- 'No active warehouse selected'.
ALTER USER CREDIT_INGEST_USR SET
  RSA_PUBLIC_KEY = '${PUBKEY}'
  DEFAULT_WAREHOUSE = ${STANDARD_WH}
  DEFAULT_ROLE = ${INGEST_ROLE};
GRANT ROLE ${INGEST_ROLE} TO USER CREDIT_INGEST_USR;
"
green "  CREDIT_INGEST_USR ready (keypair auth)"

# --- 6. Start the local producer + Cloudflare tunnel ----------------------
# Named tunnel (stable hostname) if CLOUDFLARE_TUNNEL_TOKEN is set; else the
# zero-setup ephemeral quick tunnel.
NAMED_TUNNEL=false
is_placeholder "${CLOUDFLARE_TUNNEL_TOKEN:-}" || NAMED_TUNNEL=true

# The producer container reads these from vm-ingest/.env (regenerated, git-ignored).
# COMPOSE_PROJECT_NAME/CREDIT_INSTANCE/INGEST_HOST_PORT namespace this instance so
# `docker compose` here (and a later `--down`) scope to it without clobbering others.
cat >"$VM_DIR/.env" <<EOF
# Generated by quickstart.sh — do not commit (git-ignored).
SNOWFLAKE_ACCOUNT=${SNOWFLAKE_ACCOUNT}
INGEST_API_KEY=${INGEST_API_KEY}
CLOUDFLARE_TUNNEL_TOKEN=${CLOUDFLARE_TUNNEL_TOKEN:-}
COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME}
CREDIT_INSTANCE=${CREDIT_INSTANCE}
INGEST_HOST_PORT=${INGEST_HOST_PORT}
EOF

if [[ "$NAMED_TUNNEL" == "true" ]]; then
  info "Starting the producer + NAMED Cloudflare tunnel (stable hostname)..."
  if is_placeholder "${INGEST_TUNNEL_HOST:-}"; then
    die "CLOUDFLARE_TUNNEL_TOKEN is set but INGEST_TUNNEL_HOST is not. Set INGEST_TUNNEL_HOST in .env to the public hostname you routed to this tunnel in the Cloudflare dashboard (e.g. ingest.example.com)."
  fi
  ( cd "$VM_DIR" && docker compose --profile tunnel up -d --build )
  TUNNEL_HOST="$INGEST_TUNNEL_HOST"
  green "  containers up (credit-ingest-$INSTANCE + credit-cloudflared-$INSTANCE); host: $TUNNEL_HOST"
else
  info "Starting the producer + quick tunnel (Docker)..."
  ( cd "$VM_DIR" && docker compose --profile quick up -d --build )
  green "  containers up (credit-ingest-$INSTANCE + $QUICK_TUNNEL_CONTAINER)"

  # --- 7. Capture the ephemeral *.trycloudflare.com hostname --------------
  info "Waiting for the quick tunnel URL..."
  TUNNEL_HOST=""
  for _ in $(seq 1 45); do
    host="$(current_quick_host || true)"
    if [[ -n "$host" ]]; then TUNNEL_HOST="$host"; break; fi
    sleep 1
  done
  [[ -n "$TUNNEL_HOST" ]] || die "Timed out waiting for the tunnel URL. Check: docker logs $QUICK_TUNNEL_CONTAINER"
  set_env INGEST_TUNNEL_HOST "$TUNNEL_HOST" "$ENV_FILE"
  green "  tunnel host: $TUNNEL_HOST"
fi

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
  echo "  • Stop the local producer + tunnel when done:  ./quickstart.sh --down $CONN"
echo "  • Remove this demo entirely (containers + SPCS app):  ./quickstart.sh --teardown $CONN"
echo ""
echo "This instance is namespaced '$INSTANCE' (compose project credit-$INSTANCE) — run"
echo "another account from its own clone and it won't collide with this one."
echo ""
if [[ "$NAMED_TUNNEL" == "true" ]]; then
  echo "Tunnel: NAMED ($TUNNEL_HOST) — stable hostname, survives restarts. Nothing else to do."
else
  echo "Tunnel: QUICK ($TUNNEL_HOST) — ephemeral; the URL rotates on container restart."
  echo "Keep it self-healing (re-pushes the URL to Snowflake automatically):"
  echo "    ./quickstart.sh --watch $CONN &"
  echo "For a URL that never changes, set CLOUDFLARE_TUNNEL_TOKEN + INGEST_TUNNEL_HOST"
  echo "in .env and re-run (uses the named tunnel; see vm-ingest/README.md, Path B)."
fi
