"use client";

import { useDashboardStore } from "@/lib/store";

function fmtCurrency(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

export function Watchlist() {
  const rows = useDashboardStore((s) => s.observability.watchlist);

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800/50 overflow-hidden">
      <div className="px-3 py-2 border-b border-slate-700 flex justify-between items-baseline">
        <h3 className="text-sm font-medium text-slate-200">Credit Watchlist</h3>
        <span className="text-xs text-slate-400">
          {rows.length} {rows.length === 1 ? "position" : "positions"}
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="px-3 py-6 text-center text-xs text-slate-400">
          No watchlist positions
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-900/60">
              <tr>
                <th className="px-2 py-1.5 text-left text-slate-400 font-medium">Issuer</th>
                <th className="px-2 py-1.5 text-left text-slate-400 font-medium">Rating</th>
                <th className="px-2 py-1.5 text-left text-slate-400 font-medium">Sector</th>
                <th className="px-2 py-1.5 text-right text-slate-400 font-medium">Par</th>
                <th className="px-2 py-1.5 text-right text-slate-400 font-medium">Mark</th>
                <th className="px-2 py-1.5 text-right text-slate-400 font-medium">P&amp;L</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {rows.map((r) => (
                <tr key={r.position_id} className="hover:bg-slate-800/40">
                  <td className="px-2 py-1">{r.issuer}</td>
                  <td className="px-2 py-1 font-mono text-slate-300">{r.rating}</td>
                  <td className="px-2 py-1 text-slate-400">{r.sector}</td>
                  <td className="px-2 py-1 text-right font-mono">{fmtCurrency(r.par_amount)}</td>
                  <td className="px-2 py-1 text-right font-mono">{r.current_mark?.toFixed(2)}</td>
                  <td
                    className={`px-2 py-1 text-right font-mono ${
                      r.pnl_today > 0
                        ? "text-green-400"
                        : r.pnl_today < 0
                        ? "text-red-400"
                        : "text-slate-300"
                    }`}
                  >
                    {fmtCurrency(r.pnl_today)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
