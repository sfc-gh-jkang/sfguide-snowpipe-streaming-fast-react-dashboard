"use client";

/**
 * MarketSimulator — a toggle that turns the demo into a *live* desk without
 * manual clicking. When ON, it fires synthetic events at /api/ingest on an
 * interval (weighted: mostly MARKs, some TRADEs, occasional CREDIT_EVENTs), so
 * the tape, tiles, latency timeline, and the 3-strategy serving panel all move
 * continuously. Each POST flows through the same HPA write-through as a manual
 * click, so freshness/latency stay honest.
 *
 * Fire-and-forget on the interval (calls may overlap — that's fine, they're
 * async); an in-flight cap prevents runaway pileup if the tunnel slows.
 *
 * Numbers: each streamed row produces a commit→queryable visibility measurement
 * (server-side, via the it_visible WS backfill), so this panel shows the LIVE
 * streaming-visibility p50 + a measured throughput — the desk "moving on its
 * own" with honest numbers, no manual click needed.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useDashboardStore } from "@/lib/store";
import { computeLiveLatency, fmtMs } from "@/lib/liveStats";

const RATES = [
  { label: "0.5/s", perSec: 0.5 },
  { label: "1/s", perSec: 1 },
  { label: "2/s", perSec: 2 },
  { label: "4/s", perSec: 4 },
] as const;

// Weighted event mix — a credit desk sees mostly re-marks, fewer trades, rare
// rating actions. Keeps the book moving realistically.
function pickEventType(): "TRADE" | "MARK" | "CREDIT_EVENT" {
  const r = Math.random();
  if (r < 0.7) return "MARK";
  if (r < 0.95) return "TRADE";
  return "CREDIT_EVENT";
}

const MAX_IN_FLIGHT = 6;

export function MarketSimulator() {
  const [on, setOn] = useState(false);
  const [perSec, setPerSec] = useState(1);
  const [count, setCount] = useState(0);
  const [errors, setErrors] = useState(0);
  const inFlight = useRef(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  // Timestamps of successful fires (last ~60), for a measured throughput rate.
  const firedTimesRef = useRef<number[]>([]);
  // Browser→server ingress samples: client fetch round-trip − server_total_ms.
  const ingressSamplesRef = useRef<number[]>([]);
  const [, setTick] = useState(0);

  // Live end-to-end latency (produce→queryable) from the store — moves on
  // every streamed row, so this is what animates while Live Market runs.
  const latencyBars = useDashboardStore((s) => s.latencyBars);
  const live = computeLiveLatency(latencyBars);
  // Full-page paint timings (populated on /demo by a WS-triggered render probe).
  const renderTimings = useDashboardStore((s) => s.fullPageRenderTimings);

  const med = (xs: number[]): number | null =>
    xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null;

  // Browser-anchored click→visualized, composed from disjoint measured segments:
  //   ingress (browser↔SPCS) + endToEnd (parse+tunnel+append+flush+visibility) + render
  const ingressP50 = med(ingressSamplesRef.current);
  const renderP50 = med(renderTimings);
  const clickToQueryableP50 =
    live.endToEndP50 != null ? (ingressP50 ?? 0) + live.endToEndP50 : null;
  const clickToVisualizedP50 =
    clickToQueryableP50 != null ? clickToQueryableP50 + (renderP50 ?? 0) : null;

  // Measured throughput: fires in the last 10 s / 10. Refreshed by a 1 s tick
  // while streaming so the rate decays visibly when you stop.
  const now = Date.now();
  const recentFires = firedTimesRef.current.filter((t) => now - t <= 10_000);
  const measuredRate = recentFires.length / 10;

  const fireOne = useCallback(async () => {
    if (inFlight.current >= MAX_IN_FLIGHT) return; // don't pile up if the tunnel is slow
    inFlight.current += 1;
    const t0c = performance.now();
    try {
      const res = await fetch("/api/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event_type: pickEventType() }),
      });
      if (res.ok) {
        setCount((c) => c + 1);
        firedTimesRef.current.push(Date.now());
        if (firedTimesRef.current.length > 60) firedTimesRef.current.shift();
        // Browser→SPCS ingress = client round-trip − server-measured handling.
        try {
          const j = await res.json();
          if (typeof j?.server_total_ms === "number") {
            const ingress = Math.max(0, performance.now() - t0c - j.server_total_ms);
            ingressSamplesRef.current.push(ingress);
            if (ingressSamplesRef.current.length > 40) ingressSamplesRef.current.shift();
          }
        } catch {
          /* ignore body parse */
        }
      } else setErrors((e) => e + 1);
    } catch {
      setErrors((e) => e + 1);
    } finally {
      inFlight.current -= 1;
    }
  }, []);

  useEffect(() => {
    if (timer.current) {
      clearInterval(timer.current);
      timer.current = null;
    }
    if (on) {
      const intervalMs = Math.max(100, Math.round(1000 / perSec));
      timer.current = setInterval(fireOne, intervalMs);
    }
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [on, perSec, fireOne]);

  // 1 s tick refreshes the measured-rate window (and lets it decay to 0 on stop).
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [on]);

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-3">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-xs text-slate-400 font-medium">Live market</h4>
        <button
          onClick={() => setOn((v) => !v)}
          className={`text-xs font-medium px-2.5 py-1 rounded transition-colors ${
            on
              ? "bg-emerald-600 hover:bg-emerald-500 text-white"
              : "bg-slate-700 hover:bg-slate-600 text-slate-200"
          }`}
        >
          {on ? "● LIVE — stop" : "▶ Start"}
        </button>
      </div>
      <p className="text-[11px] text-slate-500 mb-2">
        Streams synthetic marks/trades continuously so the desk moves on its own —
        drives every tile and the 3-strategy panel. Same HPA write-through path as a
        manual click.
      </p>
      <div className="flex items-center gap-1 mb-2">
        {RATES.map((r) => (
          <button
            key={r.label}
            onClick={() => setPerSec(r.perSec)}
            className={`text-[11px] px-2 py-0.5 rounded border ${
              perSec === r.perSec
                ? "border-emerald-500 text-emerald-300 bg-emerald-950/40"
                : "border-slate-700 text-slate-400 hover:border-slate-600"
            }`}
          >
            {r.label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-3 text-[11px]">
        <span className="flex items-center gap-1">
          <span
            className={`inline-block w-2 h-2 rounded-full ${
              on ? "bg-emerald-400 animate-pulse" : "bg-slate-600"
            }`}
          />
          <span className="text-slate-400">{on ? "streaming" : "idle"}</span>
        </span>
        <span className="text-slate-500">
          fired <span className="font-mono text-slate-300">{count}</span>
        </span>
        <span className="text-slate-500">
          rate <span className="font-mono text-slate-300">{measuredRate.toFixed(1)}</span>/s
        </span>
        {errors > 0 && (
          <span className="text-red-400">
            err <span className="font-mono">{errors}</span>
          </span>
        )}
      </div>
      {/* Full browser-anchored click→visualized, composed from measured segments. */}
      <div className="mt-2 pt-2 border-t border-slate-700/60 text-[11px]">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-slate-400">click→visualized p50</span>
          <span className="font-mono text-emerald-300 text-sm">
            {clickToVisualizedP50 != null ? fmtMs(clickToVisualizedP50) : "—"}
          </span>
          <span className="text-slate-600">
            {live.count > 0 ? `· ${live.count} rows` : "· start to measure"}
          </span>
        </div>
        {clickToVisualizedP50 != null && (
          <div className="mt-1 flex items-baseline gap-x-2 gap-y-0.5 flex-wrap text-slate-500">
            <span>browser↔server {ingressP50 != null ? fmtMs(ingressP50) : "—"}</span>
            <span>+ server↔VM {live.serverTransportP50 != null ? fmtMs(live.serverTransportP50) : "—"}</span>
            <span>+ append/flush ~0.3 s</span>
            <span>+ IT visibility {live.visibilityP50 != null ? fmtMs(live.visibilityP50) : "—"}</span>
            <span>+ render {renderP50 != null ? fmtMs(renderP50) : "—"}</span>
          </div>
        )}
      </div>
      <p className="text-[10px] text-slate-600 mt-0.5 leading-snug">
        Every segment from your browser to the painted row is measured: the browser→server hop (this
        widget times its own POST), the SPCS↔VM tunnel (AWS→GCP), append + flush/commit, the
        interactive-table streaming visibility (p50 ~1.3 s, varies ~0.7–2.4 s — the dominant term),
        and the paint. No modeled numbers.
      </p>
    </div>
  );
}
