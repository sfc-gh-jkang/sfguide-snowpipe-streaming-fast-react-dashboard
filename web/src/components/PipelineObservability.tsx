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
        Server-side health from <code className="text-slate-300">{PUBLIC_APP_FQN}.RAW_EVENTS</code>, refreshed
        every 5 s. Note: the VM stamps <code>EVENT_TS = INGESTED_TS</code>, so the two age metrics below
        measure <strong>data staleness / how busy the stream is</strong>, not pipeline latency — they climb
        when the desk is idle and drop toward ~0 under load (turn on Live Market).
      </p>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <MetricTile
          label="Data age p50 (last 5m)"
          primary={stats ? `${stats.p50_ms}s` : "—"}
          sub={
            stats
              ? `median seconds since each event was produced · p95 ${stats.p95_ms}s · p99 ${stats.p99_ms}s · n=${stats.event_count}`
              : "no events in the last 5 min — fire events / Live Market"
          }
          emphasis
        />
        <MetricTile
          label="Data age (newest row)"
          primary={`${obs.it_lag_seconds.toFixed(0)}s`}
          sub="SYSDATE − MAX(EVENT_TS) = age of the freshest row. Interactive Tables have no refresh — this is idle time, ~0 under load"
        />
        <MetricTile
          label="Throughput"
          primary={`${obs.throughput_evt_per_min.toFixed(1)} evt/min`}
          sub="rolling 5-min avg (the Events/sec tile up top shows the live 30 s rate)"
        />
        <MetricTile
          label="Total Events (24h)"
          primary={fmtNumber(obs.total_events_24h)}
          sub="EVENT_TS within the last 24h (excludes warmup/seed)"
        />
      </div>
    </div>
  );
}
