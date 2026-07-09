# Live Credit Desk Demo — Talk Track (React Fork)
**Audience:** [Customer name] — private credit / asset management firm
**Date:** [Demo date]
**Speaker:** [Your name], Snowflake SE

---

## 60-second narrative (open with this)

> "Every read here is sub-second — Snowpipe Streaming commits in ~0.3 seconds, and once a streamed row is queryable the Interactive Warehouse returns it in ~130ms. One honest caveat: a just-committed streamed row takes ~1.3 seconds (p50; varies ~0.7–2.4 s) to become queryable on the interactive warehouse — that's the streaming-visibility lag, and any consumer (including Streamlit) pays it. On top of that, traditional dashboards add ~1.6 seconds of rerun latency on every interaction — up to 3.4s at p95 — because they re-render the entire page.
>
> What you're about to see is a React dashboard running on Snowpark Container Services with a WebSocket push model. After a click, the just-fired row **paints optimistically in ~10 milliseconds** — React prepends it instantly instead of blocking on a full-script rerun — while the honest **click → interactive-table-confirmed** time is ~1.5–2 seconds (p50), dominated by that ~1.3 s visibility lag (which varies ~0.7–2.4 s). Same data path — HPA SDK, Interactive Tables, Cortex Agent. Let me show you."

## What changed (and what didn't)

| Layer | Traditional approach | This demo (React on SPCS) | Notes |
|---|---|---|---|
| Producer VM + HPA SDK | FastAPI + 4-ch pool | FastAPI + 4-ch pool | Unchanged |
| Snowpipe Streaming commit | ~0.3s | ~0.3s | Unchanged (dual-table max) |
| Interactive Table | RAW_EVENTS (streaming target + serving) | RAW_EVENTS (streaming target + serving) | Unchanged |
| Interactive Warehouse | CREDIT_DEMO_INT_WH | CREDIT_DEMO_INT_WH | Unchanged |
| Cortex Agent | CREDIT_AGENT | CREDIT_AGENT | Unchanged |
| **UI framework** | **Full-page rerun (~1.6s p50, 3.4s p95)** | **Next.js + WebSocket (optimistic paint ~10ms; click→IT-confirmed ~1.5–2s p50)** | **Feels instant vs a blocking rerun; both pay the same ~1.3s p50 IT visibility (varies ~0.7–2.4s)** |

## Demo script (8 minutes)

### Beat 1 — "The same book" (0:00-1:00)

- Open the React dashboard. Same 62 positions, same sectors, same data.
- "Notice it loaded instantly — the server pushed the initial snapshot over WebSocket the moment you connected. No polling, no page reload."

### Beat 2 — "The click" (1:00-2:30)

- Click **Trade**.
- Point at the latency timeline: "The grey flash you saw was the optimistic paint — React prepended the row **instantly on click (~10ms)**, before the network even round-trips. The green flash later is when the interactive table confirms the row is actually queryable — that's ~1.5–2s end-to-end (p50), dominated by the ~1.3s streaming-visibility lag (varies ~0.7–2.4s). React updated just that one tile, not the whole page."
- Click 5 more times rapidly. All bars stack. Each render/diff is a few milliseconds; the rows paint optimistically in ~10ms (they confirm against the interactive table a couple seconds later).
- Flip **Live market** ON: "Now the desk runs itself — a stream of marks and trades, so you can watch the tape, P&L, and tiles move live without clicking. Every one of these events goes through the exact same HPA write-through."

### Beat 3 — "Three ways to serve the book, all fresh" (2:30-4:00)

- Point at the **Serving strategy comparison** panel (now moving because Live market is on): "We serve the same position-book P&L rollup three ways on the Interactive Warehouse — a query-time window rollup, a pre-aggregated write-through cache, and an optimized MAX_BY rollup. The bars are live read latency; the pre-agg is fastest."
- "The 'totals match' check proves all three return identical numbers — same data, three serving paths. And the freshness row shows event→queryable ~1.3s p50 (the streaming-visibility lag, varies ~0.7–2.4s) and event→visualized — all three equally fresh, because none uses a TARGET_LAG refresh. That's the 'Interactive Tables replace Redis' story done without the staleness."
- Open the panel's **How this works** pop-down if asked: it defines latency vs. lag vs. freshness with the Snowflake docs.
- "Same HPA commit. Same Interactive Table. The difference between the strategies is purely how you serve the read."

### Beat 4 — "What this means for your desk" (4:00-5:00)

