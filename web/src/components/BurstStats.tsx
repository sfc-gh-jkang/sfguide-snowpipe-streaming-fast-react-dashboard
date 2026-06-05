"use client";

import { useMemo } from "react";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Tooltip,
} from "chart.js";
import { Bar } from "react-chartjs-2";
import { useDashboardStore } from "@/lib/store";

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip);

const NUM_BINS = 20;

function computeHistogram(values: number[], bins: number) {
  if (values.length === 0) return { labels: [], counts: [] };
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const binWidth = range / bins;

  const counts = new Array(bins).fill(0);
  for (const v of values) {
    const idx = Math.min(Math.floor((v - min) / binWidth), bins - 1);
    counts[idx]++;
  }
  const labels = counts.map(
    (_, i) => `${(min + i * binWidth).toFixed(0)}`
  );
  return { labels, counts };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function BurstStats() {
  const burstResult = useDashboardStore((s) => s.burstResult);

  const stats = useMemo(() => {
    if (!burstResult || burstResult.latencies_ms.length === 0) return null;
    const sorted = [...burstResult.latencies_ms].sort((a, b) => a - b);
    return {
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      max: sorted[sorted.length - 1],
    };
  }, [burstResult]);

  const histogram = useMemo(() => {
    if (!burstResult) return null;
    return computeHistogram(burstResult.latencies_ms, NUM_BINS);
  }, [burstResult]);

  if (!burstResult || !stats || !histogram) return null;

  const chartData = {
    labels: histogram.labels,
    datasets: [
      {
        label: "Events",
        data: histogram.counts,
        backgroundColor: "#29B5E8",
        borderColor: "#0f172a",
        borderWidth: 1,
      },
    ],
  };

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 200 },
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          title: (items: Array<{ label: string }>) =>
            `~${items[0]?.label ?? ""}ms`,
          label: (ctx: { raw: unknown }) => `${ctx.raw} events`,
        },
      },
    },
    scales: {
      x: {
        ticks: { color: "#94a3b8", font: { size: 9 }, maxRotation: 45 },
        grid: { display: false },
        title: {
          display: true,
          text: "Latency (ms)",
          color: "#94a3b8",
          font: { size: 10 },
        },
      },
      y: {
        ticks: { color: "#94a3b8", font: { size: 9 } },
        grid: { color: "#1e293b" },
        title: {
          display: true,
          text: "Count",
          color: "#94a3b8",
          font: { size: 10 },
        },
      },
    },
  };

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-3 mt-2">
      <h4 className="text-xs text-slate-400 font-medium mb-2">
        Burst Result — {burstResult.count} events
      </h4>

      {/* KPI tiles */}
      <div className="grid grid-cols-4 gap-2 mb-3">
        {([
          { label: "p50", value: stats.p50 },
          { label: "p95", value: stats.p95 },
          { label: "p99", value: stats.p99 },
          { label: "max", value: stats.max },
        ] as const).map(({ label, value }) => (
          <div
            key={label}
            className="rounded bg-slate-900/60 border border-slate-700 p-2 text-center"
          >
            <div className="text-[10px] uppercase tracking-wide text-slate-500">
              {label}
            </div>
            <div className="text-sm font-mono text-slate-200">
              {value.toFixed(0)}
              <span className="text-[10px] text-slate-400">ms</span>
            </div>
          </div>
        ))}
      </div>

      {/* Histogram */}
      <div className="h-[120px]">
        <Bar data={chartData} options={chartOptions} />
      </div>
    </div>
  );
}
