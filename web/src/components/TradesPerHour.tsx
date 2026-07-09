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

export function TradesPerHour() {
  const rows = useDashboardStore((s) => s.observability.hourly_trades);

  const chartData = useMemo(
    () => ({
      labels: rows.map((r) => {
        const d = new Date(r.hour);
        return isNaN(d.getTime())
          ? r.hour.slice(0, 16)
          : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      }),
      datasets: [
        {
          label: "Trades",
          data: rows.map((r) => r.trade_count),
          backgroundColor: "#29B5E8",
          borderColor: "#0f172a",
          borderWidth: 1,
        },
      ],
    }),
    [rows]
  );

  const options = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 200 },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx: { raw: unknown }) => `${ctx.raw as number} trades`,
          },
        },
      },
      scales: {
        x: {
          ticks: { color: "#cbd5e1", font: { size: 9 } },
          grid: { display: false },
        },
        y: {
          beginAtZero: true,
          ticks: { color: "#cbd5e1", font: { size: 9 }, precision: 0 },
          grid: { color: "#1e293b" },
        },
      },
    }),
    []
  );

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800/50 overflow-hidden">
      <div className="px-3 py-2 border-b border-slate-700">
        <h3 className="text-sm font-medium text-slate-200" title="TRADE events bucketed by hour over the last 24h (DATE_TRUNC('hour', EVENT_TS)) — trade activity over the session.">Trades per Hour (last 24h)</h3>
      </div>
      {rows.length === 0 ? (
        <div className="px-3 py-6 text-center text-xs text-slate-400">No trades yet</div>
      ) : (
        <div className="h-[200px] p-3">
          <Bar data={chartData} options={options} />
        </div>
      )}
    </div>
  );
}
