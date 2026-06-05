#!/usr/bin/env bash
# sync-quick-tunnel.sh — Read the current cloudflared-quick public URL from
# its container logs and update Snowflake's APP_CONFIG + EAI network rule.
#
# Use when:
#   - You're running Path A (quick-tunnel mode) and the URL changed
#     (cloudflared restart, VM reboot, container OOM)
#   - The Streamlit shows "VM unreachable: Name resolution failed"
#
# Run from: anywhere with `snow` CLI + `gcloud` access to the VM (typically your laptop)
#
# Usage:
#   bash sync-quick-tunnel.sh                       # auto-detect VM from .env
#   VM_NAME=foo VM_ZONE=us-central1-c bash ...      # explicit
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Source top-level .env for VM_NAME / VM_ZONE / SNOWFLAKE_CONNECTION
if [[ -f "${ROOT_DIR}/.env" ]]; then
    set -a; source "${ROOT_DIR}/.env"; set +a
fi

: "${VM_NAME:?VM_NAME must be set in .env or env}"
: "${VM_ZONE:?VM_ZONE must be set in .env or env}"
: "${SNOWFLAKE_CONNECTION:?SNOWFLAKE_CONNECTION must be set in .env or env}"

echo "==> Fetching current quick-tunnel URL from VM ${VM_NAME}..."
NEW_URL=$(gcloud compute ssh "${VM_NAME}" --zone "${VM_ZONE}" --tunnel-through-iap -- \
    "docker logs credit-cloudflared-quick 2>&1 \
     | grep -oE 'https://[a-z0-9-]+\\.trycloudflare\\.com' | tail -1")

if [[ -z "${NEW_URL}" ]]; then
    echo "ERROR: Could not find a trycloudflare.com URL in cloudflared logs." >&2
    echo "       Check that credit-cloudflared-quick is running:" >&2
    echo "       gcloud compute ssh ${VM_NAME} --zone ${VM_ZONE} -- 'docker compose -f /opt/credit-ingest/vm-ingest/docker-compose.yml --profile quick ps'" >&2
    exit 1
fi

NEW_HOST="${NEW_URL#https://}"
echo "    Current URL: ${NEW_URL}"

echo "==> Updating top-level .env (INGEST_TUNNEL_HOST=${NEW_HOST})..."
sed -i.bak "s|^INGEST_TUNNEL_HOST=.*|INGEST_TUNNEL_HOST=${NEW_HOST}|" "${ROOT_DIR}/.env"
rm -f "${ROOT_DIR}/.env.bak"

echo "==> Updating Snowflake APP_CONFIG + EAI network rule..."
snow sql --connection "${SNOWFLAKE_CONNECTION}" -q "
USE ROLE ACCOUNTADMIN;
USE WAREHOUSE CREDIT_DEMO_WH;
UPDATE SNOWFLAKE_EXAMPLE.CREDIT_DEMO.APP_CONFIG
   SET VALUE='${NEW_HOST}', UPDATED=CURRENT_TIMESTAMP()
 WHERE KEY='INGEST_TUNNEL_HOST';
CREATE OR REPLACE NETWORK RULE SNOWFLAKE_EXAMPLE.CREDIT_DEMO.CREDIT_INGEST_RULE
  MODE = EGRESS TYPE = HOST_PORT
  VALUE_LIST = ('${NEW_HOST}:443', 'trycloudflare.com:443');
ALTER EXTERNAL ACCESS INTEGRATION CREDIT_INGEST_EAI
  SET ALLOWED_NETWORK_RULES = (SNOWFLAKE_EXAMPLE.CREDIT_DEMO.CREDIT_INGEST_RULE);
" > /dev/null

echo ""
echo "✓ Done. Refresh the Streamlit app and clicks should reach the worker."
echo "  (No need to redeploy — Streamlit reads APP_CONFIG on each session start.)"