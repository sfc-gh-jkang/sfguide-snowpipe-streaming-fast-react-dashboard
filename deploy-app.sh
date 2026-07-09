#!/usr/bin/env bash
# =============================================================================
# deploy-app.sh — Deploy Next.js dashboard to SPCS via `snow app run`.
#
# Reads .env, renders all SQL/YAML templates with envsubst, and calls
# `snow app run`. With `--bootstrap`, also runs setup.sql + semantic_view.sql
# first to provision the database / schema / warehouses / role / IT / EAI /
# agent on a brand-new account.
#
# Usage:
#   ./deploy-app.sh                 # deploy app only (assumes infra exists)
#   ./deploy-app.sh --bootstrap     # full provision + deploy (fresh account)
#   ./deploy-app.sh --infra-only    # provision Snowflake objects only (no tunnel host / app deploy) — used by quickstart.sh
#   ./deploy-app.sh --render-only   # render templates to /tmp; do not deploy
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

BOOTSTRAP=false
RENDER_ONLY=false
INFRA_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --bootstrap) BOOTSTRAP=true ;;
    --infra-only) INFRA_ONLY=true; BOOTSTRAP=true ;;
    --render-only) RENDER_ONLY=true ;;
    -h|--help)
      grep '^# ' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "Unknown flag: $arg"; exit 2 ;;
  esac
done

# --- Load .env ---
if [[ ! -f "$SCRIPT_DIR/.env" ]]; then
  echo "ERROR: .env not found. Copy .env.example → .env and fill in values."
  exit 1
fi
set -a; source "$SCRIPT_DIR/.env"; set +a

# --- Validate required vars (fail loudly with a useful error) ---
required=(
  SNOWFLAKE_CONNECTION SNOWFLAKE_ACCOUNT
  APP_DB APP_SCHEMA INTERACTIVE_WH STANDARD_WH
  INGEST_ROLE DASHBOARD_ROLE DASHBOARD_POOL DASHBOARD_APP_NAME DASHBOARD_EAI
  INGEST_NETWORK_RULE APP_CONFIG_TABLE
  AGENT_NAME SEMANTIC_VIEW_NAME SEARCH_SERVICE_NAME INGEST_STAGE
)
# The tunnel host + API key are only needed for the config-push + app-deploy
# steps, not for provisioning Snowflake objects. quickstart.sh runs --infra-only
# BEFORE the tunnel exists, so don't require them then.
if [[ "$RENDER_ONLY" != "true" && "$INFRA_ONLY" != "true" ]]; then
  required+=( INGEST_TUNNEL_HOST INGEST_API_KEY )
fi
missing=()
for v in "${required[@]}"; do
  if [[ -z "${!v:-}" || "${!v}" == "<"*">" ]]; then
    missing+=("$v")
  fi