- "Your PMs watching the morning call dashboard don't need to click refresh. The WebSocket pushes every 200ms. New mark comes in from Bloomberg? It's on screen before your analyst can alt-tab to the terminal."
- "And because the dashboard runs on SPCS — Snowpark Container Services — it's inside Snowflake's auth perimeter. No separate SSO, no VPN, no firewall rules. Same Snowsight login your team already uses."

### Beat 5 — "Ask the Book" (5:00-6:30)

- Switch to the **Ask the Book** tab.
- Type: "What is today's P&L by sector?"
- Agent streams tokens via SSE. First token in <1s, full table in 5-10s.
- "Same Cortex Agent as before. Same Semantic View. Same Cortex Search for fuzzy issuer lookup. The Agent doesn't care what frontend is calling it — it answers the same way."

### Beat 6 — "The pipeline, end to end" (6:30-7:30)

- Fire one more trade in the React UI.
- Switch to Ask the Book: "What was our most recent trade?"
- Agent finds it. "That row painted optimistically on the tile in ~10ms, committed in ~0.3s, became queryable in the interactive table ~1.3s later (p50; varies ~0.7–2.4s), and the Agent found it in the book within 10 seconds. Five layers — ingest, storage, serving, AI, UI — all Snowflake, one account."

### Beat 7 — "The closer" (7:30-8:00)

- Show the architecture diagram. "The only thing outside Snowflake is the producer VM — and that's by design, because the HPA SDK is a client library. Everything else — serving, AI, dashboard — is managed by Snowflake. The ~1.6-second full-rerun gap is gone."

## What the customer should walk away believing

1. **The serving layer is fast** — Snowflake commits in ~0.3s and serves reads in ~130ms. The honest caveat: a just-streamed row takes ~1.3s p50 to become queryable (streaming-visibility lag, varies ~0.7–2.4s) — a platform characteristic any consumer pays. On top of that, the ~1.6s (up to 3.4s p95) rerun cost was the UI framework, and the optimistic paint (~10ms) hides both from the user.
2. **SPCS is production-ready for internal dashboards** — OAuth gated, no separate auth, scales with compute pool sizing.
3. **WebSocket push eliminates polling waste** — 200ms cadence, diff-only broadcasts, React.memo prevents off-slice re-renders.
4. **The perceived speed is undeniable** — same data, same path, the row paints optimistically in ~10ms (vs Streamlit blocking on a ~1.6s rerun). Record the screen.
5. **Cortex Agent works with any frontend** — SSE streaming gives token-by-token UX regardless of the calling framework.

## Anticipated questions

**Q: Can we use this pattern for our production dashboard?**
A: Yes. SPCS supports multi-node compute pools, auto-scaling, and Snowsight OAuth. The Next.js app is stateless — any node can serve any connection. For HA, set MIN_NODES=2.

**Q: What about mobile / tablet?**
A: The React UI is responsive by default. WebSocket works on all modern browsers including iOS Safari. No native app needed.

**Q: Cost compared to other dashboard options?**
A: SPCS is credit-per-second on the compute pool (CPU_X64_XS). The Interactive Warehouse cost is identical regardless of frontend — same queries, same cadence. The Next.js container is lightweight and stateless.

**Q: How hard is it to add new tiles / views?**
A: One React component + one SQL query in `queries.ts`. Deploy with `snow app run`. No Python environment, no conda conflicts, no full-page rerun gotchas.

## Demo-day pre-flight

```bash
# 1. Verify VM producer
curl -s https://${INGEST_TUNNEL_HOST}/health | jq .
# Should show channels=4, status=healthy

# 2. Pre-warm Interactive Warehouse
snow sql -c "$SNOWFLAKE_CONNECTION" -q "
  USE WAREHOUSE CREDIT_DEMO_INT_WH;
  SELECT COUNT(*) FROM SNOWFLAKE_EXAMPLE.CREDIT_DEMO.RAW_EVENTS;
"

# 3. Ensure the app is deployed
snow app status   # React dashboard on SPCS

# 4. Fire 3 warmup events via the dashboard (or curl)
# This ensures HPA channels are open and caches are hot

# 5. Start screen recording
```

## If something breaks during the demo

| Failure | Recovery |
|---------|----------|
| WebSocket disconnects | Browser auto-reconnects in 1s; missed events backfilled from snapshot |
| SPCS container restart | Compute pool auto-resumes; 30-60s cold start |
| VM tunnel drops | Same as parent — restart cloudflared on VM |
| Agent times out | Refresh the tab; Agent SSE connection resets |
| Interactive WH cold | First query takes 3-5s; pre-flight step 2 prevents this |
