# Migration Guide — Parent Fork → React Dashboard Fork

> **Note:** This document deliberately retains references to Streamlit because it describes the *migration from* the parent Streamlit fork to this React fork. For the current architecture of the React fork (no Streamlit anywhere), see [ASSUMPTIONS.md](ASSUMPTIONS.md). For the user-facing setup, see [README.md](README.md).

This document explains the exact diff between the parent fork (`sfguide-snowpipe-streaming-interactive-demo`) and this project (`sfguide-snowpipe-streaming-fast-react-dashboard`).

## What was removed

These files existed in the parent fork and are deleted here (they belong to the Streamlit-on-Snowflake deployment path):

| Removed file | Why |
|---|---|
| `app.py` | Streamlit UI — replaced by `web/src/app/page.tsx` |
| `queries.py` | Python query helpers — ported to `web/src/server/queries.ts` |
| `observability.py` | SiS observability helpers — replaced by OTLP in SPCS |
| `ingest.py` | SiS ingest helper — replaced by `web/src/app/api/ingest/route.ts` |
| `deploy.sh` | SiS deploy script — replaced by `deploy-app.sh` |
| `setup.sh` | Interactive .env writer — not needed (same .env format) |
| `teardown.sh` | SiS teardown — not needed (use `snow app teardown`) |
| `credit_service.yaml` | SiS service spec — replaced by `snowflake.yml` |
| `Dockerfile` | SiS container — replaced by `web/Dockerfile` |
| `layout.json` | Streamlit page config — not needed |
| `stages.json` | Streamlit stage config — not needed |
| `environment.yml` | Conda environment — not needed (Node.js, not Python) |
| `pyproject.toml` | Python project — not needed |
| `uv.lock` | Python lockfile — not needed |
| `RUN_DEMO.md` | SiS pre-flight checklist — replaced by TALK_TRACK.md pre-flight |
| `LEAVE_BEHIND.md` | Customer summary — not changed for this fork |

## What was added

| New file | Purpose |
|---|---|
| `snowflake.yml` | Snowflake App manifest for SPCS deployment |
| `deploy-app.sh` | Deploy script (config merge + `snow app run`) |
| `web/` | Entire Next.js 14 application (Lane A + Lane B) |
| `web/Dockerfile` | Multi-stage Node.js build for SPCS |
| `web/src/app/` | Next.js App Router pages + API routes |
| `web/src/server/` | Server-side Snowflake reader, WS broker, queries |
| `web/src/components/` | React dashboard components |
| `web/src/lib/` | Shared types + WebSocket client hook |
| `MIGRATION.md` | This file |

## What was extended (not replaced)

| File | Change |
|---|---|
| `setup.sql` | Appended §12-14: `DASHBOARD_POOL`, `DASHBOARD_VM_EAI`, `DASHBOARD_RL` |
| `README.md` | Complete rewrite for the React fork |
| `TALK_TRACK.md` | Rewritten to highlight the latency A/B comparison |

## What is unchanged (byte-identical to parent)

| File/directory | Why unchanged |
|---|---|
| `vm-ingest/` (entire directory) | Producer is the same — this fork only changes the UI |
| `semantic_view.sql` | Shared Cortex Analyst semantic view |
| `LICENSE` | Same Apache-2.0 |
| `ASSUMPTIONS.md` | Architecture decisions still apply |
| `TESTING.md` | Extended with React test notes but base content preserved |
| `TROUBLESHOOTING.md` | VM/tunnel troubleshooting still applies |
| `.env.example` | Same env vars needed |

## Running side-by-side (latency A/B recording)

Both forks can run simultaneously against the same Snowflake account:

1. **Parent fork** uses: `CREDIT_POOL`, `CREDIT_INGEST_EAI`, Streamlit on Snowflake
2. **This fork** uses: `DASHBOARD_POOL`, `DASHBOARD_VM_EAI`, Next.js on SPCS

They share: `CREDIT_DEMO` schema, `RAW_EVENTS`, `POSITIONS_DIM`, `CREDIT_DEMO_INT_WH`, `CREDIT_AGENT`, `CREDIT_SV`, `POSITIONS_SEARCH`.

> **Divergence note:** this fork converts `RAW_EVENTS` into an **Interactive Table** (Snowpipe Streaming writes directly into it) and drops the `PORTFOLIO_LIVE` rollup table + `PORTFOLIO_LIVE_VIEW`. The parent Streamlit fork expects a *standard* `RAW_EVENTS` plus `PORTFOLIO_LIVE`, so the two are no longer a clean drop-in share on the same objects — run the parent against its own schema if you need a true side-by-side.

### Steps for A/B recording

1. Ensure both are deployed:
   - Parent: `./deploy.sh` (Streamlit)
   - This fork: `./deploy-app.sh` (Next.js)

2. Open both in adjacent browser tabs:
   - Tab 1: Streamlit URL (from parent's deploy output)
   - Tab 2: SPCS app URL (from `snow app open`)

3. Start a screen recording.

4. Click "New Trade" in the **React tab** — observe <100ms tile update.

5. Click "New Trade" in the **Streamlit tab** — observe 3-5s full-page rerun.

6. Both events land in the same `RAW_EVENTS` table and both dashboards show them — the difference is purely how fast each framework reflects the change.

## How to migrate back

If you want to return to Streamlit-only:
- `snow app teardown` removes the SPCS app
- `DROP COMPUTE POOL IF EXISTS DASHBOARD_POOL`
- `DROP ROLE IF EXISTS DASHBOARD_RL`
- `DROP INTEGRATION IF EXISTS DASHBOARD_VM_EAI`
- The parent fork's `CREDIT_*` objects are unaffected.
