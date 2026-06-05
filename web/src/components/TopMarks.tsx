"use client";

import { useDashboardStore } from "@/lib/store";
import { SkeletonCard } from "./SkeletonCard";

export function TopMarks() {
  const topmarks = useDashboardStore((s) => s.topmarks);
  const isInitialLoad = useDashboardStore((s) => s.isInitialLoad);

  if (topmarks.length === 0 && isInitialLoad) {
    return <SkeletonCard height="260px" />;
  }

  if (topmarks.length === 0) {
    return (
      <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-6 text-center text-sm text-slate-400">
        Waiting for mark data...
      </div>
    );
  }

  return (
    <div className="overflow-auto max-h-[260px] rounded-lg border border-slate-700">
      <table className="w-full text-left">
        <thead className="sticky top-0 bg-slate-800 border-b border-slate-700">
          <tr>
            <th className="px-2 py-1.5 text-xs text-slate-400 font-medium">
              Issuer
            </th>
            <th className="px-2 py-1.5 text-xs text-slate-400 font-medium">
              Sector
            </th>
            <th className="px-2 py-1.5 text-xs text-slate-400 font-medium text-right">
              Mark
            </th>
            <th className="px-2 py-1.5 text-xs text-slate-400 font-medium text-right">
              Chg (bps)
            </th>
            <th className="px-2 py-1.5 text-xs text-slate-400 font-medium text-right">
              P&L
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800">
          {topmarks.map((row, idx) => (
            <tr key={`${row.issuer}-${idx}`} className="hover:bg-slate-800/50">
              <td className="px-2 py-1 text-xs">{row.issuer}</td>
              <td className="px-2 py-1 text-xs text-slate-400">{row.sector}</td>
              <td className="px-2 py-1 text-xs text-right font-mono">
                {row.current_mark.toFixed(2)}
              </td>
              <td
                className={`px-2 py-1 text-xs text-right font-mono ${
                  row.mark_change_bps >= 0 ? "text-green-400" : "text-red-400"
                }`}
              >
                {row.mark_change_bps > 0 ? "+" : ""}
                {row.mark_change_bps.toFixed(0)}
              </td>
              <td
                className={`px-2 py-1 text-xs text-right font-mono ${
                  row.pnl_today >= 0 ? "text-green-400" : "text-red-400"
                }`}
              >
                ${row.pnl_today.toLocaleString("en-US", { maximumFractionDigits: 0 })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
