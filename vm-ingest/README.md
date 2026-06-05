# ACME Credit Demo — VM Ingest Worker

Snowpipe Streaming HPA Python ingest worker running on GCP VM `<your-vm-name>`.

## Architecture

```
Laptop/Streamlit → IAP tunnel → VM:8080 → FastAPI → Snowpipe Streaming SDK → RAW_EVENTS
                                                  → OTel traces → observe-agent → Observe
```

## Deploy

```bash
cd ~/Documents/vscode/credit-demo/vm-ingest
chmod +x deploy.sh
./deploy.sh
```

This will:
1. Bake Observe tokens into observe-agent.yaml (from .env (copy from .env.example))
2. Copy project + keypair to VM at `/opt/credit-ingest/`
3. Build and start both containers
4. Run health check and smoke test

## Access from Laptop

```bash
# IAP tunnel (port forward 8080)
gcloud compute ssh <your-vm-name> --zone us-central1-c \
  --tunnel-through-iap -- -L 8080:localhost:8080
```

Then in another terminal:
```bash
# Health check
curl http://localhost:8080/health

# Single event
curl -X POST http://localhost:8080/ingest \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: <set-via-env-INGEST_API_KEY>' \
  -d '{"event_type":"TRADE","position_id":"POS-0001"}'

# Batch events
curl -X POST http://localhost:8080/ingest/batch \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: <set-via-env-INGEST_API_KEY>' \
  -d '[{"event_type":"TRADE","position_id":"POS-0001"},{"event_type":"MARK","position_id":"POS-0002"},{"event_type":"CREDIT_EVENT","position_id":"POS-0003"}]'
```

## Auth

Static API key via `X-API-Key` header. Default: `<set-via-env-INGEST_API_KEY>`.
Set via `INGEST_API_KEY` env var in docker-compose.yml.

## Snowflake Objects

- Table: `SNOWFLAKE_EXAMPLE.CREDIT_DEMO.RAW_EVENTS`
- Pipe: `RAW_EVENTS-STREAMING` (auto-created by SDK)
- Service user: `CREDIT_INGEST_USR` (keypair auth)
- Interactive Table: `PORTFOLIO_LIVE` (TARGET_LAG=1 min, refreshes from RAW_EVENTS)

## Containers

| Container | Image | Port | Purpose |
|-----------|-------|------|---------|
| credit-ingest | local build | 8080 | FastAPI ingest worker |
| credit-observe-agent | observeinc/observe-agent:2.0.0 | 4318 (internal) | OTLP trace relay to Observe |

## Teardown

```bash
gcloud compute ssh <your-vm-name> --zone us-central1-c --command \
  "cd /opt/credit-ingest && docker compose down"
```
