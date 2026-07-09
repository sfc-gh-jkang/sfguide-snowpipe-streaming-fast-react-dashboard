"use client";

import { useDashboardStore } from "@/lib/store";

export function LatencyStats() {
  const bars = useDashboardStore((s) => s.latencyBars);
  if (bars.length === 0) return null;

  // Client-measured + IT-confirmed bars only. WS-path (MarketSimulator) bars
  // lack real client network/render; unconfirmed probes report a give-up floor.
  const completed = bars.filter(
    (b) => b.source === "client" && b.it_poll_ms > 0 && b.it_poll_confirmed !== false
  );
  if (completed.length === 0) return null;

  // click → row verified-visible in the IT = network + sdk + flush(max raw,book)
  // + VM overhead + IT visibility. Render (optimistic paint) fires at flush-ack
  // and overlaps the it_poll verify window, so it is NOT added here — it is
  // reported separately below as the paint milestone.
  const totals = completed
    .map(
      (b) =>
        b.network_ms +
        b.sdk_appended_ms +
        b.flush_committed_ms +
        b.vm_overhead_ms +
        b.it_poll_ms
    )
    .sort((a, b) => a - b);
  const renders = completed.map((b) => b.render_ms).sort((a, b) => a - b);

  const median = (arr: number[]) => arr[Math.floor(arr.length / 2)];
  const pct = (arr: number[], p: number) =>
    arr.length ? arr[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))] : 0;

  return (
    <>
    <div className="grid grid-cols-2 md:grid-cols-6 gap-2 mt-3">
      <Stat label="Events (client)" value={completed.length.toString()} />
      <Stat
        label="p50 click → verified"
        value={`${median(totals).toFixed(0)}ms`}
        emphasis
      />
      <Stat label="p95" value={`${pct(totals, 95).toFixed(0)}ms`} />
      <Stat label="p99" value={`${pct(totals, 99).toFixed(0)}ms`} />
      <Stat label="Max" value={`${totals[totals.length - 1].toFixed(0)}ms`} />
      <Stat label="Optimistic paint p50" value={`${median(renders).toFixed(1)}ms`} accent />
    </div>
    <p className="text-[10px] text-slate-500 mt-1">
      Click → verified = network + SDK + flush + VM overhead + IT-visibility
      (flush = max of the concurrent RAW/POSITION_BOOK commits; client-fired,
      IT-confirmed events only; n={completed.length}). The optimistic paint fires
      at flush-ack (before the IT confirms) and overlaps the IT-visibility window,
      so it is shown as a milestone, not added to the total.
    </p>
    </>
  );
}

function Stat({
  label,
  value,
  emphasis = false,
  accent = false,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
  accent?: boolean;
}) {
  return (
    <div className="rounded border border-slate-700 bg-slate-800/40 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-slate-400">{label}</div>
      <div
        className={`text-sm font-mono mt-0.5 ${
          emphasis
            ? "text-snow-blue font-semibold"
            : accent
            ? "text-violet-300 font-semibold"
            : "text-slate-200"
        }`}
      >
        {value}
      </div>
    </div>
  );
}
