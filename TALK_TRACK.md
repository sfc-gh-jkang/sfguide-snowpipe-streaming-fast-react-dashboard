# Live Credit Desk Demo — Talk Track (React Fork)
**Audience:** [Customer name] — private credit / asset management firm
**Date:** [Demo date]
**Speaker:** [Your name], Snowflake SE

---

## 60-second narrative (open with this)

> "Every piece of the streaming pipeline here is sub-second — Snowpipe Streaming commits in 30 milliseconds, the row is queryable in 150ms, Interactive Warehouse returns it in 250ms. Traditional dashboards add 3-5 seconds of latency because they re-render the entire page on every interaction.
>
> What you're about to see is a React dashboard running on Snowpark Container Services with a WebSocket push model. The tile update after a click is under 100 milliseconds. Same data path — HPA SDK, Interactive Tables, Cortex Agent — but with a rendering model that diffs one component instead of rebuilding the page. Let me show you."

## What changed (and what didn't)

| Layer | Traditional approach | This demo (React on SPCS) | Notes |
|---|---|---|---|
| Producer VM + HPA SDK | FastAPI + 4-ch pool | FastAPI + 4-ch pool | Unchanged |
| Snowpipe Streaming commit | ~30ms | ~30ms | Unchanged |
| Interactive Table | RAW_EVENTS (streaming target + serving) | RAW_EVENTS (streaming target + serving) | Unchanged |
| Interactive Warehouse | CREDIT_DEMO_INT_WH | CREDIT_DEMO_INT_WH | Unchanged |
| Cortex Agent | CREDIT_AGENT | CREDIT_AGENT | Unchanged |
| **UI framework** | **Full-page rerun (3-5s)** | **Next.js + WebSocket (<100ms)** | **30-50x faster** |

## Demo script (8 minutes)

### Beat 1 — "The same book" (0:00-1:00)

- Open the React dashboard. Same 62 positions, same sectors, same data.
- "Notice it loaded instantly — the server pushed the initial snapshot over WebSocket the moment you connected. No polling, no page reload."

### Beat 2 — "The click" (1:00-2:30)

- Click **Trade**.
- Point at the latency timeline: "~50ms total. The grey flash you saw was the optimistic ack — the app assumed success before the DB confirmed. The green flash 150ms later is the verified ack — HPA actually committed. React updated just that one tile, not the whole page."
- Click 5 more times rapidly. All bars stack. None exceed 100ms for the visible update.

### Beat 3 — "Why it's fast" (2:30-4:00)

- Point at the tape: "Traditional dashboards poll the database every few seconds and redraw the entire page — 3-5 seconds of dead air after every click. Here, the WebSocket pushes only the changed rows at 200ms cadence. React diffs one component, not the full DOM."
- Fire **Trade** again. Point at the timeline bar. "That bar is the *entire* round trip — click to painted pixel. Under 100ms. The optimistic ack fires before Snowflake even confirms the commit. When the Interactive Table confirms (~2400ms), the row goes solid green. Zero wasted re-renders."
- "Same HPA commit. Same Interactive Table. Same row. The difference is purely the rendering model."

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
- Agent finds it. "That row was committed 150ms after you clicked, queryable in 250ms, visible on the tile in <100ms, and the Agent found it in the book within 10 seconds. Five layers — ingest, storage, serving, AI, UI — all Snowflake, one account."

### Beat 7 — "The closer" (7:30-8:00)

- Show the architecture diagram. "The only thing outside Snowflake is the producer VM — and that's by design, because the HPA SDK is a client library. Everything else — serving, AI, dashboard — is managed by Snowflake. The 3-5 second gap is gone."

## What the customer should walk away believing

1. **The streaming pipeline was never slow** — Snowflake commits in 30ms, queries in 250ms. The 3-5s was the UI framework, not the platform.
2. **SPCS is production-ready for internal dashboards** — OAuth gated, no separate auth, scales with compute pool sizing.
3. **WebSocket push eliminates polling waste** — 200ms cadence, diff-only broadcasts, React.memo prevents off-slice re-renders.
4. **The speed is undeniable** — same data, same path, <100ms visible response. Record the screen.
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
