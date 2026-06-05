"use client";

import { useDashboardStore } from "@/lib/store";

export function LatencyStats() {
  const bars = useDashboardStore((s) => s.latencyBars);
  if (bars.length === 0) return null;

  const completed = bars.filter((b) => b.it_poll_ms > 0);
  if (completed.length === 0) return null;

  const totals = completed
    .map((b) => b.network_ms + b.sdk_appended_ms + b.flush_committed_ms + b.it_poll_ms + b.render_ms)
    .sort((a, b) => a - b);
  const flushes = completed.map((b) => b.flush_committed_ms).sort((a, b) => a - b);
  const renders = completed.map((b) => b.render_ms).sort((a, b) => a - b);

  const median = (arr: number[]) => arr[Math.floor(arr.length / 2)];

  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mt-3">
      <Stat label="Events fired" value={bars.length.toString()} />
      <Stat
        label="Median click → painted"
        value={`${median(totals).toFixed(0)}ms`}
        emphasis
      />
      <Stat label="Min" value={`${totals[0].toFixed(0)}ms`} />
      <Stat label="Max" value={`${totals[totals.length - 1].toFixed(0)}ms`} />
      <Stat label="Median HPA flush" value={`${median(flushes).toFixed(0)}ms`} />
      <Stat label="Median React render" value={`${median(renders).toFixed(1)}ms`} accent />
    </div>
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
