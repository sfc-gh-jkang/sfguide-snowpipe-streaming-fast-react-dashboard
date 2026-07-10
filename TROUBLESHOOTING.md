# Troubleshooting

## Where things run

**TL;DR:** `cloudflared` and `credit-ingest` both run **on your VM**, in Docker Compose, on the same network. The VM is the only host that needs Docker — your laptop just runs `gcloud ssh` + `snow` CLI to operate it.

```
┌─────────────────────────────────────────────────────────────────────┐
│  Snowflake (your account)                                            │
│  ┌─────────────────────────┐    ┌────────────────────────────────┐  │
│  │ Next.js on SPCS           │    │ CREDIT_DEMO schema             │  │
│  │ (Snowflake App,           │───▶│  RAW_EVENTS  (Interactive)     │  │
│  │  CREDIT_POOL)            │    │  POSITIONS_DIM                 │  │
│  │  ─ reads APP_CONFIG      │    │  APP_CONFIG  (runtime config)  │  │
│  │  ─ POSTs trades via EAI  │    │  CREDIT_AGENT (Cortex Agent)   │  │
│  │  ─ EAI: DASHBOARD_VM_    │    │  POSITIONS_SEARCH              │  │
│  │    EAI → trycloudflare   │    └────────────────────────────────┘  │
│  └────────────┬────────────┘                                         │
└───────────────┼─────────────────────────────────────────────────────┘
                │ HTTPS (egress via External Access Integration)
                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Cloudflare edge                                                     │
│  ┌────────────────────────────────────────────────────────────┐     │
│  │ Tunnel:  *.trycloudflare.com  (quick)  OR                  │     │
│  │          your-host.example.com (named tunnel)              │     │
│  └─────────────────────────────┬──────────────────────────────┘     │
└────────────────────────────────┼─────────────────────────────────────┘
                                 │ outbound TLS from cloudflared (no inbound port)
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│  YOUR VM (GCP / AWS / wherever Docker Compose runs)                  │
│  ┌──────────────────┐   ┌──────────────────┐   ┌─────────────────┐  │
│  │ cloudflared      │   │ credit-ingest    │   │ observe-agent   │  │
│  │ (tunnel client)  │──▶│ FastAPI :8080    │──▶│ OTLP sidecar    │  │
│  │ ─ no public port │   │ HPA SDK 4-channel│   │ (optional)      │  │
│  └──────────────────┘   └────────┬─────────┘   └─────────────────┘  │
└──────────────────────────────────┼───────────────────────────────────┘
                                   │ Snowpipe Streaming HPA (keypair JWT)
                                   ▼ writes to RAW_EVENTS Interactive Table
```

**Key points:**
- **Cloudflared makes an *outbound* connection to Cloudflare.** The VM never opens an inbound port. If your VM has no public IP (or uses GCP IAP-only SSH), the tunnel still works.
- **Always run cloudflared on the VM**, not on your laptop. Demo backends should survive your laptop closing.
- Quick-tunnel mode is fine for demos *as long as you accept the URL changes on cloudflared restart* — see "Quick-tunnel handling" below.

---

## Quick-tunnel handling (Path A)

Quick-tunnel (`cloudflared tunnel --url`) is **anonymous and ephemeral** by Cloudflare design. The hostname changes on every cloudflared restart. There's nothing you can do to keep it stable — that's why **named tunnels exist** (Paths B/C/D).

### When to use quick-tunnel
- ✅ One-off testing, hackathons, "I just want to see the demo work in 5 minutes"
- ✅ You don't have (or don't want to set up) a Cloudflare account
- ❌ Anything that needs to survive a VM reboot or container OOM
- ❌ Sharing the URL with customers — it WILL break before they click it

### When the URL changes (it will), recover with:

```bash
# From your laptop, with the repo cloned + .env populated:
bash vm-ingest/sync-quick-tunnel.sh
```

This script:
1. SSHes to your VM
2. Greps the new URL from `credit-cloudflared-quick` container logs
3. Updates your local `.env`
4. Updates Snowflake's `APP_CONFIG.INGEST_TUNNEL_HOST`
5. Updates the EAI network rule (so SPCS egress works for the new hostname)

After it runs, refresh the dashboard — clicks reach the worker again. **No `./deploy-app.sh` redeploy needed** because the dashboard re-reads `APP_CONFIG` every ~60s (`web/src/server/vm-proxy.ts` `CONFIG_TTL_MS`).

### Laptop quickstart (Path A) — self-healing, no VM

If you ran `./quickstart.sh <connection>` (producer + tunnel in local Docker), keep the URL current automatically:

```bash
./quickstart.sh --watch <connection> &
```

