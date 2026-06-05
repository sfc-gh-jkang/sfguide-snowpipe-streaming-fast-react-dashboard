"use client";

import { useDashboardStore } from "@/lib/store";
import { PUBLIC_APP_FQN } from "@/lib/constants";

function MetricTile({
  label,
  primary,
  sub,
  emphasis = false,
}: {
  label: string;
  primary: string;
  sub?: string;
  emphasis?: boolean;
}) {
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800/50 px-4 py-3">
      <div className="text-[10px] uppercase tracking-wide text-slate-400">{label}</div>
      <div
        className={`text-lg font-mono mt-1 ${
          emphasis ? "text-snow-blue font-semibold" : "text-slate-100"
        }`}
      >
        {primary}
      </div>
      {sub && <div className="text-[10px] text-slate-500 mt-0.5">{sub}</div>}
    </div>
  );
}

function fmtNumber(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString();
}

export function PipelineObservability() {
  const obs = useDashboardStore((s) => s.observability);
  const stats = obs.ingest_stats;

  return (
    <div>
      <h2 className="text-lg font-semibold mb-3">Pipeline Observability</h2>
      <p className="text-xs text-slate-400 mb-3">
        Server-side health metrics across the streaming pipeline. Refreshed every 5 seconds from
        <code className="text-slate-300"> {PUBLIC_APP_FQN}.RAW_EVENTS</code>.
      </p>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <MetricTile
          label="Event freshness p50 (5m)"
          primary={stats ? `${stats.p50_ms}s` : "—"}
          sub={
            stats
              ? `p95 ${stats.p95_ms}s · p99 ${stats.p99_ms}s · ${stats.event_count} events`
              : "no events in window"
          }
          emphasis
        />
        <MetricTile
          label="IT Refresh Lag"
          primary={`${obs.it_lag_seconds.toFixed(0)}s`}
          sub="MAX(latest_event_ts) → now"
        />
        <MetricTile
          label="Throughput"
          primary={`${obs.throughput_evt_per_min.toFixed(1)} evt/min`}
          sub="rolling 5-minute window"
        />
        <MetricTile
          label="Total Events (24h)"
          primary={fmtNumber(obs.total_events_24h)}
          sub="EVENT_TS within DATEADD(-24h)"
        />
      </div>
    </div>
  );
}
