#!/usr/bin/env bash
# deploy.sh — Build observe-agent.yaml from template with baked tokens,
# copy project to VM, and start containers.
# Usage: ./deploy.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Load top-level .env (created from .env.example)
if [[ ! -f "${ROOT_DIR}/.env" ]]; then
    echo "ERROR: ${ROOT_DIR}/.env not found. Copy .env.example to .env and fill in your values." >&2
    exit 1
fi
set -a; source "${ROOT_DIR}/.env"; set +a

: "${VM_NAME:?VM_NAME must be set in .env}"
: "${VM_ZONE:?VM_ZONE must be set in .env}"

VM_DEST="/opt/credit-ingest"
KEY_SRC="$HOME/.snowflake/keys/credit_ingest.p8"
ENV_SRC="$SCRIPT_DIR/.env"  # vm-ingest/.env contains OBSERVE_* tokens (separate from top-level .env)

echo "=== Baking observe-agent.yaml from template ==="
# Source env vars (contains OBSERVE_TOKEN, OBSERVE_COLLECTION_URL, OBSERVE_DATASTREAM_TOKEN)
set -a; source "$ENV_SRC"; set +a

# Extract collection URL host for observe_url
OBSERVE_URL="${OBSERVE_COLLECTION_URL}"

sed \
  -e "s|__OBSERVE_TOKEN__|${OBSERVE_TOKEN}|g" \
  -e "s|__OBSERVE_URL__|${OBSERVE_URL}|g" \
  -e "s|__OBSERVE_DATASTREAM_TOKEN__|${OBSERVE_DATASTREAM_TOKEN}|g" \
  "$SCRIPT_DIR/observe-agent.yaml.tpl" > "$SCRIPT_DIR/observe-agent.yaml"

echo "=== observe-agent.yaml baked (tokens not echoed) ==="

echo "=== Creating VM directory ==="
gcloud compute ssh "$VM_NAME" --zone "$VM_ZONE" --command \
  "sudo mkdir -p $VM_DEST/keys && sudo chown -R \$(whoami):\$(whoami) $VM_DEST"

echo "=== Generating uv.lock ==="
(cd "$SCRIPT_DIR" && uv lock)

echo "=== Copying project files to VM ==="
gcloud compute scp --zone "$VM_ZONE" --recurse \
  "$SCRIPT_DIR/pyproject.toml" \
  "$SCRIPT_DIR/uv.lock" \
  "$SCRIPT_DIR/streaming_service.py" \
  "$SCRIPT_DIR/ingest_worker.py" \
  "$SCRIPT_DIR/Dockerfile" \
  "$SCRIPT_DIR/docker-compose.yml" \
  "$SCRIPT_DIR/observe-agent.yaml" \
  "$VM_NAME:$VM_DEST/"

echo "=== Copying keypair to VM ==="
gcloud compute scp --zone "$VM_ZONE" \
  "$KEY_SRC" "$VM_NAME:$VM_DEST/keys/credit_ingest.p8"

echo "=== Setting key permissions ==="
gcloud compute ssh "$VM_NAME" --zone "$VM_ZONE" --command \
  "chmod 600 $VM_DEST/keys/credit_ingest.p8"

echo "=== Building and starting containers ==="
gcloud compute ssh "$VM_NAME" --zone "$VM_ZONE" --command \
  "cd $VM_DEST && docker compose up -d --build"

echo "=== Waiting 60s for startup (4 channel opens) ==="
sleep 60

echo "=== Health check ==="
gcloud compute ssh "$VM_NAME" --zone "$VM_ZONE" --command \
  "curl -s http://localhost:8080/health | python3 -m json.tool"

echo "=== Smoke test ==="
gcloud compute ssh "$VM_NAME" --zone "$VM_ZONE" --command \
  "curl -s -X POST http://localhost:8080/ingest \
    -H 'Content-Type: application/json' \
    -H 'X-API-Key: <set-via-env-INGEST_API_KEY>' \
    -d '{\"event_type\":\"TRADE\",\"position_id\":\"POS-0001\"}' | python3 -m json.tool"

echo ""
echo "=== Container status ==="
gcloud compute ssh "$VM_NAME" --zone "$VM_ZONE" --command \
  "docker compose -f $VM_DEST/docker-compose.yml ps"

echo ""
echo "=== Deploy complete ==="
echo "Access from laptop: gcloud compute ssh $VM_NAME --zone $VM_ZONE --tunnel-through-iap -- -L 8080:localhost:8080"
echo "Then: curl -X POST http://localhost:8080/ingest -H 'Content-Type: application/json' -H 'X-API-Key: <set-via-env-INGEST_API_KEY>' -d '{\"event_type\":\"TRADE\",\"position_id\":\"POS-0001\"}'"

# Cleanup baked file (tokens were in it)
rm -f "$SCRIPT_DIR/observe-agent.yaml"
echo "(Cleaned up local observe-agent.yaml with baked tokens)"
