"use client";

import { useMemo } from "react";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Tooltip,
  Legend,
  type Chart as ChartInstance,
} from "chart.js";
import { Bar } from "react-chartjs-2";
import { useDashboardStore } from "@/lib/store";
import { useRenderTiming } from "@/lib/useRenderTiming";

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip, Legend);

const SEGMENT_COLORS = {
  network: "#67E8F9", // cyan-300
  sdk_append: "#34D399", // emerald-400
  hpa_flush: "#29B5E8", // Snowflake brand blue
  vm_overhead: "#94A3B8", // slate-400 — VM handler overhead (parse/book/response)
  it_poll: "#FBBF24", // amber-400
  render: "#A78BFA", // violet-400 — React diff/paint (the win vs Streamlit)
};

// Inline plugin: draws "Nms" labels on each segment of every stacked bar.
// For very thin segments (<3px), draws the label outside the bar with a leader line.
const segmentLabelsPlugin = {
  id: "segmentLabels",
  afterDatasetsDraw(chart: ChartInstance) {
    const { ctx, scales } = chart;
    const yScale = scales.y;
    if (!yScale) return;

    ctx.save();
    ctx.font = "10px ui-sans-serif, system-ui";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    chart.data.datasets.forEach((dataset, datasetIdx) => {
      const meta = chart.getDatasetMeta(datasetIdx);
      meta.data.forEach((bar, idx) => {
        const raw = dataset.data[idx] as number | null;
        if (raw == null || raw <= 0) return;

        const barAny = bar as unknown as { x: number; y: number; base: number };
        const segHeight = Math.abs(barAny.base - barAny.y);
        const labelText = raw < 1 ? `${raw.toFixed(2)}ms` : `${Math.round(raw)}ms`;

        if (segHeight >= 14) {
          // Centered inside the segment
          ctx.fillStyle = "#0f172a";
          ctx.fillText(labelText, barAny.x, (barAny.y + barAny.base) / 2);
        } else {
          // Too thin — draw label to the right of the bar with a leader
          const labelX = barAny.x + 32;
          const labelY = (barAny.y + barAny.base) / 2;
          ctx.strokeStyle = "#475569";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(barAny.x + 8, labelY);
          ctx.lineTo(labelX - 4, labelY);
          ctx.stroke();
          ctx.fillStyle = "#cbd5e1";
          ctx.textAlign = "left";
          ctx.fillText(labelText, labelX, labelY);
          ctx.textAlign = "center";
        }
      });
    });

    ctx.restore();
  },
};

ChartJS.register(segmentLabelsPlugin);

export function LatencyTimeline() {
  const latencyBars = useDashboardStore((s) => s.latencyBars);
  // Measure Chart.js render-and-paint time on every data update.
  // All samples are appended; median is robust to the cold-mount outlier
  // without explicit filtering (matches useRenderTiming.ts comment).
  useRenderTiming("LatencyTimeline", latencyBars);

  const chartData = useMemo(() => {
    const labels = latencyBars.map((b) => b.label);
    return {
      labels,
      datasets: [
        {
          label: "1 · Network",
          data: latencyBars.map((b) => b.network_ms),
          backgroundColor: SEGMENT_COLORS.network,
          borderColor: "#0f172a",
          borderWidth: 1,
        },
        {
          label: "2 · HPA SDK append",
          data: latencyBars.map((b) => b.sdk_appended_ms),
          backgroundColor: SEGMENT_COLORS.sdk_append,
          borderColor: "#0f172a",
          borderWidth: 1,
        },
        {
          label: "3 · HPA flush",
          data: latencyBars.map((b) => b.flush_committed_ms),
          backgroundColor: SEGMENT_COLORS.hpa_flush,
          borderColor: "#0f172a",
          borderWidth: 1,
        },
        {
          // VM handler time not in append/flush: parse + book recompute +
          // concurrency excess + response build. Makes the stack sum to the
          // real click→POST-done round-trip (network + sdk + flush + this).
          label: "4 · VM overhead",
          data: latencyBars.map((b) => b.vm_overhead_ms),
          backgroundColor: SEGMENT_COLORS.vm_overhead,
          borderColor: "#0f172a",
          borderWidth: 1,
        },
        {
          // Optimistic paint fires at flush-ack (before the row is queryable in
          // the IT) — drawn ahead of the verify segment.
          label: "5 · React render (optimistic paint)",
          data: latencyBars.map((b) => b.render_ms),
          backgroundColor: SEGMENT_COLORS.render,
          borderColor: "#0f172a",
          borderWidth: 1,
        },
        {
          // IT visibility arrives async via WS `it_visible`; it overlaps the
          // paint above, so click → verified wall-clock = 1+2+3+4+6 (not +render).
          label: "6 · IT poll (verify · concurrent)",
          data: latencyBars.map((b) => b.it_poll_ms),
          backgroundColor: SEGMENT_COLORS.it_poll,
          borderColor: "#0f172a",
          borderWidth: 1,
        },
      ],
    };
  }, [latencyBars]);

  const options = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      animation: false as const,
      plugins: {
        legend: {
          position: "top" as const,
          labels: { color: "#e2e8f0", font: { size: 11 } },
        },
        tooltip: {
          callbacks: {
            label: (ctx: { dataset: { label?: string }; raw: unknown }) =>
              `${ctx.dataset.label}: ${(ctx.raw as number).toFixed(2)} ms`,
            footer: (items: Array<{ raw: unknown }>) => {
              const total = items.reduce(
                (s, i) => s + ((i.raw as number) || 0),
                0
              );
              return `Total: ${total.toFixed(0)} ms`;
            },
          },
        },
      },
      scales: {
        x: {
          stacked: true,
          ticks: { color: "#cbd5e1", font: { size: 10 } },
          grid: { display: false },
          title: {
            display: true,
            text: "Click sequence (oldest → newest)",
            color: "#94a3b8",
            font: { size: 11 },
          },
        },
        y: {
          stacked: true,
          ticks: { color: "#cbd5e1", font: { size: 10 } },
          grid: { color: "#1e293b" },
          title: {
            display: true,
            text: "Latency (ms)",
            color: "#94a3b8",
            font: { size: 11 },
          },
        },
      },
    }),
    []
  );

  if (latencyBars.length === 0) {
    return (
      <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-8 text-center text-sm text-slate-400">
        Fire a few events from the Generator below — each click adds a stacked
        bar showing the latency breakdown.
      </div>
    );
  }

  return (
    <div className="h-[340px]">
      <Bar data={chartData} options={options} />
    </div>
  );
}
