"use client";

import { useDashboardStore } from "@/lib/store";

export function HpaStatus() {
  const hpaStatus = useDashboardStore((s) => s.hpaStatus);

  const statusColor =
    hpaStatus.status === "healthy"
      ? "text-green-400"
      : hpaStatus.status === "degraded"
      ? "text-amber-400"
      : hpaStatus.status === "unreachable"
      ? "text-red-400"
      : "text-slate-500";

  const statusDot =
    hpaStatus.status === "healthy"
      ? "bg-green-400"
      : hpaStatus.status === "degraded"
      ? "bg-amber-400"
      : hpaStatus.status === "unreachable"
      ? "bg-red-400"
      : "bg-slate-500";

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-3">
      <h4 className="text-xs text-slate-400 font-medium mb-2">HPA Status</h4>
      <div className="flex items-center gap-2">
        <span
          className={`inline-block w-2 h-2 rounded-full ${statusDot} ${
            hpaStatus.status === "healthy" ? "" : "animate-pulse"
          }`}
        />
        <span className={`text-xs font-medium ${statusColor}`}>
          {hpaStatus.status === "unknown" ? "Connecting..." : hpaStatus.status}
        </span>
      </div>
      {hpaStatus.channel_count > 0 && (
        <p className="text-xs text-slate-500 mt-1">
          {hpaStatus.channel_count} channels · {hpaStatus.pipe_name || "—"}
          <br />
          <span className="text-slate-600">+ POSITION_BOOK-STREAMING (parallel write-through)</span>
        </p>
      )}
    </div>
  );
}
