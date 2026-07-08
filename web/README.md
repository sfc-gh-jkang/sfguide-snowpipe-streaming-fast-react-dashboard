# ACME Credit Desk — Next.js Frontend

React dashboard for the Snowpipe Streaming HPA demo. Replaces Streamlit with WebSocket-driven real-time updates: the optimistic row appears in ~0.4s (render step ~10ms) vs Streamlit's ~1.6s full-script rerun.

## Local Development

```bash
# Install dependencies
npm install

# Start dev server (hot reload)
npm run dev
# → http://localhost:3000

# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Production build (standalone mode for Docker)
npm run build
npm start
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| (none for frontend) | — | All API calls go through Next.js API routes (`/api/ingest`, `/api/ws`, `/api/agent/stream`) which are implemented by Lane B. No direct VM access from the browser. |

## Architecture

```
Browser (React + Chart.js)
  ├── WebSocket (/api/ws) ← real-time KPI/tape/sector/topmarks pushes
  ├── POST /api/ingest → SPCS proxy → VM cloudflared tunnel
  └── POST /api/agent/stream → Cortex Agent SSE (text-to-SQL)
```

### Key Design Decisions

1. **Zustand store** — single global state; selectors prevent off-slice re-renders
2. **WebSocket with auto-reconnect** — exponential backoff (1s → 30s cap), event_id dedup
3. **Optimistic UI** — click fires POST, immediately renders grey "pending" row; WS verified message swaps to green checkmark
4. **Chart.js stacked bar** — latency timeline shows network/SDK/flush/IT-poll per click
5. **React.memo on KPI tiles** — each tile only re-renders when its value changes
6. **SSE streaming for agent** — token-by-token rendering with status step indicators

## Directory Structure

```
web/
├── src/
│   ├── app/
│   │   ├── layout.tsx       # Root layout + header + tab nav + WS provider
│   │   ├── page.tsx         # Live Desk tab (default route)
│   │   ├── ask/page.tsx     # Ask the Book tab (Cortex Agent chat)
│   │   └── globals.css      # Snowflake brand tokens + component styles
│   ├── components/
│   │   ├── LatencyTimeline.tsx  # Chart.js stacked bar
│   │   ├── LiveTape.tsx         # Event tape table (optimistic → verified)
│   │   ├── KpiTiles.tsx         # Memo'd metric tiles
│   │   ├── SectorDonut.tsx      # Chart.js doughnut
│   │   ├── TopMarks.tsx         # Top 10 mark moves table
│   │   ├── EventGenerator.tsx   # Trade/Mark/Credit buttons
│   │   ├── AgentChat.tsx        # SSE chat with markdown render
│   │   └── HpaStatus.tsx        # Channel health indicator
│   └── lib/
│       ├── types.ts     # Cross-lane WS message contract
│       ├── store.ts     # Zustand global state
│       └── ws.ts        # WebSocket hook with reconnect
├── __tests__/           # Jest + React Testing Library
├── package.json
├── next.config.ts       # output: "standalone"
├── tsconfig.json
├── tailwind.config.js
├── postcss.config.js
└── Dockerfile           # Multi-stage build (Lane C)
```

## Deploy notes

### `cache: "no-store"` is a hard requirement

Every server-side `fetch()` call in this app **must** include `cache: "no-store"` in its options. Without it, Next.js 14's Data Cache deduplicates identical POST bodies and silently returns stale results.

This is separate from `dynamic = "force-dynamic"` on route handlers — that only disables the Full Route Cache (rendered HTML), not the per-fetch Data Cache.

```typescript
// CORRECT — bypasses Data Cache
const res = await fetch(url, {
  method: "POST",
  cache: "no-store",
  // ...
});

// WRONG — will be cached, queries never hit Snowflake
const res = await fetch(url, {
  method: "POST",
  // missing cache: "no-store"
});
```

See `src/server/snowflake-client.ts` for the reference implementation.