done
if (( ${#missing[@]} > 0 )); then
  echo "ERROR: required .env vars unset or still placeholder:"
  printf '  - %s\n' "${missing[@]}"
  echo "Edit $SCRIPT_DIR/.env and re-run."
  exit 1
fi

# Mirror the public-facing constants for the Next.js bundle build.
export NEXT_PUBLIC_APP_DB="$APP_DB"
export NEXT_PUBLIC_APP_SCHEMA="$APP_SCHEMA"
export NEXT_PUBLIC_INTERACTIVE_WH="$INTERACTIVE_WH"
export NEXT_PUBLIC_STANDARD_WH="$STANDARD_WH"

RENDER_DIR="$(mktemp -d -t credit-dashboard-render.XXXXXX)"
echo "==> Rendering templates → $RENDER_DIR"

render() {
  local src="$1" dest="$2"
  envsubst <"$src" >"$dest"
  echo "    $src → $dest"
}

render "$SCRIPT_DIR/setup.sql"          "$RENDER_DIR/setup.sql"
render "$SCRIPT_DIR/semantic_view.sql"  "$RENDER_DIR/semantic_view.sql"
render "$SCRIPT_DIR/web/snowflake.yml"  "$SCRIPT_DIR/web/snowflake.yml.rendered"
# Rendered yml goes alongside the source in web/ because `snow app run` looks
# for snowflake.yml in the project dir. We swap it in just-in-time below.

if [[ "$RENDER_ONLY" == "true" ]]; then
  echo ""
  echo "==> --render-only: rendered files left at $RENDER_DIR"
  echo "    (and $SCRIPT_DIR/web/snowflake.yml.rendered)"
  exit 0
fi

# --- Optional bootstrap on a fresh account ---
if [[ "$BOOTSTRAP" == "true" ]]; then
  echo ""
  echo "==> --bootstrap: provisioning infra via setup.sql + semantic_view.sql"
  echo "    (idempotent — safe to re-run on an account that's already set up)"

  # NOTE: pipe via --stdin instead of -f. The snow CLI runs `-f` with a
  # 5-second per-statement default that's not exposed via any flag and
  # cancels DDLs like CREATE CORTEX SEARCH SERVICE that take 30-60s.
  # `--stdin` runs the same script as a single multi-statement payload
  # and respects the in-script ALTER SESSION SET STATEMENT_TIMEOUT_IN_SECONDS.
  snow sql --connection "$SNOWFLAKE_CONNECTION" --enable-templating NONE --stdin <"$RENDER_DIR/setup.sql"
  snow sql --connection "$SNOWFLAKE_CONNECTION" --enable-templating NONE --stdin <"$RENDER_DIR/semantic_view.sql"

  echo ""
  echo "==> Bootstrap complete."
fi

# --- Infra-only stops here (quickstart.sh creates the ingest user + tunnel next) ---
if [[ "$INFRA_ONLY" == "true" ]]; then
  echo ""
  echo "==> --infra-only: Snowflake objects provisioned. Skipping tunnel-config push + app deploy."
  exit 0
fi

# --- Push runtime config (always — survives schema rebuilds) ---
echo ""
echo "==> Updating ${APP_DB}.${APP_SCHEMA}.${APP_CONFIG_TABLE} with INGEST_TUNNEL_HOST + INGEST_API_KEY..."
snow sql --connection "$SNOWFLAKE_CONNECTION" --enable-templating NONE -q "
USE WAREHOUSE ${STANDARD_WH};
MERGE INTO ${APP_DB}.${APP_SCHEMA}.${APP_CONFIG_TABLE} AS tgt
USING (
  SELECT * FROM VALUES
    ('INGEST_TUNNEL_HOST', '${INGEST_TUNNEL_HOST}'),
    ('INGEST_API_KEY',     '${INGEST_API_KEY}')
  AS src(KEY, VALUE)
) AS src
ON tgt.KEY = src.KEY
WHEN MATCHED THEN UPDATE SET VALUE = src.VALUE, UPDATED = CURRENT_TIMESTAMP()
WHEN NOT MATCHED THEN INSERT (KEY, VALUE) VALUES (src.KEY, src.VALUE);
"

echo ""
echo "==> Updating ${INGEST_NETWORK_RULE} with tunnel host: ${INGEST_TUNNEL_HOST}..."
snow sql --connection "$SNOWFLAKE_CONNECTION" --enable-templating NONE -q "
CREATE OR REPLACE NETWORK RULE ${APP_DB}.${APP_SCHEMA}.${INGEST_NETWORK_RULE}
  MODE = EGRESS
  TYPE = HOST_PORT
  VALUE_LIST = ('${INGEST_TUNNEL_HOST}:443')
  COMMENT = 'Dashboard egress to VM ingest tunnel';
"

# --- Swap rendered snowflake.yml in for the duration of `snow app run` ---
echo ""
echo "==> Deploying Next.js app via snow app deploy..."
cd "$SCRIPT_DIR/web"
# Save original (template) snowflake.yml; restore on exit.
ORIGINAL_YML="$(mktemp -t snowflake-yml-orig.XXXXXX)"
cp snowflake.yml "$ORIGINAL_YML"
trap 'mv "$ORIGINAL_YML" "$SCRIPT_DIR/web/snowflake.yml"; rm -f "$SCRIPT_DIR/web/snowflake.yml.rendered"' EXIT
mv "$SCRIPT_DIR/web/snowflake.yml.rendered" "$SCRIPT_DIR/web/snowflake.yml"

snow app deploy --connection "$SNOWFLAKE_CONNECTION"

echo ""
echo "==> Deploy complete. Run 'snow app open --connection $SNOWFLAKE_CONNECTION' to view the dashboard."
