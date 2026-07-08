"use client";

import { useDashboardStore } from "@/lib/store";
import { formatAge } from "@/lib/age";
import { SkeletonCard } from "./SkeletonCard";
import type { Event } from "@/lib/types";

function TapeRow({ event }: { event: Event }) {
  const isPending = event.status === "pending";
  return (
    <tr
      className={`${isPending ? "tape-row-pending border-l-2 border-yellow-500" : "tape-row-verified"}`}
      data-testid={`tape-row-${event.event_id}`}
      data-status={event.status}
    >
      <td className="px-2 py-1 text-xs font-mono whitespace-nowrap">
        {event.ingested_ts
          ? new Date(event.ingested_ts).toLocaleTimeString()
          : "—"}
      </td>
      <td className="px-2 py-1 text-xs">
        <span
          className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold ${
            event.event_type === "TRADE"
              ? "bg-sky-900/50 text-sky-300"
              : event.event_type === "MARK"
              ? "bg-amber-900/50 text-amber-300"
              : "bg-red-900/50 text-red-300"
          }`}
        >
          {event.event_type}
        </span>
      </td>
      <td className="px-2 py-1 text-xs">{event.issuer || event.position_id}</td>
      <td className="px-2 py-1 text-xs">{event.sector || "—"}</td>
      <td className="px-2 py-1 text-xs text-right">
        {event.latency_ms != null ? formatAge(event.latency_ms / 1000) : "—"}
      </td>
      <td className="px-2 py-1 text-xs text-center">
        {isPending ? (
          <span className="inline-flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full bg-yellow-400 animate-pulse" />
            <span className="text-[10px] text-yellow-400 font-medium">pending</span>
          </span>
        ) : (
          <span className="text-green-400">✓</span>
        )}
      </td>
    </tr>
  );
}

const TIME_TRAVEL_OPTIONS = [
  { label: "Now", offset: 0 },
  { label: "-30s", offset: 30 },
  { label: "-1m", offset: 60 },
  { label: "-5m", offset: 300 },
];

export function LiveTape() {
  const tape = useDashboardStore((s) => s.tape);
  const isInitialLoad = useDashboardStore((s) => s.isInitialLoad);
  const timeTravelOffset = useDashboardStore((s) => s.timeTravelOffset);
  const setTimeTravelOffset = useDashboardStore((s) => s.setTimeTravelOffset);
  const optimisticEnabled = useDashboardStore((s) => s.optimisticEnabled);
  const setOptimisticEnabled = useDashboardStore((s) => s.setOptimisticEnabled);

  return (
    <div>
      {/* Tape header with time-travel + optimistic toggle */}
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium text-slate-300">
          Live Event Tape
        </h3>
        <div className="flex items-center gap-3">
          {/* Optimistic preview toggle */}
          <label
            className="flex items-center gap-1.5 cursor-pointer text-xs text-slate-400"
            title="When ON, clicking a fire button instantly prepends a grey 'pending' row to the tape (~10 ms paint) before the data lands in the Interactive Table. The row turns green ('verified') once the snapshot poll confirms it. Lets the tape feel instant despite the ~1.5-1.8 s IT visibility lag. When OFF, the tape only updates when the next snapshot poll fetches the row from the IT — feels laggier but is strictly read-from-database honest."
          >
            <input
              type="checkbox"
              checked={optimisticEnabled}
              onChange={(e) => setOptimisticEnabled(e.target.checked)}
              className="accent-yellow-500 w-3 h-3"
            />
            Optimistic preview
            <span className="text-slate-500 cursor-help">ⓘ</span>
          </label>

          {/* Time-travel buttons */}
          <div
            className="flex items-center gap-1"
            title="Replay the dashboard at a past point in time. Pauses live polling and queries RAW_EVENTS AT(OFFSET => -<seconds>) using Snowflake Time Travel (Interactive Tables support Time Travel even under continuous streaming writes). 'Now' resumes live mode. Useful for showing 'where the book was 30 s / 1 min / 5 min ago' without losing position — no extra storage cost."
          >
            <span className="text-[10px] text-slate-500 mr-1 cursor-help">Time travel ⓘ</span>
            {TIME_TRAVEL_OPTIONS.map((opt) => (
              <button
                key={opt.offset}
                onClick={() => setTimeTravelOffset(opt.offset)}
                className={`px-2 py-0.5 text-[10px] font-medium rounded transition-colors ${
                  timeTravelOffset === opt.offset
                    ? "bg-snow-blue text-white"
                    : "bg-slate-700 text-slate-400 hover:bg-slate-600"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Time-travel banner */}
      {timeTravelOffset > 0 && (
        <div className="mb-2 rounded-md border border-yellow-600 bg-yellow-900/40 px-3 py-1.5 text-xs text-yellow-200 font-medium">
          VIEWING HISTORICAL DATA (-{timeTravelOffset}s) — polling paused, showing time-travel snapshot
        </div>
      )}

      {tape.length === 0 && isInitialLoad ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <SkeletonCard key={i} height="32px" />
          ))}
        </div>
      ) : tape.length === 0 ? (
        <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-6 text-center text-sm text-slate-400">
          No events yet — click a generator button.
        </div>
      ) : (
        <div className="overflow-auto max-h-[580px] rounded-lg border border-slate-700">
          <table className="w-full text-left">
            <thead className="sticky top-0 bg-slate-800 border-b border-slate-700">
              <tr>
                <th className="px-2 py-1.5 text-xs text-slate-400 font-medium">
                  Time
                </th>
                <th className="px-2 py-1.5 text-xs text-slate-400 font-medium">
                  Type
                </th>
                <th className="px-2 py-1.5 text-xs text-slate-400 font-medium">
                  Issuer
                </th>
                <th className="px-2 py-1.5 text-xs text-slate-400 font-medium">
                  Sector
                </th>
                <th className="px-2 py-1.5 text-xs text-slate-400 font-medium text-right">
                  Age
                </th>
                <th className="px-2 py-1.5 text-xs text-slate-400 font-medium text-center">
                  Status
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {tape.map((event) => (
                <TapeRow key={event.event_id} event={event} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-slate-500 mt-1">
        {tape.length} events · Last 30
      </p>
    </div>
  );
}
