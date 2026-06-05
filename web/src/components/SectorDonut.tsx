"use client";

import { useMemo } from "react";
import {
  Chart as ChartJS,
  ArcElement,
  Tooltip,
  Legend,
} from "chart.js";
import { Doughnut } from "react-chartjs-2";
import { useDashboardStore } from "@/lib/store";
import { useRenderTiming } from "@/lib/useRenderTiming";
import { SkeletonCard } from "./SkeletonCard";

ChartJS.register(ArcElement, Tooltip, Legend);

const SECTOR_COLORS = [
  "#29B5E8", // snow blue
  "#34D399", // emerald
  "#FBBF24", // amber
  "#F472B6", // pink
  "#A78BFA", // violet
  "#FB923C", // orange
  "#4ADE80", // green
  "#38BDF8", // sky
  "#E879F9", // fuchsia
  "#FDE047", // yellow
];

export function SectorDonut() {
  const sector = useDashboardStore((s) => s.sector);
  const isInitialLoad = useDashboardStore((s) => s.isInitialLoad);
  useRenderTiming("SectorDonut", sector);

  const chartData = useMemo(() => ({
    labels: sector.map((r) => r.sector),
    datasets: [
      {
        data: sector.map((r) => r.total_par),
        backgroundColor: SECTOR_COLORS.slice(0, sector.length),
        borderColor: "#0f172a",
        borderWidth: 2,
      },
    ],
  }), [sector]);

  const options = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      cutout: "45%",
      plugins: {
        legend: {
          position: "right" as const,
          labels: { color: "#e2e8f0", font: { size: 10 }, padding: 8 },
        },
        tooltip: {
          callbacks: {
            label: (ctx: { label: string; raw: unknown }) => {
              const val = ctx.raw as number;
              return `${ctx.label}: $${(val / 1e6).toFixed(1)}M`;
            },
          },
        },
      },
    }),
    []
  );

  if (sector.length === 0 && isInitialLoad) {
    return <SkeletonCard height="260px" />;
  }

  if (sector.length === 0) {
    return (
      <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-6 text-center text-sm text-slate-400">
        Waiting for sector data...
      </div>
    );
  }

  return (
    <div className="h-[260px]">
      <Doughnut data={chartData} options={options} />
    </div>
  );
}