`--watch` polls the local `cloudflared` container; whenever the `*.trycloudflare.com` URL changes it re-pushes `INGEST_TUNNEL_HOST` into `APP_CONFIG` and `CREATE OR REPLACE`s the egress network rule. The app self-heals within ~60s — no redeploy. Two related hardenings already in place:
- **`--protocol http2`** on both cloudflared services — avoids the QUIC connection resets that silently drop the tunnel on corporate networks (symptom: `502 ingest-verified failed: fetch failed` while the container still looks healthy).
- The quick tunnel only changes its URL on **container restart**; a plain reconnect keeps the same URL.

### Better long-term: switch to a named tunnel
If you find yourself running `sync-quick-tunnel.sh` more than once, just spend 5 minutes setting up a named tunnel (Path B in the README). Free Cloudflare account, stable hostname, restart-safe.

---

## Tunnel dies during a demo — what happens?

| Tunnel mode | Symptom in dashboard | Recovery |
|---|---|---|
| **Quick-tunnel** (`*.trycloudflare.com`) | "VM unreachable: Name resolution failed" — the URL is dead | Restart `cloudflared-quick`, get the new URL, **update `INGEST_TUNNEL_HOST` in `.env` and re-run `./deploy-app.sh`** (regenerates APP_CONFIG + EAI network rule). URL is ephemeral by design. |
| **Named tunnel** (your stable hostname) | Brief Cloudflare 1033 "Tunnel error" page for ~5-30s | cloudflared has `restart: unless-stopped` in compose; reconnects automatically. Stable hostname survives. No `.env` change needed. |
| **Terraform-provisioned tunnel** | Same as named tunnel (it IS a named tunnel) | Same recovery. `terraform apply` would re-provision if the resource was destroyed. |

### Recovery script for quick-tunnel mode

When the URL changes, run this on your laptop:

```bash
# Get the fresh URL from cloudflared logs
NEW_URL=$(gcloud compute ssh "$VM_NAME" --zone "$VM_ZONE" -- \
  "docker logs credit-cloudflared-quick 2>&1 | grep -oE 'https://[a-z0-9-]+\\.trycloudflare\\.com' | tail -1")

# Update .env and redeploy
sed -i '' "s|^INGEST_TUNNEL_HOST=.*|INGEST_TUNNEL_HOST=${NEW_URL#https://}|" .env
./deploy-app.sh
```

`deploy-app.sh` updates both `APP_CONFIG` and the `DASHBOARD_VM_EAI` network rule, then redeploys the SPCS app.

---

## Common issues

### `HTTP 404` on `/v2/streaming/hostname` from HPA SDK

The auto-PIPE `<TABLE>-STREAMING` couldn't be created. Cause: ingest role missing `CREATE PIPE` on schema. Fix:

```sql
GRANT CREATE PIPE ON SCHEMA SNOWFLAKE_EXAMPLE.CREDIT_DEMO TO ROLE CREDIT_INGEST_RL;
```

(Already in `setup.sql` — only an issue if you upgraded an older deploy.)

### Dashboard shows "VM unreachable: Name resolution failed" with `%3cyour-tunnel-host%3e`

`APP_CONFIG` table is empty or the placeholder leaked. Fix: `./deploy-app.sh` again — it sources `.env` and MERGEs the values.

### Dashboard shows VM 403 / Forbidden

Cloudflare Bot Fight Mode + Browser Integrity Check are blocking SPCS egress. Fix in your Cloudflare dashboard: Security → Settings → toggle **Bot fight mode OFF** AND **Browser integrity check OFF** for the zone (or add a WAF custom rule that "Skips" both for the tunnel hostname).

### Quick-tunnel works from curl but not from the dashboard

EAI network rule doesn't allow the new tunnel hostname. `deploy-app.sh` keeps it in sync — re-run it after a tunnel restart, or manually:

```sql
CREATE OR REPLACE NETWORK RULE SNOWFLAKE_EXAMPLE.CREDIT_DEMO.CREDIT_INGEST_RULE
  MODE = EGRESS TYPE = HOST_PORT
  VALUE_LIST = ('your-new-host.trycloudflare.com:443', 'trycloudflare.com:443');
```

### SPCS container shows old code after deploy

The Snowflake App caches container images. `deploy-app.sh` handles image tagging and redeployment. If you get stuck, run `./deploy-app.sh --bootstrap` to force a full re-provision.

### `credit-ingest` health endpoint shows `status: degraded, channel_count: 0`

HPA SDK failed to initialize. Check `docker logs credit-ingest` for the real cause:
- 401/403 → keypair / role mismatch (verify `CREDIT_INGEST_USR` has the right RSA_PUBLIC_KEY + DEFAULT_ROLE = CREDIT_INGEST_RL)
- 404 on get_subdomain_name → role missing CREATE PIPE (see above)
- Connection refused / DNS → Snowflake account format wrong (use `<ORG>-<ACCOUNT>` not the locator)

