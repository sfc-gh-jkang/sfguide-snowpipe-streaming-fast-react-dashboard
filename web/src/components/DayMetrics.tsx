"use client";

import { useDashboardStore } from "@/lib/store";
import { SkeletonCard } from "./SkeletonCard";

function formatNotional(value: number): string {
  if (value >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

export function DayMetrics() {
  const dayMetrics = useDashboardStore((s) => s.dayMetrics);
  const isInitialLoad = useDashboardStore((s) => s.isInitialLoad);

  if (!dayMetrics && isInitialLoad) {
    return (
      <div className="grid grid-cols-4 gap-3 mb-4">
        <SkeletonCard height="72px" />
        <SkeletonCard height="72px" />
        <SkeletonCard height="72px" />
        <SkeletonCard height="72px" />
      </div>
    );
  }

  if (!dayMetrics) return null;

  const tiles = [
    { label: "Events (last 24h)", value: dayMetrics.events_today.toLocaleString() },
    { label: "Events/sec (30s)", value: dayMetrics.evt_per_sec_30s.toFixed(1) },
    { label: "Peak burst/s", value: dayMetrics.peak_burst_per_sec.toLocaleString() },
    { label: "Notional Today", value: formatNotional(dayMetrics.total_notional_today) },
  ];

  return (
    <div className="grid grid-cols-4 gap-3 mb-4">
      {tiles.map((tile) => (
        <div
          key={tile.label}
          className="rounded-lg border border-slate-700 bg-slate-800/50 px-3 py-2"
        >
          <div className="text-[10px] uppercase tracking-wider text-slate-400">
            {tile.label}
          </div>
          <div className="text-lg font-semibold text-white mt-0.5">
            {tile.value}
          </div>
        </div>
      ))}
    </div>
  );
}
