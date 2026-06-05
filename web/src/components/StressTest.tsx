"use client";

import { useState, useCallback } from "react";
import { useDashboardStore } from "@/lib/store";

interface BatchResult {
  requested: number;
  ingested: number;
  vm_elapsed_ms: number;
  total_handler_ms: number;
  avg_per_event_ms: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function StressTest() {
  const [count, setCount] = useState(20);
  const [type, setType] = useState<"MIXED" | "TRADE" | "MARK" | "CREDIT_EVENT">("MIXED");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<BatchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number>(0);
  const setBurstResult = useDashboardStore((s) => s.setBurstResult);

  const fire = useCallback(async () => {
    setRunning(true);
    setError(null);
    setResult(null);
    setBurstResult(null);
    setProgress(0);

    // Fire individual /api/ingest calls to capture per-event latency
    const eventTypes: Array<"TRADE" | "MARK" | "CREDIT_EVENT"> =
      type === "MIXED"
        ? ["TRADE", "MARK", "CREDIT_EVENT"]
        : [type];
    const latencies: number[] = [];
    let ingested = 0;

    for (let i = 0; i < count; i++) {
      const evType = eventTypes[i % eventTypes.length];
      const t0 = performance.now();
      try {
        const res = await fetch("/api/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ event_type: evType }),
        });
        const elapsed = performance.now() - t0;
        if (res.ok) {
          await res.json();
          // Per-event latency = POST roundtrip (network + HPA flush ack).
          // IT visibility lag is now decoupled from the response (architectural
          // fix, item #12) so this number is the honest click pipeline cost,
          // apples-to-apples with Streamlit.
          latencies.push(elapsed);
          ingested++;
        }
      } catch {
        // Skip failed events
        latencies.push(performance.now() - t0);
      }
      setProgress(((i + 1) / count) * 100);
    }

    // Compute stats and store burst result
    const sorted = [...latencies].sort((a, b) => a - b);
    const vmElapsed = latencies.reduce((s, v) => s + v, 0);
    const batchResult: BatchResult = {
      requested: count,
      ingested,
      vm_elapsed_ms: vmElapsed,
      total_handler_ms: vmElapsed,
      avg_per_event_ms: latencies.length > 0 ? vmElapsed / latencies.length : 0,
    };
    setResult(batchResult);

    if (latencies.length > 0) {
      setBurstResult({
        count: latencies.length,
        latencies_ms: latencies,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        p99: percentile(sorted, 99),
        max: sorted[sorted.length - 1],
      });
    }

    setRunning(false);
  }, [count, type, setBurstResult]);

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-3">
      <h4 className="text-xs text-slate-400 font-medium mb-2">Stress Test</h4>

      <div className="space-y-2">
        <label className="block text-[10px] uppercase tracking-wide text-slate-500">
          Events: <span className="text-slate-200 font-mono">{count}</span>
        </label>
        <input
          type="range"
          min={5}
          max={100}
          step={5}
          value={count}
          onChange={(e) => setCount(parseInt(e.target.value, 10))}
          disabled={running}
          className="w-full accent-snow-blue"
        />

        <div className="grid grid-cols-2 gap-1">
          {(["MIXED", "TRADE", "MARK", "CREDIT_EVENT"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setType(t)}
              disabled={running}
              className={`px-2 py-1 text-[10px] rounded border transition-colors ${
                type === t
                  ? "bg-snow-blue text-white border-snow-blue"
                  : "bg-slate-700/50 text-slate-300 border-slate-600 hover:bg-slate-700"
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        <button
          onClick={fire}
          disabled={running}
          className="w-full px-3 py-2 text-xs font-semibold rounded bg-snow-blue text-white hover:bg-snow-blue-dark disabled:opacity-50 transition-colors"
        >
          {running ? "Firing batch..." : "Fire Batch"}
        </button>

        {running && (
          <div className="h-1 bg-slate-700 rounded overflow-hidden">
            <div
              className="h-full bg-snow-blue transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}

        {result && !error && (
          <div className="mt-1 p-2 rounded bg-slate-900/60 border border-slate-700 text-[11px] space-y-0.5">
            <p className="text-slate-300">
              <span className="text-green-400 font-semibold">{result.ingested}</span> /
              {" "}{result.requested} events
            </p>
            <p className="text-slate-400 font-mono">
              VM batch: {result.vm_elapsed_ms.toFixed(0)}ms
            </p>
            <p className="text-slate-400 font-mono">
              Avg/event: {result.avg_per_event_ms.toFixed(1)}ms
            </p>
            <p className="text-slate-500 font-mono">
              Round-trip: {result.total_handler_ms.toFixed(0)}ms
            </p>
          </div>
        )}

        {error && (
          <div className="mt-1 p-2 rounded bg-red-900/30 border border-red-800 text-[11px] text-red-300">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