### `HTTP 401 / error_code 390422` — "IP is not allowed to access Snowflake"

The HPA SDK auth failed because your account has a **network policy** that doesn't allow the VM's egress IP. Common in Snowflake corp accounts where `ACCOUNT_VPN_POLICY_*` is attached at the account level.

**Symptom in `docker logs credit-ingest`:**
```
HTTP 401, error_code=390422, message=Incoming request with IP/Token <your-vm-ip> is not allowed to access Snowflake.
```

**Fix:** create a per-user `NETWORK POLICY` allowing only the VM's egress IP and attach it to `CREDIT_INGEST_USR`. This overrides the account-level policy for this one service user.

```sql
-- Replace 1.2.3.4 with the IP from the error message
CREATE OR REPLACE NETWORK POLICY CREDIT_INGEST_NP
  ALLOWED_IP_LIST = ('1.2.3.4/32')
  COMMENT = 'Per-user override — allows GCP VM egress IP for HPA SDK';

ALTER USER CREDIT_INGEST_USR SET NETWORK_POLICY = CREDIT_INGEST_NP;
```

Restart the container (`docker restart credit-ingest`) and `channel_count` should climb to 4 within ~10 seconds.

`setup.sql` does NOT ship this network policy — most accounts have an open default policy and don't need it. If you created `CREDIT_INGEST_NP` manually, drop it manually when you're done (`DROP NETWORK POLICY IF EXISTS CREDIT_INGEST_NP;`) — the `--teardown` path only drops the SPCS app, not this policy.

### Cortex Agent answers feel slow on first ask (5-15s)

The README's "sub-second" claim refers to the **streaming-ingest** path (HPA SDK commit). The **Cortex Agent** path is a different workflow:

```
user prompt → orchestration LLM → tool selection (cortex_analyst_text_to_sql) →
  → text-to-SQL generation → CREDIT_DEMO_WH cold-start (if suspended) →
  → SQL execution against CREDIT_SV → response synthesis → SSE stream
```

End-to-end is typically **5-10s on a warm warehouse, 10-15s on cold**. This is the agent stack's normal behaviour, not a bug.

**Mitigations for live demos:**
- Pre-warm `CREDIT_DEMO_WH` 5 minutes before going live: run `SELECT 1` to wake it, set `AUTO_SUSPEND = 600` so it stays warm through the demo
- Ask one warm-up question off-camera before the demo (this also primes the agent's planning cache)
- The first SSE event (`response.status` "Planning the next steps") appears within ~1s; the streaming text-delta starts ~3-5s in. The React chat UI shows that progress so users don't see a blank screen

### Running a second account clobbers the first account's containers

Each `quickstart.sh` run is namespaced by connection (compose project `credit-<connection>`, container names `credit-<svc>-<connection>`, auto-picked host port). Clone the repo **once per account** and run `./quickstart.sh <connection>` in each clone — they coexist. Running two accounts from the *same* clone/dir will overwrite the shared `.env` and is not supported for concurrent demos.

### How do I remove a demo?

```bash
./quickstart.sh --down <connection>       # stop local producer + tunnel only (Snowflake untouched)
./quickstart.sh --teardown <connection>   # stop containers AND drop the SPCS app (keeps demo DB objects)
./deploy-app.sh --teardown                # drop just the app (uses this clone's .env connection)
```

The dashboard is a `snowflake-app` **application service** (`SNOWFLAKE_EXAMPLE.CREDIT_DEMO.CREDIT_DASHBOARD`), not a global `APPLICATION` — `SHOW APPLICATIONS` won't list it and `DROP APPLICATION` won't find it. `snow app teardown` (which `--teardown` runs against the *rendered* `snowflake.yml`) is the correct removal. For a full object drop, see the README "Teardown" section.

---

## What's tested vs not tested

| Path | Image pulls | Syntax | Resource graph | Live UI | Live ingest |
|---|---|---|---|---|---|
| A — Quick-tunnel (laptop, `quickstart.sh`) | ✅ | ✅ | ✅ | ✅ | ✅ verified end-to-end on **AWS (us-east-1, us-west-2), Azure, and GCP** — from a fresh clone, no hand-editing |
| B — Named tunnel | ✅ | ✅ | ✅ | ⏸ needs your token | ⏸ needs your token |
| C — Bootstrap script | n/a | ✅ | n/a | ⏸ needs Ubuntu VM | ⏸ |
| D — Terraform | ✅ | ✅ | ✅ `terraform plan` | ⏸ needs `terraform apply` | ⏸ |

Items marked ⏸ should be tested by the first SE who deploys this from a fresh clone. Path A is the `quickstart.sh` path and has been run repeatedly across all three clouds, including two demos side-by-side on one laptop (auto-namespaced compose project + container names + host port).
