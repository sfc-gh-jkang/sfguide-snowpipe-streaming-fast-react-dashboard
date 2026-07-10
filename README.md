# Real-Time Credit Desk on Snowflake — Sub-Second React Dashboard

**Owner**: john.kang@snowflake.com (sfc-gh-jkang)

> **Feature status:** Snowpipe Streaming HPA, Interactive Tables, Cortex Agent, Cortex Search Service, Cortex Analyst (Semantic Views), and SPCS Snowflake Apps are all GA as of May 2026. No Preview features required to run this demo.

A real-time credit-trading dashboard. Operators on a credit desk fire trades, marks, and credit events; rows commit to Snowflake via Snowpipe Streaming HPA in ~0.3 s (`wait_for_flush()`) and become queryable on the interactive warehouse ~1.3 s after commit (streaming-visibility lag, p50; varies ~0.7–2.4 s); the dashboard shows the trade tape, P&L, sector exposure, top marks, watchlist, and a Cortex Agent chat that answers questions about the position book.

> Snowpipe Streaming **HPA** + **Interactive Tables** + **Cortex Agent** + **Next.js on SPCS** — same data pipeline as the parent fork. The just-fired row **paints optimistically in ~10 ms** (instant perceived feedback) instead of blocking on Streamlit's ~1.6 s full-script rerun. The honest **click → interactive-table-confirmed** time is **~1.5–2 s** (p50), dominated by the interactive table's **~1.3 s streaming-visibility lag** (p50; varies ~0.7–2.4 s) — the time a just-committed streamed row takes to become queryable on the interactive warehouse. That lag is the price of a durable write-through (not an in-memory cache), and the parent Streamlit demo pays the same lag. All fork numbers are measured live in-browser (Streamlit figures are a historical baseline from the parent demo — see provenance note below).

This is a performance fork of the parent demo `sfguide-snowpipe-streaming-interactive-demo` (Streamlit-on-Snowflake). The VM producer, the HPA SDK ingest path, the Interactive Tables, and the Cortex Agent spec are unchanged. The presentation layer is what's different: Streamlit on Snowflake is replaced by a Next.js 14 React app on SPCS, served behind Snowsight's OAuth gate. Tile updates run on a 200 ms server-side polling loop with WebSocket diff-push to the browser; full-snapshot fetches run client-side every 1.5 s as a periodic truth source.

## Why we built this

A typical real-time credit-desk pipeline is built from four separate vendors stitched together. This demo collapses all four into one Snowflake account.

| Capability | Traditional stack | What it costs you |
|---|---|---|
| Streaming ingest from desk apps | Kafka + Connect + schema registry | Cluster ops, broker tuning, consumer-lag dashboards, separate billing |
| Hot serving cache for sub-second tile reads | Redis or Memcached | Second source of truth, cache-invalidation bugs, separate auth/RBAC |
| Real-time stream processing (windows, joins, aggregations) | Flink, Spark Streaming, or Materialize | JVM tuning, watermark semantics, state-store recovery, runtime team |
| Conversational analytics over the same data | Looker / Tableau + a separate text-to-SQL bot | BI license fees, semantic-model drift, third-party LLM contract |

**The thesis: all four are now collapsed into one Snowflake account.** No Kafka. No Redis. No Flink. No external BI tier. The only thing outside Snowflake is the producer VM — and only because the HPA SDK's keypair-JWT auth currently has to originate outside SPCS.

What you see when you run this demo:

1. Click TRADE in the React dashboard → row paints optimistically in ~10 ms; commits via Snowpipe Streaming HPA in ~0.3 s (`wait_for_flush()`); becomes queryable on the interactive WH ~1.3 s after commit (streaming visibility, p50; varies ~0.7–2.4 s)
2. Server-side reader polls the Interactive Warehouse every 200 ms → diffs against last hash → pushes only changed rows over WebSocket → tiles repaint in <16 ms
3. Switch to "Ask the Book" tab → ask "What was our most recent trade?" → Cortex Agent calls Cortex Analyst (semantic view) + Cortex Search → streams answer back in 5-10 s
4. Open the "How fresh & fast?" tab → hit **Fire & measure** → every freshness/latency/lag component is explained in plain English, shown with live measured values, and reconciled so the parts add up to the end-to-end

## Screenshots

**Live Credit Desk** (`/`) — real-time trade tape, KPI tiles, P&L, sector exposure, top marks, watchlist, and the latency timeline; fire TRADE/MARK/CREDIT and watch rows commit via Snowpipe Streaming HPA:

![Live Credit Desk](docs/screenshot-desk.png)

**Demo control room** (`/demo`) — Fresh vs Fast cards, the Live Market simulator, the interactive-latency widget, and the three-way serving-strategy comparison with a totals-match check:

![Demo control room](docs/screenshot-demo.png)

**How fresh & fast?** (`/latency`) — plain-English breakdown of every freshness/latency/lag component, live measured values per step, and the per-event "do the parts add up?" reconciliation:

![How fresh and fast explainer](docs/screenshot-latency.png)

**Ask the Book** (`/ask`) — Cortex Agent chat (Cortex Analyst semantic view + Cortex Search) answering questions about the live position book, streamed token-by-token over SSE:

![Ask the Book](docs/screenshot-ask.png)

<details>
<summary>More views (click to expand)</summary>

**End-to-end: click → fresh dashboard** — the swim-lane breakdown with every layer populated (click pipeline, IT visibility, WebSocket push, render) next to the Streamlit baseline:

![End-to-end swim lanes](docs/screenshot-endtoend.png)

**Serving strategy comparison** — the same book served three ways on the Interactive Warehouse (query-time window rollup / pre-agg write-through / MAX_BY), live read latencies, `totals match ✓`, and the freshness breakdown:

![Serving strategy comparison](docs/screenshot-serving.png)

**Latency timeline + Event Generator** — per-click stacked segments (network / SDK / flush / VM / render / IT poll), the TRADE/MARK/CREDIT fire buttons, and the live event tape:

![Latency timeline and event generator](docs/screenshot-timeline.png)

**Do the parts add up?** — the per-step component table (typical / median / last) and the single-event reconciliation where the disjoint parts sum exactly to the measured end-to-end:

![Latency component reconciliation](docs/screenshot-reconcile.png)

</details>

## Why this fork exists

The latency table below mixes three number sources — live in-browser measurements, a 2026-07-07 re-benchmark of this fork's serving queries on the current architecture, and a historical Streamlit baseline. Each row is labeled, and the **Number provenance** note under the table spells out exactly what is measured live vs stored (see also `web/src/lib/baseline.ts`):

| Segment | Parent (Streamlit) | This fork (React) |
|---|---|---|
| HPA `wait_for_flush()` commit | ~30ms | **~0.3s** (dual-table max: RAW_EVENTS + POSITION_BOOK concurrent; single-table best-case ~30ms) |
| Serving-query server-side time on **Interactive WH** | 60ms p50 / 95ms p95 *(historical: old single-row lookup, parent demo, 2026-05-19)* | **130ms p50 / 151ms p95** (n=30, book rollup, re-benchmarked 2026-07-07) |
| Same serving query on **Standard WH** (the in-app A/B toggle) | — | **295ms p50 / 872ms p95** (n=30) → Interactive ~2.3× faster p50, ~5.8× faster p95 |
| Streamlit full-script rerun | **1646ms p50 / 3391ms p95** *(historical, n=88 bursts, parent demo, 2026-05-19)* | n/a |
| **Click → optimistic paint** (grey pending row) | ~1646ms (rerun must finish first) | **~10ms** (immediate client prepend, measured live) → feels instant |
| Click → committed (HPA flush-ack) | — | **~0.4s** (network + SDK append + flush) |
| Commit → queryable on interactive WH (streaming-visibility lag) | ~1.3s p50 (parent pays the same lag) | **~1.3s p50, ~0.7–2.4s** (measured live — the dominant, variable end-to-end term) |
| **Click → interactive-table-confirmed on screen** | ~1646ms rerun + the same ~1.3s visibility | **~1.5–2s p50** (network + SPCS↔VM tunnel + flush + ~1.3s visibility + render, measured live) |
| React render/paint step (one row) | (part of the 1646ms rerun) | **~10ms** (RAF×2, measured live in-browser) — a render step, *not* a 1:1 comparison against a full rerun |
| Click → tape-row-visible (tape refresh) | ~1646ms (rerun completes, all rows redrawn) | ~2400ms (1.5s polling + ~800ms fetch + ~50ms reconcile) |
| Cortex Agent Q&A | 5-15s | 5-15s (unchanged) |

