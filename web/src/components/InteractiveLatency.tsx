"use client";

/**
 * InteractiveLatency — the honest "click → on-screen, served ONLY by the
 * Interactive Table" proof. Fires ONE event, then the server appends+flushes and
 * tight-polls RAW_EVENTS on the interactive warehouse until the row is queryable
 * and returns it. The client renders THAT row and times click → painted. No
 * optimistic paint — the pixel you see was read back from the Interactive Table.
 */
import { useCallback, useRef, useState } from "react";
import { useDashboardStore } from "@/lib/store";
import { computeLiveLatency } from "@/lib/liveStats";

interface VerifiedTimings {
  sdk_ms: number;
  flush_ms: number;
  book_flush_ms: number | null;
  vm_total_ms: number;
  server_transport_ms: number;
  it_read_to_visible_ms: number;
  it_reads: number;
  last_read_ms: number;
  server_total_ms: number;
}
interface VerifiedRow {
  EVENT_ID: string;
  EVENT_TYPE: string;
  POSITION_ID: string;
  ISSUER: string | null;
  SECTOR: string | null;
  NEW_MARK: number | null;
  EVENT_TS: string;
}
interface Result {
  clickToScreenMs: number;
  timings: VerifiedTimings;
  row: VerifiedRow | null;
  found: boolean;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** Compact ms → "x.xx s" once we're past a second, else "N ms". */
function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(0)} ms`;
}

export function InteractiveLatency() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const samplesRef = useRef<number[]>([]);
  const [, force] = useState(0);
  const setItServed = useDashboardStore((s) => s.setItServed);
  const addLatencyBar = useDashboardStore((s) => s.addLatencyBar);
  const latencyBars = useDashboardStore((s) => s.latencyBars);
  const live = computeLiveLatency(latencyBars);

  const fire = useCallback(async () => {
    setBusy(true);
    setError(null);
    const t0 = performance.now();
    try {
      const res = await fetch("/api/ingest-verified", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event_type: "MARK" }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
      const data = (await res.json()) as {
        found: boolean;
        row: VerifiedRow | null;
        timings: VerifiedTimings;
      };
      // Paint the IT-served row, then measure through the paint (RAF x2).
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const clickToScreenMs = performance.now() - t0;
          if (data.found) {
            samplesRef.current.push(clickToScreenMs);
            if (samplesRef.current.length > 20) samplesRef.current.shift();
            // Publish to the store so the /demo Fast card shows the SAME number.
            const s = samplesRef.current;
            setItServed(median(s), Math.min(...s), clickToScreenMs);

            // Also feed the shared latency graphs (LatencyTimeline +
            // LatencyComparison). This is the SAME data source the Trade/Mark/
            // Credit buttons use, so "Fire & measure" now counts in the graph.
            // The IT-visibility (amber) layer gets the REAL measured
            // commit→queryable time this route already polled for.
            const t = data.timings;
            const flushMs = Math.max(t.flush_ms, t.book_flush_ms ?? 0);
            const vmOverheadMs = Math.max(0, t.vm_total_ms - t.sdk_ms - flushMs);
            // netRender = browser hop + paint (everything the server can't see).
            // The SPCS↔VM tunnel is inside server_total, so it's NOT in netRender;
            // fold it into network_ms so this client bar matches the desk's
            // convention (client network includes transport) and the pipeline
            // total isn't undercounting the tunnel.
            const netRender = Math.max(0, clickToScreenMs - t.server_total_ms);
            const networkMs = netRender + (t.server_transport_ms ?? 0);
            addLatencyBar({
              label: `#${Date.now()} FIRE`,
              event_id: data.row?.EVENT_ID,
              network_ms: networkMs, // browser hop + tunnel + paint (not split here)
              sdk_appended_ms: t.sdk_ms,
              flush_committed_ms: flushMs,
              vm_overhead_ms: vmOverheadMs,
              it_poll_ms: t.it_read_to_visible_ms, // REAL measured IT visibility
              it_poll_confirmed: true,
              render_ms: 0,
              partition: 0,
              source: "client",
            });
          }
          setResult({ clickToScreenMs, timings: data.timings, row: data.row, found: data.found });
          setBusy(false);
          force((n) => n + 1);
        });
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }, [setItServed, addLatencyBar]);

  const samples = samplesRef.current;
  const p50 = median(samples);
  const best = samples.length ? Math.min(...samples) : null;
  const r = result;
  // network + render = full click→screen minus everything the server measured.
  const netRenderMs =
    r && r.found ? Math.max(0, r.clickToScreenMs - r.timings.server_total_ms) : null;

  return (
    <div className="rounded-lg border border-emerald-800/50 bg-emerald-950/20 p-4">
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-sm font-semibold text-emerald-300">
          Click → on-screen, served only by the Interactive Table
        </h3>
        <button
          onClick={fire}
          disabled={busy}
          className="text-xs font-semibold px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white transition-colors"
        >
          {busy ? "Serving…" : "Fire & measure"}
        </button>
      </div>
      <p className="text-[11px] text-slate-400 mb-3">
        Fires one event, commits it via Snowpipe Streaming, then <strong>reads the row back from
        the <code>RAW_EVENTS</code> Interactive Table</strong> on the interactive warehouse and
        paints it. No optimistic shortcut — the number is the real end-to-end from your click to a
        pixel backed by an Interactive-Table read. <span className="text-slate-500">This is a{" "}
        <strong>manual</strong> measurement (it times the browser paint, so it needs a real click);
        Live Market streams server-side with no click, so it drives the live produce→queryable
        number below instead.</span>
      </p>

      {/* Live latency from ALL events (incl. Live Market) — moves continuously
          without a manual click. Percentiles + segment breakdown, like the desk. */}
      <div className="mb-3 rounded border border-slate-700/60 bg-slate-900/40 px-3 py-2">
        <div className="flex items-baseline justify-between">
          <span className="text-[11px] text-slate-400">
            Live produce→queryable (all streamed events)
          </span>
          <span className="text-[10px] text-slate-500 font-mono">
            {live.count > 0 ? `n=${live.count}` : "start Live Market or fire below"}
          </span>
        </div>
        {live.count > 0 ? (
          <>
            <div className="mt-1 flex items-baseline gap-3 font-mono">
              <span className="text-lg text-emerald-300">
                {live.endToEndP50 != null ? fmtMs(live.endToEndP50) : "—"}
                <span className="text-[10px] text-slate-500 ml-1">p50</span>
              </span>
              <span className="text-xs text-slate-400">
                p90 {live.endToEndP90 != null ? fmtMs(live.endToEndP90) : "—"}
              </span>
              <span className="text-xs text-slate-400">
                p95 {live.endToEndP95 != null ? fmtMs(live.endToEndP95) : "—"}
              </span>
              <span className="text-xs text-slate-400">
                p99 {live.endToEndP99 != null ? fmtMs(live.endToEndP99) : "—"}
              </span>
            </div>
            {(() => {
              const segs = [
                { label: "network (server parse)", v: live.seg.network ?? 0, color: "#67E8F9" },
                { label: "server↔VM tunnel", v: live.seg.transport ?? 0, color: "#94A3B8" },
                { label: "SDK append + VM", v: live.seg.appendVm ?? 0, color: "#34D399" },
                { label: "flush / commit", v: live.seg.flush ?? 0, color: "#29B5E8" },
                { label: "IT visibility (batched incorporation)", v: live.seg.visibility ?? 0, color: "#FBBF24" },
              ];
              const total = segs.reduce((a, s) => a + s.v, 0) || 1;
              return (
                <div className="mt-2 space-y-1">
                  <div className="text-[10px] uppercase tracking-wide text-slate-500">
                    Each component of lag (median per segment)
                  </div>
                  {segs.map((s) => (
                    <div key={s.label} className="flex items-center gap-2 text-[10px]">
                      <span className="w-48 shrink-0 text-slate-400 truncate" title={s.label}>{s.label}</span>
                      <div className="flex-1 h-2 rounded bg-slate-800 overflow-hidden">
                        <div className="h-full rounded" style={{ width: `${(s.v / total) * 100}%`, background: s.color }} />
                      </div>
                      <span className="w-14 shrink-0 text-right font-mono text-slate-300">{fmtMs(s.v)}</span>
                      <span className="w-9 shrink-0 text-right text-slate-500">{((s.v / total) * 100).toFixed(0)}%</span>
                    </div>
                  ))}
                </div>
              );
            })()}
            <div className="mt-2 rounded border border-slate-700/60 bg-slate-900/40 px-2.5 py-2 text-[10px] text-slate-500 leading-snug space-y-1.5">
              <p>
                <strong className="text-slate-400">How it adds up:</strong> these five segments are{" "}
                <strong className="text-slate-300">sequential</strong> — each hands off to the next — so
                they <strong className="text-slate-300">sum</strong> to the produce→queryable total above:
                network (server parse) → server↔VM tunnel → SDK append → flush/commit → IT visibility.
                <em> SDK append + VM + flush</em> together equal the VM&apos;s total handler time exactly.
              </p>
              <p>
                <strong className="text-slate-400">One concurrency is baked in:</strong> flush/commit is the{" "}
                <strong className="text-slate-300">MAX</strong> of two write-throughs that run{" "}
                <strong className="text-slate-300">in parallel</strong> on the VM — RAW_EVENTS and
                POSITION_BOOK stream concurrently — <em>not</em> their sum, so the concurrent second write
                is never double-counted. The <strong className="text-slate-400">server↔VM tunnel</strong> is
                counted once here (a manual click folds it into its measured browser network instead).
              </p>
              <p>
                <strong className="text-slate-400">Excluded (overlaps everything):</strong> the optimistic
                paint (~10 ms) fires at click and runs <strong className="text-slate-300">concurrent with the
                whole pipeline</strong> — you see a pending row instantly while all of the above happens — so
                it is intentionally not a term in this sum. <strong className="text-slate-400">IT
                visibility</strong> is the interactive table incorporating the just-committed micropartition
                into its served state, done in irregular batches (~0.35–1.3 s cadence), which is why it
                dominates and varies. Anchored at the event reaching the server; add the browser→server hop +
                paint for the full click→visualized (Live Market panel).
              </p>
            </div>
          </>
        ) : (
          <p className="mt-1 text-[10px] text-slate-500">
            Start Live Market (or hit Fire &amp; measure) and the p50/p90/p95/p99 + segment breakdown
            populate from every streamed row.
          </p>
        )}
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      {r && (
        <>
          <div className="flex items-end gap-4 flex-wrap">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-slate-400">click → on-screen (IT-served)</div>
              <div className="text-3xl font-bold font-mono text-emerald-300">
                {r.found ? fmtMs(r.clickToScreenMs) : "not visible in budget"}
              </div>
            </div>
            {p50 != null && (
              <div className="text-xs text-slate-400 font-mono pb-1">
                p50 {fmtMs(p50)} · best {fmtMs(best!)} · n={samples.length}
              </div>
            )}
          </div>

          {r.found && (
            <>
              <div className="mt-2 text-[11px] font-mono text-slate-400 flex flex-wrap gap-x-3 gap-y-0.5">
                <span>flush <span className="text-slate-200">{fmtMs(r.timings.flush_ms)}</span></span>
                <span>·</span>
                <span>
                  IT commit→queryable{" "}
                  <span className="text-slate-200">{fmtMs(r.timings.it_read_to_visible_ms)}</span>{" "}
                  ({r.timings.it_reads} read{r.timings.it_reads === 1 ? "" : "s"}, last {fmtMs(r.timings.last_read_ms)})
                </span>
                <span>·</span>
                <span>network+render <span className="text-slate-200">{fmtMs(netRenderMs!)}</span></span>
              </div>
              <p className="mt-1 text-[10px] text-slate-500 leading-snug">
                <strong className="text-slate-400">commit→queryable</strong> is the streaming
                visibility lag — the interactive table serves reads sub-second, but a just-committed
                streamed row takes ~1–2 s (p50 ~1.3 s, varies ~0.7–2.4 s) to become queryable. That&apos;s
                the honest price of a durable write-through (vs. an in-memory cache that can drop data).
                The optimistic paint hides this from the user; this widget deliberately does not.
              </p>

              {/* The actual row, freshly read from the Interactive Table. */}
              {r.row && (
                <div className="mt-2 rounded border border-slate-700 bg-slate-900/60 p-2 text-xs font-mono">
                  <span className="text-slate-500">from RAW_EVENTS →</span>{" "}
                  <span className="text-amber-300">{r.row.EVENT_TYPE}</span>{" "}
                  <span className="text-slate-200">{r.row.POSITION_ID}</span>{" "}
                  <span className="text-slate-400">{r.row.ISSUER ?? "—"}</span>
                  {r.row.NEW_MARK != null && (
                    <>
                      {" · mark "}
                      <span className="text-emerald-300">{r.row.NEW_MARK.toFixed(4)}</span>
                    </>
                  )}
                  <span className="text-slate-600"> · {r.row.EVENT_ID.slice(0, 8)}…</span>
                </div>
              )}
            </>
          )}
        </>
      )}

      {!r && !error && (
        <p className="text-xs text-slate-500">Hit <strong>Fire &amp; measure</strong> to serve a row end-to-end from the Interactive Table.</p>
      )}
    </div>
  );
}
