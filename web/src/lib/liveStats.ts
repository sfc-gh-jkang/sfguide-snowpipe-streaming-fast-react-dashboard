import type { LatencyBar } from "./types";

/**
 * Live end-to-end latency derived from the store's latency bars.
 *
 * Every event — a manual click OR a Live Market stream tick — produces a bar.
 * Once its `it_visible` WS backfill lands, the bar carries the FULL pipeline
 * breakdown, so we can report the honest end-to-end, not just the tail:
 *
 *   endToEnd = network + server_transport + sdk + flush + vm_overhead + it_poll
 *              └ parse ┘ └ SPCS↔VM tunnel ┘  └ received → committed ┘ └ →queryable ┘
 *
 * `server_transport_ms` (SPCS handler + cross-cloud SPCS↔VM/cloudflared) is added
 * ONLY for ws bars — on client bars the measured `network_ms` already includes
 * that transport, so adding it there would double-count.
 *
 * Anchor note: for ws (Live Market) bars, `network_ms` is the SPCS request-parse
 * time (~0 ms), NOT the browser→VM hop — the server can't see the browser's
 * round-trip. So this end-to-end is effectively "event received at the server →
 * queryable on the interactive WH" (the pipeline-from-produce anchor). The manual
 * "click → on-screen" widget adds the real browser→VM network + the paint on top.
 *
 * `visibilityP50` isolates just the commit→queryable segment, and
 * `serverTransportP50` the SPCS↔VM transport, so the UI can show the breakdown.
 *
 * Confirmed-only: bars whose probe gave up (it_poll_confirmed === false) carry a
 * floor, not a real latency, so they're excluded.
 */
export interface LiveLatency {
  endToEndP50: number | null;
  endToEndP90: number | null;
  endToEndP95: number | null;
  endToEndP99: number | null;
  endToEndLast: number | null;
  visibilityP50: number | null;
  serverTransportP50: number | null;
  /** Per-segment medians (ms) for the breakdown display. */
  seg: {
    network: number | null; // SPCS request parse (~0 on ws bars)
    transport: number | null; // SPCS↔VM tunnel (ws bars only)
    appendVm: number | null; // sdk_appended + vm_overhead
    flush: number | null; // HPA flush/commit
    visibility: number | null; // commit→queryable (it_poll)
  };
  count: number;
  confirmedPct: number | null;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** Percentile from an UNSORTED array (sorts a copy). Nearest-rank, clamped. */
function pct(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

/** SPCS↔VM transport counts only for ws bars (client network_ms already has it). */
function transportOf(b: LatencyBar): number {
  return b.source === "ws" ? b.server_transport_ms ?? 0 : 0;
}

function e2e(b: LatencyBar): number {
  return (
    b.network_ms +
    transportOf(b) +
    b.sdk_appended_ms +
    b.flush_committed_ms +
    b.vm_overhead_ms +
    b.it_poll_ms
  );
}

export function computeLiveLatency(bars: LatencyBar[]): LiveLatency {
  const probed = bars.filter((b) => b.it_poll_ms > 0);
  const confirmed = probed.filter((b) => b.it_poll_confirmed !== false);
  const e2es = confirmed.map(e2e);
  return {
    endToEndP50: median(e2es),
    endToEndP90: pct(e2es, 90),
    endToEndP95: pct(e2es, 95),
    endToEndP99: pct(e2es, 99),
    endToEndLast: confirmed.length ? e2e(confirmed[confirmed.length - 1]) : null,
    visibilityP50: median(confirmed.map((b) => b.it_poll_ms)),
    serverTransportP50: median(confirmed.map(transportOf)),
    seg: {
      network: median(confirmed.map((b) => b.network_ms)),
      transport: median(confirmed.map(transportOf)),
      appendVm: median(confirmed.map((b) => b.sdk_appended_ms + b.vm_overhead_ms)),
      flush: median(confirmed.map((b) => b.flush_committed_ms)),
      visibility: median(confirmed.map((b) => b.it_poll_ms)),
    },
    count: confirmed.length,
    confirmedPct: probed.length ? (confirmed.length / probed.length) * 100 : null,
  };
}

/** Compact ms → "x.xx s" once past a second, else "N ms". Shared everywhere. */
export function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(0)} ms`;
}