**Number provenance (important — don't conflate these):**
- **Live-measured, this fork, this session:** click→paint, network round-trip, HPA flush, IT-poll, WebSocket wire-delivery, render. These are timed in your browser on every click and shown labeled `MEASURED n=…` in the in-app Latency panel.
- **Re-benchmarked 2026-07-07 on the live `aws_spcs` account (current interactive-`RAW_EVENTS` architecture):** the Interactive-vs-Standard warehouse rows above (book-rollup serving query, 30× per WH, server-side `TOTAL_ELAPSED_TIME` via `QUERY_HISTORY_BY_SESSION`). Constants live in `web/src/lib/baseline.ts` → `REACT_FORK_SERVING_MS`.
- **Historical stored baseline (NOT re-measured live):** all Streamlit figures (`1646/3391ms` rerun; `60/95ms` and `98/241ms` per-WH profiles) were measured 2026-05-19 on the parent Streamlit-on-Snowflake demo, on a **different account** and the **old architecture**. The parent demo is not deployed on this account (a 30-day `QUERY_HISTORY` scan for `STPLATSTREAMLIT*` returned zero rows), so they cannot be refreshed here. They're an illustrative comparison, clearly labeled as such in the app.

**Honest read:** the React fork's genuine UX win is that the just-fired row **paints optimistically in ~10 ms** (instant perceived feedback) while Streamlit blocks the whole UI on a ~1.6 s full-script rerun per interaction. But do **not** confuse the optimistic paint with the row actually being queryable: the honest **click → interactive-table-confirmed** time is **~1.5–2 s** (p50), dominated by the interactive table's **~1.3 s streaming-visibility lag** (p50; varies ~0.7–2.4 s) (a just-committed streamed row takes ~1.3 s p50 to become queryable on the interactive WH). That lag is inherent to the durable write-through path and the parent Streamlit demo pays it too — React just hides it behind the optimistic paint instead of blocking. React also stays fresh between clicks (1.5 s polling) while Streamlit goes stale until the next rerun. On the interactive-vs-standard warehouse comparison, the Interactive WH is ~2.3× faster at p50 and ~5.8× faster at p95 for the identical serving query — measured fresh on the current architecture.

## Target latency budget

| Segment | Target | How |
|---|---|---|
| React render/paint step (after POST returns) | <50ms | React state diff + RAF×2 paint of the optimistic row |
| Click → optimistic paint (grey pending row) | ~10ms | Immediate client-side prepend, before the network |
| Click → committed (HPA flush-ack) | ~0.4s | Click pipeline (net + SDK + flush) |
| Click → row queryable on interactive WH | ~1.5–2s p50 | Commit + interactive-table streaming-visibility lag (~1.3s p50, ~0.7–2.4s) |
| Click → row visible in tape (polling cadence) | ~2400ms | Server-side 1.5s polling, full snapshot fetch, Zustand reconcile |
| React tile re-render (memo'd diff) | <16ms | `React.memo` per slice, no full-page rerun |

**React render/paint step p50: <50 ms (typical 8-15 ms measured live). Click → optimistic paint ≈ ~10 ms; click → interactive-table-confirmed ≈ ~1.5–2 s (dominated by the ~1.3 s streaming-visibility lag, which varies ~0.7–2.4 s).**

## Three serving strategies (all fresh — no refresh lag)

The dashboard serves the position-book P&L rollup **three different ways** on the Interactive Warehouse, shown live and side-by-side in the app's **Serving strategy comparison** panel. All three read interactive tables, all three return the identical book (the panel proves it with a "totals match ✓" check), and all three are **equally fresh** — there is no `TARGET_LAG` dynamic table anywhere, so a just-fired trade becomes queryable in every strategy within the same ~1–2 s streaming-visibility window (not on a refresh schedule). Once a row is queryable, the read itself is the p50/p95 below (19-130 ms).

**The live dashboard tiles default to strategy #2 — the pre-agg write-through read of `POSITION_BOOK`** (a single indexed scan of pre-computed rows, the "Redis GET" analog, ~19 ms p50). The query-time rollups (#1, #3) exist in the comparison panel to prove all three return identical totals; they are not the default serving path. This is the honest answer to "Interactive Tables replace Redis": the *default* read is a pre-computed row lookup, not an ad-hoc aggregation.

| # | Strategy | Reads | How | p50 | p95 |
|---|---|---|---|---|---|
| 2 | **Pre-agg write-through** | `POSITION_BOOK` | Producer maintains a running per-position book in memory and streams the pre-computed book line into a second interactive table on every event (parallel HPA channel). Read = latest row per position. | **19 ms** | 69 ms |
| 3 | **Optimized query-time** | `RAW_EVENTS` | Single `GROUP BY POSITION_ID` + `MAX_BY(...)` rollup — no window functions, no self-joins. | 43 ms | 53 ms |
| 1 | **Query-time window rollup** | `RAW_EVENTS` | `QUALIFY ROW_NUMBER()` window rollup (the freshest-from-raw path; shown for comparison, was the old default). | 88 ms | 108 ms |

*(n=30 each, server-side `TOTAL_ELAPSED_TIME` via `QUERY_HISTORY_BY_SESSION` on `CREDIT_DEMO_INT_WH` XSMALL, re-benchmarked 2026-07-08. Session-scoped so the live 200 ms reader poll is excluded. These are **warehouse-execution** times; the in-app number is larger because it's the full round-trip incl. the SPCS→Snowflake REST call + network.)*

**Latency ≠ freshness — don't conflate them.** The p50s above are **read latency** (how long a query takes). **Freshness** is separate: event → visible end-to-end, and the app shows it as **two stages × two anchors**. Stages: event→**queryable** (readable by any query = SDK append + HPA `wait_for_flush` commit + interactive-table streaming visibility, ~1.3 s p50 / ~0.7–2.4 s, visibility-dominated) and event→**visualized** (+ browser paint on the WebSocket push, or up to the ~1.5 s poll). Anchors: **pipeline** (from when the event is produced — classic data freshness) and **user** (from your click — adds the browser→VM network hop, i.e. what the person at the screen feels). The two anchors differ by exactly that network hop. Crucially there is **no `TARGET_LAG` refresh cycle** anywhere ([a dynamic table's minimum staleness target is 60 s](https://docs.snowflake.com/en/user-guide/dynamic-tables/target-lag)), and **all three strategies share the same freshness** because they read data committed by the same streaming path — the pre-agg path buys read *speed*, not freshness. The app's "How this works" pop-down defines latency vs. lag vs. freshness with doc links.

**The streaming-visibility lag — mechanism (measured + doc-grounded, 2026-07-08).** A just-committed streamed row is not queryable on the interactive warehouse instantly; the new micropartition must be **incorporated into the warehouse's warm served state** first ([Snowflake docs: interactive tables and interactive warehouses](https://docs.snowflake.com/en/user-guide/interactive) — cache-warming priority explicitly includes *"newly added micropartitions through … data ingestion"*). Burst experiments (staggered commits → shared visible instants) show this incorporation happens in **irregular batches**, observed cadence **~0.35–1.3 s**, so a row becomes queryable at the next batch after its commit. That's why commit→queryable is **variable: p50 ~1.3 s, range ~0.7–2.4 s** (n=32), not a constant. It is **not** the `TARGET_LAG` refresh (min 60 s) — that knob only applies to interactive tables that auto-refresh *from a source table*; `RAW_EVENTS`/`POSITION_BOOK` are **direct Snowpipe Streaming targets**, so the batch cadence is internal to Snowflake and **not user-tunable**. The only lever we hold is keeping the interactive WH warm (`AUTO_SUSPEND = 86400`). The optimistic paint (~10 ms) hides this lag from the user; it does not remove it, and the parent Streamlit demo pays the same lag.

**Why this answers "Interactive Tables replace Redis":** the pre-agg write-through (#2) is the true Redis analogy — the *writer* maintains the hot cache, so reads are a cheap scan of pre-computed rows (**~4.6× faster than the query-time window rollup at p50**). Crucially it stays that fast *without* sacrificing freshness: a `TARGET_LAG` dynamic table would pre-aggregate too, but would add ingestion→refresh staleness. Write-through keeps the pre-agg **and** the zero-lag freshness this demo is about. Strategies #1 and #3 show that even pure query-time aggregation on a streaming interactive table is sub-100 ms on a warm interactive warehouse.

## What this demo proves

A 10-second scan of which Snowflake products this demo exercises and what each one buys you.

| # | Snowflake product | What it does here | Why it matters |
|---|---|---|---|
| 1 | **Snowpipe Streaming HPA** (High-Performance Architecture) | Channel-API ingest from a Python SDK directly into `RAW_EVENTS` (an Interactive Table) via the auto-PIPE `RAW_EVENTS-STREAMING`. ~0.3 s commit latency on `wait_for_flush()` (dual-table max). No landing table, no COPY INTO. | One ingest path for both micro-batch and per-row streaming; no Kafka, no Connect, no schema registry |
| 2 | **Interactive Tables** | Two interactive tables, both streaming targets: `RAW_EVENTS` (every event, served by query-time rollup) and `POSITION_BOOK` (the producer write-throughs the pre-computed per-position book line on every event). The dashboard serves the book **three ways** off these — see "Three serving strategies" below. Both clustered for sub-second concurrent reads. | Replaces a Redis cache the fresh way: the *writer* maintains the hot pre-agg cache (`POSITION_BOOK`), so reads are pre-computed AND zero-staleness — no `TARGET_LAG` refresh |
| 3 | **Interactive Warehouses** | `CREDIT_DEMO_INT_WH` stays warm to serve the 200 ms server-side polling reader against `RAW_EVENTS`. | No JVM, no watermarks, no state-store recovery — just a warehouse that doesn't suspend |
| 4 | **SPCS Snowflake App** | Hosts the Next.js 14 dashboard on a `CPU_X64_XS` compute pool. OAuth via `/snowflake/session/token`. | Bring-your-own-runtime UI, deployed with `snow app deploy`, no separate infra to operate |
| 5 | **Cortex Agent** | `CREDIT_AGENT` orchestrates Cortex Analyst + Cortex Search to answer NL questions about the book. | Replaces a third-party text-to-SQL bot + BI semantic-model tier with one Snowflake-native object |
| 6 | **Cortex Analyst (Semantic Views)** | `CREDIT_SV` defines tables, dimensions, measures, and metrics that the agent's analyst tool turns into SQL. | One semantic model owned alongside the data; no Looker LookML drift |
| 7 | **Cortex Search Service** | `POSITIONS_SEARCH` indexes `POSITIONS_DIM` for fuzzy issuer/sector lookup ("show me Apollo's exposure"). | Built-in vector search; no Pinecone or external embedding pipeline |
| 8 | **External Access Integration** | `DASHBOARD_VM_EAI` lets the SPCS app POST to the cloudflared tunnel and lets the Buildpacks builder reach `npmjs.org`. | One auth/audit boundary for outbound network traffic from inside Snowflake |

## Architecture

![Architecture overview](docs/architecture.png)

### ASCII view

```
                            USER BROWSER
                                 │
                                 ▼ (HTTPS via Snowsight OAuth gate)
   ╔══════════════════════════════════════════════════════════════════╗
   ║  NEXT.JS 14 ON SPCS  (custom server.js with WS upgrade)        ║
   ║   • Live Credit Desk tab (WS push)   • Ask the Book tab (Agent SSE) ║
   ╚══════════════════════════════════════════════════════════════════╝
        │ POST /api/ingest                         │ POST /api/agent/stream
        │ (via External Access Integration)        │ (Cortex Agent OAuth)
        ▼                                          ▼
   [ Cloudflare Tunnel ]                    ┌────────────────────┐
        │                                   │  CREDIT_AGENT      │
        ▼                                   │  ├─ analyst tool   │
   [ Producer VM (any cloud)        ]       │  └─ search tool    │
   [   FastAPI + 4-channel HPA SDK  ]       └─────────┬──────────┘
        │ wait_for_flush                              │
        │ keypair JWT, ~0.3s commit                   │ text-to-SQL
        ▼                                             ▼
   ┌─────────────────────────────────┐      ┌────────────────────┐
   │ Snowpipe Streaming HPA Auto-PIPE│      │  CREDIT_SV         │
   │ (channel API → RAW_EVENTS)      │      │  Semantic View     │
   │                                 │      │  + POSITIONS_SEARCH│
   │                                 │      │  Cortex Search     │
   ┌──────────────────────────────────────┐ └─────────┬──────────┘
   │ RAW_EVENTS   (Interactive Table)     │           │
   │   ← direct streaming target + serving│           │
   │ POSITIONS_DIM (62 loan positions,    │ ◄─────────┘
   │   standard dim; attrs denormalized   │
   │   onto each event)                   │
   └────────────────┬─────────────────────┘
                    │
        ┌───────────┴────────────┐
        │                        │
        ▼ 200ms server poll      ▼ 1.5s client snapshot poll
   ┌─────────────────────┐  ┌──────────────────────────────┐
   │ snowflake-reader    │  │ /api/snapshot/standard       │
   │ → hash → diff       │  │ → full positions/PnL/sector  │
   │ → WS push to all    │  │ → Zustand reconcile          │
   │   connected clients │  └──────────────────────────────┘
   └─────────────────────┘
```

Two concurrent paths into the browser:

- **WebSocket diff-push (200 ms cadence)** — `web/src/server/snowflake-reader.ts` polls the Interactive Warehouse, hashes the result, and pushes only changed rows over the WebSocket attached to `web/server.js`. Drives the live tape and tile flashes.
- **REST snapshot fetch (1.5 s cadence)** — the browser hits `/api/snapshot/standard` (or `/api/snapshot/at` for the Interactive WH variant), gets the full positions/PnL/sector/lag/topmarks rollup back, and merges it into Zustand. This is the periodic truth source that recovers from dropped WS messages, reconnections, and tab-switch rehydration.

### Mermaid view

```mermaid
flowchart TB
    Browser["User Browser"]
    UI["Next.js 14 on SPCS<br/>(custom server.js + WS upgrade)"]
    WSB["WS Broker<br/>web/src/server/ws-broker.ts"]
    READER["snowflake-reader<br/>200ms poll + diff"]
    EAI["External Access<br/>Integration"]
    CF["Cloudflare Tunnel"]
    VM["Producer VM<br/>FastAPI + 4-ch HPA SDK"]
    PIPE["Snowpipe Streaming HPA<br/>Auto-PIPE RAW_EVENTS-STREAMING"]
    BPIPE["Auto-PIPE<br/>POSITION_BOOK-STREAMING<br/>(parallel channel)"]
    RAW[("RAW_EVENTS<br/>Interactive Table<br/>(strategies 1 + 3: query-time rollup)")]
    BOOK[("POSITION_BOOK<br/>Interactive Table<br/>(strategy 2: pre-agg write-through)")]
    POS[("POSITIONS_DIM<br/>62 loan positions<br/>(standard dim)")]
    INTWH["Interactive Warehouse<br/>(stays warm)"]
    AGENT["CREDIT_AGENT<br/>(orchestrator)"]
    SV["CREDIT_SV<br/>Semantic View"]
    SEARCH["POSITIONS_SEARCH<br/>Cortex Search Service"]

    Browser ==>|WebSocket + HTTPS| UI

    %% Click loop (optimistic + verified)
    UI -->|POST /api/ingest| EAI
    EAI -->|allowed-host rule| CF
    CF -->|QUIC outbound| VM
    VM -->|wait_for_flush ~0.3s| PIPE
    PIPE --> RAW
    VM -->|parallel write-through| BPIPE
    BPIPE --> BOOK

    %% Server-side reader → WS push (200ms diff)
    READER -.->|200ms poll| INTWH
    INTWH -.-> RAW
    INTWH -.->|strategy 2 pre-agg| BOOK
    READER -.->|hash + diff| WSB
    WSB -.->|WS push| Browser

    %% Client-side snapshot fetch (1.5s truth source)
    Browser -.->|GET /api/snapshot/standard every 1.5s| UI
    UI -.->|SQL REST API| INTWH

    %% Cortex Agent path
    UI -->|SSE /api/agent/stream| AGENT
    AGENT -->|text-to-SQL| SV
    AGENT -->|fuzzy issuer match| SEARCH
    SV --> RAW
    SV --> POS
    SEARCH --> POS

    classDef snow fill:#29B5E8,stroke:#0070A8,color:#fff,stroke-width:2px
    classDef ext  fill:#F39C12,stroke:#B8740F,color:#fff,stroke-width:2px
    classDef ai   fill:#9B59B6,stroke:#6E3D81,color:#fff,stroke-width:2px
    classDef user fill:#34495E,stroke:#1A2530,color:#fff
    class UI,WSB,READER,EAI,PIPE,BPIPE,RAW,BOOK,POS,INTWH snow
    class CF,VM ext
    class AGENT,SV,SEARCH ai
    class Browser user
```

**Key difference from parent:** The browser maintains a persistent WebSocket to the SPCS app (via `web/server.js`'s upgrade handler). The server-side reader polls the Interactive Warehouse at 200 ms cadence, hashes results, and pushes only diffs. `React.memo` prevents off-slice re-renders. Tiles update in <16 ms from WS message arrival.

## Quickstart

### Choose where the producer runs

The only piece outside Snowflake is the small event **producer** (Python + Snowpipe Streaming HPA SDK). Run it either way — the Snowflake objects, dashboard, and deploy steps are **identical**:

| Option | Producer host | Tunnel | Best for |
|---|---|---|---|
| **A — Local** | Your laptop (Docker) | Cloudflare quick tunnel (ephemeral URL) | Fastest path, personal demos, **no cloud account / no GCP** |
| **B — VM** | Any cloud VM (AWS / Azure / GCP) or on-prem | Named Cloudflare tunnel (stable URL) | Shared or long-lived demos, stable hostname |

Both require `snow` CLI 3.0+ with an ACCOUNTADMIN connection. Option A also needs Docker + `openssl` + `python3` on your laptop.

### Option A — Local (one command)

```bash
./quickstart.sh <your-snow-connection>
```

Runs the producer + a local Cloudflare quick tunnel in Docker (no cloud, no GCP, no public IP). It writes `.env`, auto-detects your account, generates the ingest keypair, provisions all Snowflake objects, creates the `CREDIT_INGEST_USR` service user, captures the ephemeral tunnel URL, and deploys the dashboard. Idempotent and re-runnable. Stop the local producer/tunnel with `./quickstart.sh --down`. Then `snow app open --connection <your-snow-connection>`.

**Keeping the quick tunnel alive.** The `*.trycloudflare.com` URL is ephemeral and rotates whenever the tunnel container restarts. Leave the self-healer running so the demo never breaks:

```bash
./quickstart.sh --watch <your-snow-connection> &   # re-pushes the URL to Snowflake on change; app self-heals in ~60s
```

**Want a URL that never changes?** Set `CLOUDFLARE_TUNNEL_TOKEN` (from the free Cloudflare Zero Trust dashboard) and `INGEST_TUNNEL_HOST` (the hostname you route to the tunnel) in `.env`, then re-run `./quickstart.sh`. It auto-detects the token and uses a **named tunnel** with a stable hostname — no `--watch` needed. See [VM ingest setup](#vm-ingest-setup), Path B.

<details>
<summary>What the one command does, step by step (or to run it manually)</summary>

```bash
cp .env.example .env                # fill SNOWFLAKE_CONNECTION + SNOWFLAKE_ACCOUNT
./deploy-app.sh --infra-only        # provision Snowflake objects (DB/schema/WHs/IT/role/EAI/agent)
# create the ingest service user (paste your public key):
#   openssl genrsa 2048 | openssl pkcs8 -topk8 -inform PEM -out vm-ingest/keys/credit_ingest.p8 -nocrypt
#   openssl rsa -in vm-ingest/keys/credit_ingest.p8 -pubout -out vm-ingest/keys/credit_ingest.pub
#   snow sql -c <conn> -q "CREATE USER IF NOT EXISTS CREDIT_INGEST_USR TYPE=SERVICE RSA_PUBLIC_KEY='<pubkey>' DEFAULT_WAREHOUSE=CREDIT_DEMO_WH DEFAULT_ROLE=CREDIT_INGEST_RL; GRANT ROLE CREDIT_INGEST_RL TO USER CREDIT_INGEST_USR;"
cd vm-ingest && cp .env.example .env && docker compose --profile quick up -d --build
docker compose --profile quick logs cloudflared-quick | grep trycloudflare   # paste host into top-level .env INGEST_TUNNEL_HOST
cd .. && ./deploy-app.sh            # push tunnel config + deploy the app
```
</details>

**Running more than one account at once.** `quickstart.sh` namespaces each instance by its connection name — distinct compose project (`credit-<connection>`), container names (`credit-ingest-<connection>`, …), and an auto-picked free host port. Clone the repo once per account and run `./quickstart.sh <connection>` in each; the two demos coexist on one laptop with no hand-editing and never clobber each other's containers. Use `./quickstart.sh --down <connection>` to stop a specific one.

### Option B — VM (cloud or on-prem)

Use a VM when you want a **stable hostname** and a long-lived demo. It runs on **any** cloud (AWS EC2, Azure VM, GCP Compute Engine) or on-prem — GCP is not special. The Snowflake side is the same `deploy-app.sh` flow; only the producer host + tunnel differ:

```bash
cp .env.example .env                # fill SNOWFLAKE_CONNECTION + SNOWFLAKE_ACCOUNT
./deploy-app.sh --infra-only        # provision Snowflake objects
# create CREDIT_INGEST_USR with your keypair (same snippet as Option A above)
# on the VM: copy vm-ingest/ + the keypair, set vm-ingest/.env, and start the producer
#            behind a NAMED Cloudflare tunnel (stable URL) — see "VM ingest setup" below (Paths B/C/D)
# put the stable tunnel host into the top-level .env, then:
./deploy-app.sh                     # push tunnel config + deploy the app
```

See [VM ingest setup](#vm-ingest-setup) for the tunnel patterns (named tunnel, host-installed cloudflared, or Terraform).

### 0. Prerequisites

- A Snowflake account where you have `ACCOUNTADMIN` (the bootstrap creates databases, roles, compute pools, EAIs)
- `snow` CLI 3.0+ with a connection profile pointed at that account (`snow connection list`)
- A host to run the small producer service + cloudflared tunnel — **your laptop works** (the quick tunnel gives it a public URL over an outbound connection, so no public IP, no cloud VM, and no GCP required). Any cloud VM works too. See [VM ingest setup](#vm-ingest-setup) below
- A populated `.env` (copy from `.env.example`) — **`quickstart.sh` fills these for you**; only needed if you run the steps manually:
  - `SNOWFLAKE_CONNECTION` — name of your `snow` profile (the only value you must supply)
  - `SNOWFLAKE_ACCOUNT` — account locator (e.g. `MYORG-MY_ACCOUNT`); quickstart auto-detects it from the connection
  - `INGEST_TUNNEL_HOST` — tunnel hostname (`*.trycloudflare.com` or your named host); quickstart captures it from the quick tunnel
  - `INGEST_API_KEY` — shared secret the dashboard sends with every `/ingest` POST; quickstart generates a random one

The other 15 identifiers in `.env.example` (database, schema, warehouse, role, pool, EAI, table names) all have working defaults — only override if you need to coexist with another deployment in the same account.

### 1. Provision Snowflake objects + deploy the dashboard (one command)

```bash
./deploy-app.sh --bootstrap
```

This is idempotent and does everything end-to-end:

1. Renders `setup.sql`, `semantic_view.sql`, and `web/snowflake.yml` from your `.env`
2. Runs `setup.sql` — creates database, schema, warehouses (standard + Interactive), roles (`DASHBOARD_RL`, `CREDIT_INGEST_RL`), compute pool, network rules, External Access Integration, the `RAW_EVENTS` + `POSITION_BOOK` Interactive Tables (both streaming targets) + `POSITIONS_DIM`, Cortex Search service, Cortex Agent, `APP_CONFIG` runtime table, and all grants
3. Runs `semantic_view.sql` — creates the `CREDIT_SV` semantic view used by the agent for text-to-SQL
4. Pushes `INGEST_TUNNEL_HOST` + `INGEST_API_KEY` into `APP_CONFIG`
5. Updates the EAI network rule to allow egress to your tunnel host
6. `snow app deploy` — builds the Next.js standalone bundle inside SPCS and starts the service

The script ends by printing the live app URL. See [What gets created in your account](#what-gets-created-in-your-account) for the full inventory.

### 2. Generate keypair for the VM ingest user (one-time)

The VM connects to Snowflake with keypair JWT (not the SPCS OAuth path the dashboard uses). The bootstrap creates the `INGEST_ROLE` and grants but **leaves the actual `CREDIT_INGEST_USR` commented out** in `setup.sql` so you can paste the public key when you create it.

Run on the VM:

```bash
# Generate a 2048-bit RSA keypair
openssl genrsa 2048 | openssl pkcs8 -topk8 -inform PEM -out rsa_key.p8 -nocrypt
openssl rsa -in rsa_key.p8 -pubout -out rsa_key.pub

# Strip header/footer/newlines for the SQL CREATE USER
PUBKEY=$(awk 'NR>1 && !/-----END/ {printf "%s", $0}' rsa_key.pub)
echo "$PUBKEY"
```

Then in Snowflake (replace `<PUBKEY>` with the string from the previous step, and `${INGEST_ROLE}` with the value from your `.env`):

```sql
CREATE USER IF NOT EXISTS CREDIT_INGEST_USR
  TYPE = SERVICE
  RSA_PUBLIC_KEY = '<PUBKEY>'
  COMMENT = 'Snowpipe Streaming producer service account';
GRANT ROLE CREDIT_INGEST_RL TO USER CREDIT_INGEST_USR;
```

Place `rsa_key.p8` on the VM and point the worker's `SNOWFLAKE_PRIVATE_KEY_PATH` env var at it. See `vm-ingest/README.md` for the worker-side details.

### 3. Open the dashboard

`./deploy-app.sh` ends with `App ready at https://<id>-<account>.snowflakecomputing.app`. Open that URL, or run:

```bash
snow app open --connection "$SNOWFLAKE_CONNECTION"
```

The dashboard is served behind Snowsight's OAuth gate — Snowflake users in your account can hit the URL directly, no separate auth wiring needed.

### 4. Verify it's working

```bash
# 1. App health (should return {"ok":true,...} after warmup)
curl https://<your-app-host>/api/health

# 2. Tail the SPCS event log for errors
snow app events --connection "$SNOWFLAKE_CONNECTION" | tail -20

# 3. From the dashboard, click TRADE — the "click → tile paint" should be <50 ms
#    and the row should land in RAW_EVENTS within 500 ms cold / 100 ms warm.
```

If you see HTTP 502 with `{"error":"Ingest failed: INGEST_TUNNEL_HOST not configured"}`, the EAI network rule didn't pick up your tunnel host. Re-run `./deploy-app.sh` (no `--bootstrap` needed) — it re-pushes `APP_CONFIG` and re-applies the network rule.

### 5. Iterate

For code-only changes (React, API routes, server.js, etc.):

```bash
./deploy-app.sh
```

This skips `setup.sql` + `semantic_view.sql` and just re-builds the bundle and runs `snow app deploy`. Takes ~2-3 minutes vs ~15 minutes for `--bootstrap`.

For SQL changes (schema, agent spec, semantic view), re-run `--bootstrap` — it's idempotent. The Cortex Search service uses `CREATE IF NOT EXISTS`, so it's not rebuilt on subsequent runs (drop it manually if you change the search-service shape).

### 6. Teardown

```bash
# Stop the local producer + tunnel only (Snowflake untouched):
./quickstart.sh --down <connection>

# Stop containers AND drop the deployed SPCS app (keeps demo DB objects):
./quickstart.sh --teardown <connection>
# ...or drop just the app from a non-quickstart deploy:
./deploy-app.sh --teardown
```

`--teardown` runs `snow app teardown` under the hood. Two things that trip people up, both handled by the script:
- The dashboard is a `snowflake-app` entity, so it materializes as an **application service** (`SNOWFLAKE_EXAMPLE.CREDIT_DEMO.CREDIT_DASHBOARD`), **not** a global `APPLICATION` — it won't show in `SHOW APPLICATIONS`, and `DROP APPLICATION` won't find it. `snow app teardown` is the correct removal.
- `snow app teardown` needs the **rendered** `snowflake.yml` (the template's `${VAR}` tokens must be substituted first). `deploy-app.sh --teardown` renders + swaps it in for you. `--cascade` is Native-App-only and is intentionally not used.

For a **full clean slate** (also drop the demo Snowflake objects — the compute pool stops billing the moment it's dropped):

```bash
snow sql --connection <connection> --query "
  USE ROLE ACCOUNTADMIN;
  DROP AGENT IF EXISTS SNOWFLAKE_EXAMPLE.CREDIT_DEMO.CREDIT_AGENT;
  DROP CORTEX SEARCH SERVICE IF EXISTS SNOWFLAKE_EXAMPLE.CREDIT_DEMO.POSITIONS_SEARCH;
  DROP SEMANTIC VIEW IF EXISTS SNOWFLAKE_EXAMPLE.CREDIT_DEMO.CREDIT_SV;
  DROP EXTERNAL ACCESS INTEGRATION IF EXISTS DASHBOARD_VM_EAI;
  DROP COMPUTE POOL IF EXISTS DASHBOARD_POOL;
  DROP WAREHOUSE IF EXISTS CREDIT_DEMO_WH;
  DROP WAREHOUSE IF EXISTS CREDIT_DEMO_INT_WH;
  DROP USER IF EXISTS CREDIT_INGEST_USR;
  DROP ROLE IF EXISTS DASHBOARD_RL;
  DROP ROLE IF EXISTS CREDIT_INGEST_RL;
  DROP SCHEMA IF EXISTS SNOWFLAKE_EXAMPLE.CREDIT_DEMO;
"
```

The Interactive Warehouse keeps charging credits until you drop or `ALTER WAREHOUSE ... SUSPEND` it (see [Cost note](#cost-note)).

## What gets created in your account

After `./deploy-app.sh --bootstrap` completes, your account contains the following objects. Names use the defaults from `.env.example` — override the corresponding env var to change any of them.

| Snowflake object | Default name | Controlled by | Notes |
|---|---|---|---|
| Database | `SNOWFLAKE_EXAMPLE` | `APP_DB` | Created with `IF NOT EXISTS`; reuses an existing database |
| Schema | `CREDIT_DEMO` | `APP_SCHEMA` | All demo objects live here |
| Standard warehouse | `CREDIT_DEMO_WH` | `STANDARD_WH` | XSMALL, AUTO_SUSPEND=30s — cheap, suspends fast |
| Interactive warehouse | `CREDIT_DEMO_INT_WH` | `INTERACTIVE_WH` | XSMALL, AUTO_SUSPEND=86400s (24h) — stays warm for sub-second reads |
| Compute pool | `DASHBOARD_POOL` | `DASHBOARD_POOL` | CPU_X64_XS, min 1 / max 1 instance — runs the SPCS Snowflake App |
| External Access Integration | `DASHBOARD_VM_EAI` | `DASHBOARD_EAI` | Bound to two network rules (build + ingest) |
| Network rule (ingest) | `DASHBOARD_INGEST_RULE` | `INGEST_NETWORK_RULE` | Egress to `<INGEST_TUNNEL_HOST>:443` |
| Network rule (build) | `DASHBOARD_BUILD_RULE` | (fixed) | Permissive `0.0.0.0:443` for `npm install` during SPCS Buildpacks |
| Ingest role | `CREDIT_INGEST_RL` | `INGEST_ROLE` | Read/insert on `RAW_EVENTS`, CREATE PIPE on schema |
| Dashboard role | `DASHBOARD_RL` | `DASHBOARD_ROLE` | Read-only on every demo object the dashboard touches |
| Stage | `CREDIT_STAGE` | `INGEST_STAGE` | Internal stage for SPCS app artifacts |
| Interactive Table | `RAW_EVENTS` | (fixed) | `CREATE INTERACTIVE TABLE`, `CLUSTER BY (EVENT_TS)` — Snowpipe Streaming HPA writes directly into it; the dashboard serves every tile from it. Position attributes denormalized onto each event. |
| Table | `POSITIONS_DIM` | (fixed) | Reference dimension (62 loan positions); seed source for the denormalized event attributes + Cortex Search |
| App config table | `APP_CONFIG` | `APP_CONFIG_TABLE` | Holds `INGEST_TUNNEL_HOST` + `INGEST_API_KEY` at runtime |
| Cortex Agent | `CREDIT_AGENT` | `AGENT_NAME` | Orchestrates analyst (text-to-SQL) + search tools |
| Semantic View | `CREDIT_SEMANTIC_VIEW` | `SEMANTIC_VIEW_NAME` | Backs the agent's text-to-SQL tool |
| Cortex Search Service | `CREDIT_SEARCH_SVC` | `SEARCH_SERVICE_NAME` | Fuzzy issuer lookup for the agent |
| SPCS Snowflake App | `CREDIT_DASHBOARD` | `DASHBOARD_APP_NAME` | The Next.js service itself |

The `CREDIT_INGEST_USR` user is created for you by `quickstart.sh` (Option A, from the generated keypair). If you provision manually or use Option B, create it with the public key from §2 above.

## VM ingest setup

The producer is a small FastAPI service (`vm-ingest/ingest_worker.py`) that receives `/ingest` POSTs from the SPCS dashboard, validates the API key, and writes to `RAW_EVENTS` (+ the `POSITION_BOOK` pre-agg) via the Snowpipe Streaming HPA SDK with keypair JWT auth. Cloudflare Tunnel handles the public-internet hop so SPCS never needs the producer's IP.

Four tunnel patterns, grouped by the two producer-host options from the Quickstart:

**Option A — Local (laptop):**

| Path | Best for | Hostname stability | Setup time |
|---|---|---|---|
| **A. Quick tunnel** (`docker compose --profile quick` — what `quickstart.sh` uses) | Personal demos, smoke-tests | Ephemeral `*.trycloudflare.com`, changes on every restart | ~30 s |

**Option B — VM (any cloud or on-prem):**

| Path | Best for | Hostname stability | Setup time |
|---|---|---|---|
| **B. Named tunnel via API** (compose-embedded with `CLOUDFLARE_TUNNEL_TOKEN`) | Repeatable demos with a stable URL | Stable hostname survives restarts | ~5 min (one-time Cloudflare dashboard step) |
| **C. `vm-bootstrap.sh`** (host-installed cloudflared + systemd unit on Ubuntu) | Production-shaped on a long-lived VM | Stable hostname; survives VM reboots | ~10 min |
| **D. Terraform** (`vm-ingest/terraform/`) | Reproducible from-scratch GCP provisioning (adapt the provider for AWS/Azure) | Stable hostname + VM lifecycle managed | ~5 min after `terraform apply` |

All paths set `INGEST_TUNNEL_HOST` to a Cloudflare-issued hostname routed to the producer's `:8080`. Whichever you pick, put the hostname in the top-level `.env` and re-run `./deploy-app.sh` (no `--bootstrap` needed) — that updates `APP_CONFIG` and the EAI network rule. (`quickstart.sh` does this automatically for Path A.)

See `vm-ingest/README.md` for the per-path commands and `TESTING.md` for the verified outcomes of each.

## Cost note

This demo is not free at idle. The breakdown:

| Resource | Idle behavior | Mitigation |
|---|---|---|
| `CREDIT_DEMO_INT_WH` (Interactive XSMALL) | `AUTO_SUSPEND=86400s` (24 h) — effectively always-on while demo is in use | `ALTER WAREHOUSE CREDIT_DEMO_INT_WH SUSPEND;` overnight, or drop entirely between demos |
| `DASHBOARD_POOL` (CPU_X64_XS, min=1) | `AUTO_SUSPEND_SECS=600` (10 min); auto-resume on next request | `ALTER COMPUTE POOL DASHBOARD_POOL SUSPEND;` between demos, or drop |
| `CREDIT_DEMO_WH` (Standard XSMALL) | `AUTO_SUSPEND=30s` — suspends fast on its own | No action needed; visible cold-start ~1-2 s on first hit after suspend |
| Cortex Search Service `CREDIT_SEARCH_SVC` | TARGET_LAG=1 minute — refreshes hourly-equivalent | Dropping it is the only way to stop the refresh credits |
| Snowpipe Streaming HPA Auto-PIPE | Per-row + per-flush charges; only fires when the VM POSTs events | Stop the VM container (`docker compose down` in `vm-ingest/`) when you're not demoing |

**Measured idle burn (last 7 days, aws_spcs demo, no human users — just the server-side reader + compute pool keeping themselves warm):**

| Resource | Credits/day |
|---|---|
| `CREDIT_DEMO_INT_WH` (Interactive XSMALL) | **~28** |
| `CREDIT_DEMO_WH` (Standard XSMALL) | ~0.8 |
| `DASHBOARD_POOL` (CPU_X64_XS, min=1) | ~0.8 |
| Cortex AI services + PIPE | ~0.05 (negligible) |
| **Total at idle** | **~30 credits/day** |

**Why the Interactive WH is ~28/day, not ~14/day (24h × 0.6 cr/hr XSMALL):** the compute side IS 0.6 credits/hour (24h × 0.6 = ~14 credits/day), but `web/src/server/snowflake-reader.ts` polls at `SCAN_INTERVAL_MS = 200ms` — roughly 432,000 queries/day. Each query is cheap on compute but each one hits the cloud-services tier (parsing, planning, result-set serialization, metadata reads). After the account-wide 10%-of-compute cloud-services rebate, the net billed comes out around 1.18 credits/hour — almost 2× the bare compute rate.

**To trim the cost without sacrificing the demo:**

- **Suspend overnight**: `ALTER WAREHOUSE CREDIT_DEMO_INT_WH SUSPEND;` → daily burn drops to <2 credits/day during off hours.
- **Bump the poll cadence**: change `SCAN_INTERVAL_MS` from 200 → 500 or 1000 ms in `web/src/lib/constants.ts`. Halves or quarters the cloud-services line; tile-paint UX is dominated by optimistic React state, so users don't feel the slower server poll.
- **Skip the SQL when no clients are connected**: gate `snowflake-reader` on `wsBroker.clientCount() > 0`. Idle dashboard with zero browsers = zero queries, zero cloud-services credits.

At a typical effective enterprise rate (~$2/credit) this demo idle costs roughly **$60/day** if left running 24/7, or **~$4/day** if you suspend the Interactive WH between demos.

## File map

| Path | Purpose |
|---|---|
| `setup.sql` | Single source of truth for all Snowflake DDL (database/schema/warehouses/pool/EAI/roles/tables/agent/search service/grants), envsubst-templated from `.env` |
| `semantic_view.sql` | Defines `CREDIT_SV` for the agent's text-to-SQL tool, also envsubst-templated |
| `web/snowflake.yml` | Snowflake App manifest for SPCS deployment, envsubst-templated |
| `quickstart.sh` | One command for a fresh account: scaffolds `.env`, generates the ingest keypair, provisions objects (`--infra-only`), creates the ingest user, starts the local producer + tunnel, captures the URL, and deploys. Uses a named tunnel automatically if `CLOUDFLARE_TUNNEL_TOKEN` is set, else the quick tunnel. Namespaces each instance by connection (compose project + container names + free host port) so accounts coexist. `--watch` self-heals a rotated quick-tunnel URL; `--down <conn>` stops the local containers; `--teardown <conn>` also drops the SPCS app |
| `deploy-app.sh` | Render templates → run setup SQL (`--bootstrap` / `--infra-only`) → push runtime config → `snow app deploy`. `--render-only` renders without deploying; `--teardown` drops the deployed SPCS app (renders `snowflake.yml` first, then `snow app teardown`) |
| `.env.example` | All configuration variables with documented defaults (Snowflake object names, tunnel, ingest key, optional `INGEST_HOST_PORT`) |
| `web/server.js` | Custom standalone server that monkey-patches Next.js's `server.js` to handle WebSocket upgrades on `/api/ws` |
| `web/src/app/layout.tsx` | Root layout with the four-tab nav (Demo / Live Credit Desk / Ask the Book / How fresh & fast?) and global WS provider |
| `web/src/app/page.tsx` | Live Credit Desk page — KPI tiles, latency timeline, live tape, sector donut, top marks, watchlist |
| `web/src/app/demo/page.tsx` | Demo control room — Fresh/Fast cards, Live Market simulator, interactive-latency + serving-strategy panels |
| `web/src/app/latency/page.tsx` | "How fresh & fast?" — plain-English explainer of every freshness/latency/lag component with a Fire & measure widget and a per-event "do the parts add up?" reconciliation |
| `web/src/app/ask/page.tsx` | Ask the Book page — Cortex Agent chat with SSE streaming |
| `web/src/app/api/health/` | Liveness probe (returns `{ok: true, ...}`) |
| `web/src/app/api/warmup/` | Pre-warms the Snowflake connection + reader on first request |
| `web/src/app/api/ws/` | WebSocket route (handled by `server.js` upgrade handler, not a Next.js route handler) |
| `web/src/app/api/snapshot/standard/` | Snapshot rollup using the standard warehouse (cold-start visible) |
| `web/src/app/api/snapshot/at/` | Same rollup using the Interactive warehouse (stays warm) |
| `web/src/app/api/ingest/` | POST proxy to VM tunnel (optimistic + verified WS broadcast) |
| `web/src/app/api/ingest-verified/` | Honest click→IT-confirmed path: append + tight-poll RAW_EVENTS until queryable, return the row + full timing breakdown (powers the Fire & measure widget) |
| `web/src/app/api/ingest-batch/` | Same as `/api/ingest` but accepts an array — used by stress-test buttons |
| `web/src/app/api/serving-compare/` | Runs the book three ways (windowed / pre-agg / MAX_BY) and returns latencies + a totals-match check |
| `web/src/app/api/agent/stream/` | SSE proxy to Cortex Agent `:run` endpoint |
| `web/src/app/api/observability/` | Pipeline observability metrics for the diagnostic panel |
| `web/src/app/api/debug/` | Internal debug endpoints (config dump, connection test) |
| `web/src/server/snowflake-client.ts` | OAuth token + SQL Statements REST API client (the canonical SPCS path) |
| `web/src/server/snowflake-reader.ts` | 200 ms diff poll loop that drives WS push |
| `web/src/server/ws-broker.ts` | Connected-client registry + broadcast helpers |
| `web/src/server/agent-proxy.ts` | Cortex Agent SSE event-stream parser + adapter |
| `web/src/server/queries.ts` | Snapshot SQL strings (positions, PnL, sector, lag, top marks, day metrics, watchlist) |
| `web/src/server/vm-proxy.ts` | `/api/ingest` → VM tunnel forwarder with retry/timeout |
| `web/src/server/config.ts` | Server-side env mirror (`APP_DB`, `APP_SCHEMA`, `INTERACTIVE_WH`, etc.) |
| `web/src/lib/constants.ts` | Client-side constants (`POLL_INTERVAL_MS=1500`, `SCAN_INTERVAL_MS=200`, NEXT_PUBLIC_* mirrors) |
| `web/src/components/` | 18 React components (KpiTiles, LiveTape, EventGenerator, AgentChat, etc.) |
| `vm-ingest/` | VM producer (FastAPI + HPA SDK), 4 cloudflared tunnel paths, optional Terraform |
| `ASSUMPTIONS.md` | Architecture decisions + latency budget |
| `MIGRATION.md` | Diff from parent fork + side-by-side instructions |
| `TALK_TRACK.md` | 8-min demo script highlighting the latency win |
| `TESTING.md` | Test coverage matrix + verified E2E reproduction steps |
| `TROUBLESHOOTING.md` | Common issues + recovery |
| `CONTRIBUTING.md` | Internal-only contribution policy + development setup |

## Demo script (8 minutes)

| Minute | Action | What to point out |
|---|---|---|
| 0:00 | Open dashboard | 62-position book loads instantly (WS connected, initial snapshot pushed) |
| 0:30 | Point at the architecture | "Same HPA pipeline as before — the only change is what renders the data" |
| 1:00 | Click **TRADE** | Latency timeline breaks down the round trip (net + SDK + flush). Optimistic grey row appears in ~10ms, then goes green when the IT confirms — the honest click→interactive-table-confirmed is ~1.5–2s, dominated by the ~1.3s streaming-visibility lag (varies ~0.7–2.4s); the React render step is ~10ms |
| 2:00 | Click 5x rapidly | All 5 bars stack. Each render/diff is a few ms; rows appear optimistically in ~10ms. "That's the React diff — no full-page rerun" |
| 2:30 | Flip **Live market** ON (1–4/s) | The desk now streams marks/trades on its own — tape, KPIs, sector donut, top movers, and the **Serving strategy comparison** all move live. "Every one of these is fed by the same HPA write-through." |
| 3:00 | Point at **Serving strategy comparison** | Three ways to serve the book (query-time window / pre-agg write-through / MAX_BY), live latency each, "totals match ✓", freshness ~1.3s p50 (streaming-visibility lag, varies ~0.7–2.4s) — all equally fresh, no `TARGET_LAG`. |
| 4:00 | Switch back to React fork | "That's the A/B. Everything Snowflake-side was already sub-second." |
| 5:00 | Switch to **Ask the Book** tab | "What is today's P&L by sector?" — Cortex Agent streams tokens via SSE |
| 6:00 | Fuzzy search | "Show me Apollo's exposure" — same Agent, same Search service |
| 7:00 | The closer | Click TRADE in the Live Credit Desk tab, switch to Ask the Book and ask "What was our most recent trade?" — same row, shown optimistically on the tile in ~10ms (queryable/IT-confirmed ~1.5–2s) and findable by the Agent in 5-10 s |

The Live Credit Desk tab also has **MARK** and **CREDIT** buttons next to TRADE for mark-to-market price updates and credit events (rating changes, defaults, restructurings).

## Glossary

Terms used throughout the README, in case you're not deep in the Snowflake stack:

| Term | What it means here |
|---|---|
| **HPA** | High-Performance Architecture — Snowflake's GA Snowpipe Streaming engine. Sub-100 ms row commits via the Java/Python SDK. Replaces the older Snowpipe (file-based, minute-scale) for streaming workloads. |
| **Auto-PIPE** | The named `PIPE` object the HPA SDK auto-creates the first time you open a channel against a table. Format: `<TABLE>-STREAMING`. You don't manage it directly. |
| **Interactive Table** | A Snowflake table type (`CREATE INTERACTIVE TABLE`) optimized for sub-second concurrent reads, with `CLUSTER BY` clustering. Can be a **direct Snowpipe Streaming target** (rows appended via the channel API, as `RAW_EVENTS` is here) or auto-refreshed from a source with `TARGET_LAG`. Same SQL surface as a regular table; different storage/serving engine. Supports Time Travel even under continuous streaming writes. |
| **Interactive Warehouse** | A warehouse SKU that stays warm to query Interactive Tables. XSMALL ≈ 0.6 credits/hour compute. Long `AUTO_SUSPEND` keeps it serving sub-second reads. |
| **SPCS** | Snowpark Container Services — Snowflake's container hosting layer. Runs your Docker image on a `compute pool` you create. This dashboard runs on SPCS. |
| **Snowflake App** | An SPCS deployment unit (`snow app deploy`). Bundles a `snowflake.yml` manifest + your code stage. Snowsight handles auth/routing for you (the dashboard is gated by Snowsight OAuth). |
| **Buildpacks** | The build system `snow app deploy` uses. No Dockerfile required — it detects your stack (Next.js here) and produces an image automatically. |
| **EAI** (External Access Integration) | A Snowflake object that whitelists outbound network access from inside the platform. The dashboard uses one EAI bound to two network rules: a permissive build-time one (npm registry) and a narrow runtime one (only the cloudflared tunnel host). |
| **Cortex Agent** | A Snowflake-native agent object (`CREATE AGENT`). Orchestrates Cortex Analyst (text-to-SQL) + Cortex Search (semantic lookup) tools. Streams responses via SSE. |
| **Cortex Analyst** | Snowflake's text-to-SQL service, configured via a `CREATE SEMANTIC VIEW` definition that names the dimensions/measures the LLM can use. |
| **Semantic View** | A Snowflake object (`CREATE SEMANTIC VIEW`) that declares the tables, dimensions, and metrics in business-friendly terms. Backs Cortex Analyst's text-to-SQL. |
| **Cortex Search Service** | A Snowflake-native vector + keyword search index (`CREATE CORTEX SEARCH SERVICE`). Used here for fuzzy issuer lookup ("Apollo"). |
| **OAuth token at `/snowflake/session/token`** | The path inside an SPCS container where Snowflake mounts a short-lived OAuth token bound to the app's owner role. The dashboard reads this on every API call instead of using a PAT or keypair. |

## Coexistence with parent fork

If you've already deployed the parent Streamlit fork to the same account, you can run both demos side-by-side for the latency A/B. Set `APP_DB` and `APP_SCHEMA` in `.env` to the parent's database/schema (default `SNOWFLAKE_EXAMPLE.CREDIT_DEMO`); `--bootstrap` is idempotent and reuses existing objects. The new objects are `DASHBOARD_*`-prefixed and don't collide with the parent's `CREDIT_*` objects:

- `DASHBOARD_POOL` (parent uses `CREDIT_POOL`)
- `DASHBOARD_VM_EAI` (parent uses `CREDIT_INGEST_EAI`)
- `DASHBOARD_RL` (parent's `CREDIT_INGEST_RL` is reused, not duplicated)

The VM producer, `RAW_EVENTS`, `POSITIONS_DIM`, `CREDIT_AGENT`, and `CREDIT_SV` are shared. If you're starting from a fresh account with only this fork, you don't need to think about coexistence — `--bootstrap` creates everything from scratch.

## Repository Owner

- **Owner:** John Kang (john.kang@snowflake.com / [@sfc-gh-jkang](https://github.com/sfc-gh-jkang))
- **License:** Apache-2.0 — see [LICENSE](LICENSE)

## License

Apache License, Version 2.0. See [LICENSE](LICENSE).

## Disclaimer

This is a Snowflake Sales Engineering sample, not an officially supported Snowflake product. The position book, issuers, trades, marks, and credit events are all synthetic. ACME Credit Management is fictional.

## Known gotchas (and what we tried)

These bugs were hit during the initial build. Documenting here so future contributors don't repeat them.

### 1. `next.config.ts` not supported

**Symptom**: Build fails immediately with a confusing parse error.

**Fix**: Must use `next.config.js` with `module.exports = { ... }`. TypeScript config files (`.ts`) are not reliably supported by the Next.js 14 standalone build pipeline, especially when running inside a Docker multi-stage build.

### 2. `output: "standalone"` required for SPCS

**Symptom**: `snow app deploy` extracts to `/tmp/_spcs_runner/` and Node can't find the entry point. The app crashes with `MODULE_NOT_FOUND`.

**Fix**: Set `output: "standalone"` in `next.config.js`. Run with `node .next/standalone/server.js`. This produces a self-contained Node.js server without needing the full `node_modules/` tree.

### 3. `snowflake-sdk` OAuth callbacks don't fire inside SPCS

**Symptom**: Connection object is created, `connect()` callback fires, but no queries actually execute. The SDK silently drops requests.

**Fix**: Replaced the Node.js SDK entirely with a direct REST API client to `/api/v2/statements`, reading the OAuth token from `/snowflake/session/token`. See `web/src/server/snowflake-client.ts`. This is more reliable in SPCS because it doesn't depend on the SDK's internal connection state machine.

### 4. UTC vs PT timestamp skew

**Symptom**: `AGE_SEC` values are negative (e.g., -24264s). Events appear "from the future."

**Root cause**: `CURRENT_TIMESTAMP()` returns the session's local timezone (LTZ). The VM producer writes `EVENT_TS` as UTC walltime. Subtracting LTZ from UTC produces garbage when the session timezone isn't UTC.

**Fix**: Use `SYSDATE()` which always returns UTC regardless of session timezone. See `web/src/server/queries.ts` — all age/freshness calculations use `SYSDATE()`.

### 5. Next.js 14 fetch Data Cache

**Symptom**: Dashboard polls Snowflake every 1.5s, but `INFORMATION_SCHEMA.QUERY_HISTORY` shows 0 queries. The UI displays stale data that never updates. Verified: 21 snapshot polls in 30s produced 0 actual Snowflake queries.

**Root cause**: `dynamic = "force-dynamic"` in the route handler only disables the Full Route Cache (rendered HTML output). It does NOT disable the Data Cache that wraps every `fetch()` in server-side code. Identical POST bodies (same SQL string every 1.5s) are deduplicated by the Data Cache and never hit the wire.

**Fix**: Add `cache: "no-store"` to every server-side `fetch()` call. See `web/src/server/snowflake-client.ts`. This is a **hard requirement** — any new `fetch()` added to server code without `cache: "no-store"` will be silently cached.

### 6. SPCS OAuth token can't switch roles

**Symptom**: Every Snowflake API call returns `390186 Role 'DASHBOARD_RL' specified in the connect string is not granted to this user`, even after `GRANT ROLE DASHBOARD_RL TO USER <deploying-user>`.

**Root cause**: The OAuth token mounted at `/snowflake/session/token` inside SPCS is a **scoped token** bound to a single role (the app owner role). Sending `role: "DASHBOARD_RL"` in the request body of `/api/v2/statements` triggers a role-switch the token isn't allowed to perform — independent of what the underlying user is granted.

**Fix**: Don't send `role:` in the API body. Let the token use its bound default role. The deploying user's role already has all the read access the dashboard needs (granted via `setup.sql`). The intended read-only scoping (`DASHBOARD_RL`) is preserved at the SQL/object-grant layer; the runtime just doesn't switch into it. See `web/src/server/snowflake-client.ts:72`.

### 7. Creating the Interactive Warehouse hijacks the session's current warehouse

**Symptom**: On a fresh account, `setup.sql` fails partway (e.g. Cortex Search build errors with "Querying non-interactive table ... is not supported in interactive warehouses", or a DDL times out at 5s).

**Root cause**: `CREATE WAREHOUSE <interactive>` sets it as the **session-current warehouse**. Everything after runs on the interactive WH, which has a 5s query timeout and can only query interactive tables.

**Fix**: `setup.sql` runs `USE WAREHOUSE ${STANDARD_WH};` immediately after the interactive-WH block. Any script that creates an interactive warehouse must reset the current warehouse right after.

### 8. Some accounts DNS-validate egress network-rule hosts at CREATE time

**Symptom**: On a fresh Azure account, `CREATE NETWORK RULE ... VALUE_LIST = ('<tunnel-host>:443')` is rejected with "invalid value" when the host doesn't resolve yet.

**Root cause**: Certain accounts resolve egress `HOST_PORT` values at creation time and reject non-resolving hostnames. The tunnel host doesn't exist during `--bootstrap` (it's created later).

**Fix**: `setup.sql` seeds the egress rule with a resolvable stub (`example.com:443`). `deploy-app.sh` then `CREATE OR REPLACE`s it with the real tunnel host once the tunnel is up (and `--watch` keeps it current). Never bake the real tunnel host into `setup.sql`.

### 9. `.env` placeholder values break `source`

**Symptom**: `deploy-app.sh` / `quickstart.sh` fail with `syntax error near unexpected token 'newline'` on a fresh `.env`.

**Root cause**: Placeholder values like `<your-connection>` contain `<` / `>`, which `source`/`.` interpret as shell redirection.

**Fix**: Both scripts parse `.env` with a literal `KEY=VALUE` line reader (no `source`, no evaluation of the value). Keep it that way when adding env handling.

### 10. Ingest service user fails with "No active warehouse selected"

**Symptom**: `POSITION_BOOK` stays empty / `book_flush` is null; producer logs show `000606: No active warehouse selected` on non-streaming SELECTs.

**Root cause**: `CREATE USER ... TYPE=SERVICE` has no default warehouse/role, and the HPA producer runs plain SELECTs (book hydration, `POSITIONS_DIM` load) outside the streaming path.

**Fix**: `quickstart.sh` creates `CREDIT_INGEST_USR` with `DEFAULT_WAREHOUSE = ${STANDARD_WH}` and `DEFAULT_ROLE = ${INGEST_ROLE}`. The manual-create snippet in the README does the same.

### 11. Quick tunnel drops / rotates its URL mid-demo

**Symptom**: Dashboard shows `502 ingest-verified failed: fetch failed` or "VM unreachable" after the tunnel has been up a while or the container restarted.

**Root cause**: The anonymous quick tunnel (a) has its QUIC connection reset on some corporate networks, and (b) gets a **new** `*.trycloudflare.com` URL on every container restart.

**Fix**: cloudflared runs with `--protocol http2` (avoids the QUIC resets). For URL rotation, the app re-reads `APP_CONFIG` every ~60s (`web/src/server/vm-proxy.ts` `CONFIG_TTL_MS`), so a rotated URL self-heals **with no redeploy** once `APP_CONFIG` + the egress rule are updated. Run `./quickstart.sh --watch <connection> &` to push the live URL automatically, or use a **named tunnel** (set `CLOUDFLARE_TUNNEL_TOKEN` + `INGEST_TUNNEL_HOST`) for a stable hostname.

### 12. Two demos on one laptop clobber each other's containers

**Symptom**: Running `quickstart.sh` for a second account stops/removes the first account's producer + tunnel.

**Root cause**: `docker compose` run from each clone's `vm-ingest/` dir defaults to the **same** project name (`vm-ingest`, the dir basename) and shares service keys (`credit-ingest`, `cloudflared-quick`); compose matches containers by project+service and recreates them — even with different `container_name`s.

**Fix**: `quickstart.sh` namespaces every instance by connection: `COMPOSE_PROJECT_NAME=credit-<connection>`, container names `credit-<svc>-<connection>` (via `CREDIT_INSTANCE`), and an auto-picked free host port (`INGEST_HOST_PORT`, 8080 → 8081 → …). Clone once per account and run `./quickstart.sh <connection>` in each — they coexist.

