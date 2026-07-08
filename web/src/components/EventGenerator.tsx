"use client";

import { useState, useCallback } from "react";
import type { IngestResponse } from "@/lib/types";
import { useDashboardStore } from "@/lib/store";

interface DebugTimings {
  t_post_done_ms: number;
  vm_total_handler_ms: number;
  /**
   * Background IT visibility lag, arrives via WS `it_visible` AFTER POST returns.
   * Null until the WS message lands; "(background)" displayed in the meantime.
   */
  it_poll_ms: number | null;
  render_ms: number;
  visible_total_ms: number;
}

export function EventGenerator() {
  const [loading, setLoading] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<IngestResponse | null>(null);
  const [lastTimings, setLastTimings] = useState<DebugTimings | null>(null);
  const [lastEventId, setLastEventId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const addLatencyBar = useDashboardStore((s) => s.addLatencyBar);
  const updateLatencyBar = useDashboardStore((s) => s.updateLatencyBar);
  const addOptimisticEvent = useDashboardStore((s) => s.addOptimisticEvent);
  const optimisticEnabled = useDashboardStore((s) => s.optimisticEnabled);
  // Watch latencyBars so the diagnostic strip's IT-poll value updates when
  // the async `it_visible` WS message lands. Selector keyed on lastEventId.
  const itPollFromBar = useDashboardStore((s) =>
    lastEventId
      ? s.latencyBars.find((b) => b.event_id === lastEventId)?.it_poll_ms ?? 0
      : 0
  );

  const fireEvent = useCallback(
    async (eventType: "TRADE" | "MARK" | "CREDIT_EVENT") => {
      setLoading(eventType);
      setError(null);

      const t0_click = performance.now();

      let data: IngestResponse;
      try {
        const res = await fetch("/api/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ event_type: eventType }),
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        }
        data = (await res.json()) as IngestResponse;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(null);
        return;
      }

      const t1_post_done = performance.now();
      const browser_post_total = t1_post_done - t0_click;
      // IT-poll is no longer in the response (architectural fix, item #12).
      // Click pipeline is now strictly: network + SDK + flush — apples-to-apples
      // with Streamlit's parent fork.
      const networkMs = Math.max(0, browser_post_total - data.total_handler_ms);

      // No optimistic prepend — the next /api/snapshot poll (≤1.5s) brings the
      // verified row from RAW_EVENTS with full issuer/sector/age. Single source
      // of truth = Interactive Table.
      // UNLESS optimisticEnabled is true — then prepend immediately with pending status.
      if (optimisticEnabled) {
        addOptimisticEvent({
          event_id: data.event_id,
          event_type: data.event_type as "TRADE" | "MARK" | "CREDIT_EVENT",
          position_id: data.position_id,
          issuer: "",
          sector: "",
          partition: data.partition,
          ingested_ts: new Date().toISOString(),
          status: "pending",
        });
      }

      const barLabel = `#${Date.now()} ${eventType.slice(0, 5)}`;
      addLatencyBar({
        label: barLabel,
        event_id: data.event_id, // Lets WS `it_visible` find this bar later.
        network_ms: networkMs,
        sdk_appended_ms: data.sdk_appended_ms,
        flush_committed_ms: data.flush_committed_ms,
        it_poll_ms: 0, // Updated post-hoc via WS.
        render_ms: 0,
      });
      setLastEventId(data.event_id);

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const t2_painted = performance.now();
          const renderMs = t2_painted - t1_post_done;
          updateLatencyBar(barLabel, { render_ms: renderMs });

          setLastTimings({
            t_post_done_ms: browser_post_total,
            vm_total_handler_ms: data.total_handler_ms,
            it_poll_ms: null, // Will be filled in by selector after WS arrives.
            render_ms: renderMs,
            visible_total_ms: t2_painted - t0_click,
          });
        });
      });

      setLastResult(data);
      setLoading(null);
    },
    [addLatencyBar, updateLatencyBar, addOptimisticEvent, optimisticEnabled]
  );

  return (
    <div>
      <h3 className="text-sm font-medium text-slate-300 mb-3">
        Event Generator
      </h3>

      <div className="grid grid-cols-3 gap-2">
        <button
          onClick={() => fireEvent("TRADE")}
          disabled={loading !== null}
          title="Generate a synthetic TRADE event. Picks a random POSITION_ID from POSITIONS_DIM, builds a JSON payload with side/qty/price/notional, POSTs to /api/ingest. The backend appends to RAW_EVENTS via Snowpipe Streaming HPA SDK and broadcasts an optimistic WebSocket message. Round-trip target ~10 ms paint, ~1.5-1.8 s for the row to become visible in the Interactive Table."
          className="px-3 py-2 text-xs font-semibold rounded bg-snow-blue text-white hover:bg-snow-blue-dark disabled:opacity-50 transition-colors"
        >
          {loading === "TRADE" ? "..." : "Trade"}
        </button>
        <button
          onClick={() => fireEvent("MARK")}
          disabled={loading !== null}
          title="Generate a synthetic MARK event (price update). Picks a random POSITION_ID, generates a new mark price within ±50 bps of the prior, POSTs to /api/ingest. Drives the position's CURRENT_MARK (computed at query time from RAW_EVENTS) and the Top Marks panel. Same ingest path as TRADE — Snowpipe Streaming HPA SDK + WebSocket optimistic + IT visibility."
          className="px-3 py-2 text-xs font-semibold rounded bg-slate-600 text-white hover:bg-slate-500 disabled:opacity-50 transition-colors"
        >
          {loading === "MARK" ? "..." : "Mark"}
        </button>
        <button
          onClick={() => fireEvent("CREDIT_EVENT")}
          disabled={loading !== null}
          title="Generate a synthetic CREDIT_EVENT (rating change, default, restructuring). Picks a random POSITION_ID, generates an event_subtype + impact_bps, POSTs to /api/ingest. Drives the credit-event ribbon and feeds anomaly detection. Same Snowpipe Streaming HPA SDK ingest path as TRADE/MARK."
          className="px-3 py-2 text-xs font-semibold rounded bg-slate-600 text-white hover:bg-slate-500 disabled:opacity-50 transition-colors"
        >
          {loading === "CREDIT_EVENT" ? "..." : "Credit"}
        </button>
      </div>

      {lastResult && !error && (
        <div className="mt-3 p-2 rounded bg-slate-800/60 border border-slate-700 space-y-1">
          <p className="text-xs text-slate-400">
            <span className="font-semibold text-slate-200">{lastResult.event_type}</span>
            {" → "}
            {lastResult.position_id} (P{lastResult.partition})
          </p>
          <p className="text-xs text-slate-500">
            SDK {lastResult.sdk_appended_ms.toFixed(2)}ms · Flush{" "}
            {lastResult.flush_committed_ms.toFixed(0)}ms
          </p>
          {lastTimings && (
            <p className="text-[10px] text-slate-500 font-mono leading-tight pt-1 border-t border-slate-700/50">
              POST {lastTimings.t_post_done_ms.toFixed(0)}ms · VM {lastTimings.vm_total_handler_ms.toFixed(0)}ms<br />
              IT-poll{" "}
              {itPollFromBar > 0
                ? `${itPollFromBar.toFixed(0)}ms (background)`
                : "… (background)"}
              {" · "}Render {lastTimings.render_ms.toFixed(1)}ms<br />
              <span className="text-slate-300">Total click→painted: {lastTimings.visible_total_ms.toFixed(0)}ms</span>
            </p>
          )}
        </div>
      )}

      {error && (
        <div className="mt-3 p-2 rounded bg-red-900/30 border border-red-800 text-xs text-red-300">
          {error}
        </div>
      )}
    </div>
  );
}
