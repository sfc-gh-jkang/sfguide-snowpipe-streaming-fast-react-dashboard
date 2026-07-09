"use client";

import { useMemo } from "react";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Tooltip,
  Legend,
} from "chart.js";
import { Bar } from "react-chartjs-2";
import { useDashboardStore } from "@/lib/store";
import { useRenderTiming } from "@/lib/useRenderTiming";
import {
  STREAMLIT_RENDER_MS,
  STREAMLIT_QUERY_PROFILE_MS,
  STREAMLIT_QUERIES_PER_RERUN,
  REACT_FORK_SERVING_MS,
} from "@/lib/baseline";
import { POLL_WAIT_AVG_MS, PUBLIC_INTERACTIVE_WH, PUBLIC_STANDARD_WH } from "@/lib/constants";

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip, Legend);

/** Same palette as LatencyTimeline.tsx */
const SEGMENT_COLORS = {
  network: "#67E8F9", // cyan-300
  sdk_append: "#34D399", // emerald-400
  hpa_flush: "#29B5E8", // Snowflake brand blue
  it_poll: "#FBBF24", // amber-400
  render: "#A78BFA", // violet-400
};

function computeMedian(bars: { network_ms: number; sdk_appended_ms: number; flush_committed_ms: number; it_poll_ms: number; render_ms: number }[]) {
  if (bars.length === 0) return null;
  const median = (arr: number[]) => {
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };
  return {
    network: median(bars.map((b) => b.network_ms)),
    sdk_append: median(bars.map((b) => b.sdk_appended_ms)),
    hpa_flush: median(bars.map((b) => b.flush_committed_ms)),
    it_poll: median(bars.map((b) => b.it_poll_ms)),
    render: median(bars.map((b) => b.render_ms)),
  };
}

export function LatencyComparison() {
  const latencyBars = useDashboardStore((s) => s.latencyBars);
  const chartRenderTimings = useDashboardStore((s) => s.chartRenderTimings);
  const fullPageRenderTimings = useDashboardStore((s) => s.fullPageRenderTimings);
  const wsDeliveryTimings = useDashboardStore((s) => s.wsDeliveryTimings);
  const scanDetectTimings = useDashboardStore((s) => s.scanDetectTimings);
  useRenderTiming("LatencyComparison", latencyBars);

  // Apples-to-apples: use full-page render (median) for the React render bar,
  // not click-acknowledgment paint. Streamlit's 1646 ms IS a full-page rerun;
  // this matches.
  const fullPageMedianMs = useMemo(() => {
    if (fullPageRenderTimings.length === 0) return null;
    const sorted = [...fullPageRenderTimings].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }, [fullPageRenderTimings]);

  // WebSocket wire-delivery median (client receive ts − server emit ts) on
  // every message arriving over the /api/ws connection.
  const wsDeliveryMedianMs = useMemo(() => {
    if (wsDeliveryTimings.length === 0) return null;
    const sorted = [...wsDeliveryTimings].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }, [wsDeliveryTimings]);

  // Server-side scan-detect median (broker emit ts − max INGESTED_TS in batch)
  // — measured per tape broadcast, replaces the prior hardcoded 100 ms estimate.
  // null until at least one tape change has been broadcast since page load.
  const scanDetectMedianMs = useMemo(() => {
    if (scanDetectTimings.length === 0) return null;
    const sorted = [...scanDetectTimings].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }, [scanDetectTimings]);

  const med = useMemo(() => computeMedian(latencyBars), [latencyBars]);

  // No bucketing. Animation is disabled on the chart so bars snap directly
  // to new values — there's no tween to hide. Raw measured medians give
  // honest sub-50 ms variation visibility.
  const fullPageRawMs = fullPageMedianMs ?? 0;
  const wsRawMs = wsDeliveryMedianMs ?? 0;
  const scanDetectRawMs = scanDetectMedianMs ?? 0;
  const itPollRawMs = med?.it_poll ?? 0;
  const networkRawMs = med?.network ?? 0;
  const sdkRawMs = med?.sdk_append ?? 0;
  const flushRawMs = med?.hpa_flush ?? 0;
  const wsSampleCount = wsDeliveryTimings.length;
  const scanSampleCount = scanDetectTimings.length;
  const wsBinLabel = wsDeliveryMedianMs != null && scanDetectMedianMs != null
    ? `3 · Server scan (${scanDetectRawMs.toFixed(0)} ms MEASURED, n=${scanSampleCount}) + WS wire (${wsRawMs.toFixed(0)} ms MEASURED, n=${wsSampleCount})`
    : wsDeliveryMedianMs != null
      ? `3 · Server scan (waiting for tape change…) + WS wire (${wsRawMs.toFixed(0)} ms MEASURED, n=${wsSampleCount})`
      : "3 · Server scan + WS wire delivery (waiting for samples…)";

  const chartData = useMemo(() => {
    // Methodology v7 (this session): WebSocket push is now the canonical
    // comparison mode. SSE was retired because SPCS Snowsight ingress
    // reaps long-lived EventSource GETs (see global memory rule).
    //
    //   - Server-side `snowflake-reader.ts` polls IT every 200 ms, hashes,
    //     and broadcasts via the WebSocket /api/ws broker on change.
    //   - Browser opens ws://...{host}/api/ws on page load. Custom server.js
    //     handles the HTTP upgrade. Streamlit-on-Snowflake uses the same
    //     ws:// path through SPCS ingress for live logs (verified working).
    //   - Every broadcast carries a server `_emit_ts` so the browser can
    //     measure wire-delivery latency = recv_ts - emit_ts on every msg.
    //
    //   React (WebSocket, 4 segments):
    //     [click pipeline] → [IT visibility lag] → [WS detect+push] → [render]
    //     - click pipeline:    network + SDK + flush ack         ≈ 0.43 s
    //     - IT visibility lag: row commits to IT after flush     ≈ 0.3-1.5 s
    //     - WS detect + push:  server scan (≤200 ms) + push      ≈ 0.13 s
    //     - render:            snapshot lifecycle + paint        ≈ 0.84 s
    //     ────────────────────────────────────────────────────────────
    //     total ≈ 2.9 s
    //
    //   Streamlit (rerun, 2 segments):
    //     [click pipeline] → [rerun]
    //     ≈ 0.43 s + 2.52 s = ≈ 2.95 s
    //
    // WebSocket eliminates the poll-wait variance and pulls React ahead of
    // Streamlit by a small but real margin. The much bigger wins remain
    // freshness + click-acknowledgment paint.
    // Raw measured medians — no bucketing. Chart animation is disabled,
    // so bars snap to new values without tweening; there's no twitch to hide.
    const clickPipelineMs = networkRawMs + sdkRawMs + flushRawMs;
    const itVisibilityMs = itPollRawMs;
    // Server scan-detect: MEASURED per tape broadcast (max INGESTED_TS in
    // batch → broker emit). Falls back to 0 until the first tape change
    // arrives — at that point the bar grows to reflect the true cost.
    // Wire-delivery latency is also MEASURED on the live WS connection.
    const wsDetectAndPushMs = scanDetectRawMs + wsRawMs;
    const reactRender = fullPageRawMs;
    const streamlitRender = STREAMLIT_RENDER_MS.typical;

    // Bar labels reflect the ACTUAL measured value, not stale hardcoded
    // approximations. (~0.4 s style labels lied when measurements drifted.)
    const fmtSec = (ms: number) =>
      ms < 1000 ? `${ms.toFixed(0)} ms` : `${(ms / 1000).toFixed(2)} s`;
    const clickPipelineLabel = `1 · Click pipeline (shared, ${fmtSec(clickPipelineMs)} measured: net ${fmtSec(networkRawMs)} + SDK ${fmtSec(sdkRawMs)} + flush ${fmtSec(flushRawMs)})`;
    const itVisibilityLabel = `2 · IT visibility lag (${fmtSec(itVisibilityMs)} measured; React waits, Streamlit pays via stale risk)`;
    const renderLabel = `4 · Render layer (React ${fmtSec(reactRender)} measured · Streamlit ${fmtSec(streamlitRender)} baseline)`;

    return {
      labels: ["React (WebSocket)", "Streamlit (rerun)"],
      datasets: [
        {
          label: clickPipelineLabel,
          data: [clickPipelineMs, clickPipelineMs],
          backgroundColor: SEGMENT_COLORS.network,
          borderColor: "#0f172a",
          borderWidth: 1,
        },
        {
          label: itVisibilityLabel,
          data: [itVisibilityMs, 0],
          backgroundColor: SEGMENT_COLORS.it_poll,
          borderColor: "#0f172a",
          borderWidth: 1,
        },
        {
          label: wsBinLabel,
          data: [wsDetectAndPushMs, 0],
          backgroundColor: "#10B981", // emerald-500
          borderColor: "#0f172a",
          borderWidth: 1,
        },
        {
          label: renderLabel,
          data: [reactRender, streamlitRender],
          backgroundColor: SEGMENT_COLORS.render,
          borderColor: "#0f172a",
          borderWidth: 1,
        },
      ],
    };
  }, [
    // Raw scalars — chart redraws when any median moves. Animation disabled,
    // so redraws are a clean snap, not a tween.
    networkRawMs,
    sdkRawMs,
    flushRawMs,
    itPollRawMs,
    wsRawMs,
    scanDetectRawMs,
    fullPageRawMs,
    wsBinLabel,
  ]);

  const options = useMemo(
    () => ({
      indexAxis: "y" as const,
      responsive: true,
      maintainAspectRatio: false,
      // Animation disabled: even with bucketed values, when bars do change
      // we don't want a 200 ms tween that draws attention to redraw events
      // — the chart should look static unless typical numbers actually shift.
      animation: false as const,
      plugins: {
        legend: {
          position: "top" as const,
          labels: { color: "#e2e8f0", font: { size: 11 } },
        },
        tooltip: {
          callbacks: {
            label: (ctx: { dataset: { label?: string }; raw: unknown }) =>
              `${ctx.dataset.label}: ${(ctx.raw as number).toFixed(0)} ms`,
            footer: (items: Array<{ raw: unknown }>) => {
              const total = items.reduce(
                (s, i) => s + ((i.raw as number) || 0),
                0
              );
              return `Total wall-clock: ${(total / 1000).toFixed(2)} s`;
            },
          },
        },
      },
      scales: {
        x: {
          stacked: true,
          ticks: { color: "#cbd5e1", font: { size: 10 } },
          grid: { color: "#1e293b" },
          title: {
            display: true,
            text: "End-to-end wall-clock: click → fresh dashboard (ms)",
            color: "#94a3b8",
            font: { size: 11 },
          },
        },
        y: {
          stacked: true,
          ticks: { color: "#cbd5e1", font: { size: 11 } },
          grid: { display: false },
        },
      },
    }),
    []
  );

  // Show the chart if we have ANY measurement: clicks (latencyBars) OR
  // polled snapshots (fullPageRenderTimings). Polling fires within 1.5s of
  // page load, so the chart appears almost immediately even without clicks.
  if (latencyBars.length === 0 && fullPageRenderTimings.length === 0) return null;

  // Sample-size guard — refuse to display the end-to-end summary when we
  // don't have enough click samples to ground the click-pipeline median.
  const hasEnoughSamples = latencyBars.length >= 5;
  // Apples-to-apples render comparison only needs poll samples (any N).
  const hasFullPageRender = fullPageRenderTimings.length > 0;

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-4">
      <h3 className="text-sm font-semibold mb-1">
        End-to-end click → fresh dashboard (swim lanes, WebSocket push mode)
      </h3>
      <p className="text-xs text-slate-400 mb-2">
        React snapshot updates flow over a <strong className="text-slate-200">WebSocket</strong>{" "}
        connection at <code>/api/ws</code> (not SSE — see methodology expander
        below for why). Server-side <code>snowflake-reader</code> scans IT every
        200 ms and broadcasts a diff to all connected clients via the
        ws-broker the instant the fingerprint changes.
        <strong className="text-slate-200"> Click pipeline</strong> (cyan; live median{" "}
        {latencyBars.length > 0
          ? `${(networkRawMs + sdkRawMs + flushRawMs).toFixed(0)} ms over n=${latencyBars.length} click(s)`
          : "no clicks yet — fire one to populate"}
        ) is byte-identical
        on both forks (no server-side IT-poll on the request path).
        <strong className="text-slate-200"> IT visibility lag</strong> (amber)
        is the IT itself catching up to the new row — both forks pay this; React
        waits explicitly, Streamlit pays it implicitly via stale-data risk.
        <strong className="text-emerald-400"> WebSocket detect + push</strong> (green) is the
        push-channel overhead, with the wire-delivery component MEASURED live on
        your connection.
        <strong className="text-slate-200"> Render layer</strong> (violet) is the
        architectural difference: React patches the DOM in place; Streamlit re-runs
        the entire Python script.
      </p>
      {/* Always-visible explainer — answers user FAQ before any sample required. */}
      <details className="text-xs text-slate-300 bg-slate-900/40 border border-slate-700 rounded p-2 mb-3 leading-relaxed">
        <summary className="cursor-pointer text-slate-200 font-semibold">
          Why are there two &quot;render&quot; numbers ({" "}
          {med?.render != null && fullPageMedianMs != null
            ? `${med.render.toFixed(0)} ms vs ${fullPageMedianMs.toFixed(0)} ms — live`
            : "~10 ms vs ~840 ms — archetypal, click to see live values"}
          )?
        </summary>
        <div className="mt-2 space-y-3 text-slate-400">
          {/* Live values strip — replaces hardcoded ~10 ms / ~840 ms with the
              actual measurements when available. Body prose below uses the
              archetypal numbers (clearly disclaimed as illustrative). */}
          <div className="bg-slate-900/60 border border-emerald-700/40 rounded p-2">
            <p className="text-emerald-300 font-semibold mb-0.5">
              Your live values right now:
            </p>
            <ul className="ml-2 space-y-0.5 text-slate-300">
              <li>
                <strong className="text-slate-200">Click-ack render (LatencyTimeline):</strong>{" "}
                {med?.render != null && latencyBars.length > 0
                  ? `${med.render.toFixed(1)} ms (median over n=${latencyBars.length} click(s))`
                  : "no clicks yet — fire one to populate"}
              </li>
              <li>
                <strong className="text-slate-200">Full snapshot render (Swim-lane):</strong>{" "}
                {fullPageMedianMs != null
                  ? `${fullPageMedianMs.toFixed(0)} ms (median over n=${fullPageRenderTimings.length} poll(s))`
                  : "still measuring (first poll < 1.5 s)"}
              </li>
            </ul>
            <p className="mt-1 text-[11px] text-slate-500 italic">
              Numbers in the prose below (~10 ms, ~840 ms) are archetypal —
              illustrative of what each scope typically measures. Compare them
              against your live values above; they should be in the same
              ballpark.
            </p>
          </div>
          <p>
            Two different render measurements with two different scopes. Both are
            real. They answer different questions.
          </p>
          <div className="overflow-x-auto">
            <table className="text-xs border-collapse">
              <tbody>
                <tr className="text-slate-300 border-b border-slate-700">
                  <td className="pr-3 py-1"></td>
                  <td className="pr-3 py-1 text-emerald-300">
                    {med?.render != null
                      ? `${med.render.toFixed(0)} ms (LatencyTimeline, live)`
                      : "~10 ms (LatencyTimeline)"}
                  </td>
                  <td className="py-1 text-violet-300">
                    {fullPageMedianMs != null
                      ? `${fullPageMedianMs.toFixed(0)} ms (Swim-lane, live)`
                      : "~840 ms (Swim-lane render layer)"}
                  </td>
                </tr>
                <tr>
                  <td className="pr-3 py-1 text-slate-200">Where measured</td>
                  <td className="pr-3 py-1"><code>EventGenerator.tsx</code> via RAF×2</td>
                  <td className="py-1"><code>page.tsx</code> via RAF×2 from snapshot fetch start</td>
                </tr>
                <tr>
                  <td className="pr-3 py-1 text-slate-200">Trigger</td>
                  <td className="pr-3 py-1">Click → <code>/api/ingest</code> POST returns</td>
                  <td className="py-1">Snapshot poll → 6 SQL queries complete</td>
                </tr>
                <tr>
                  <td className="pr-3 py-1 text-slate-200">Includes</td>
                  <td className="pr-3 py-1">
                    Just the click-ack DOM mutation (latency bar appears,
                    small text under fire button updates)
                  </td>
                  <td className="py-1">
                    Snapshot fetch + 6 queries + JSON parse + Zustand store
                    updates + React reconcile + Chart.js redraw + browser paint
                  </td>
                </tr>
                <tr>
                  <td className="pr-3 py-1 text-slate-200">Excludes</td>
                  <td className="pr-3 py-1">Snapshot queries, chart redraws, tape update</td>
                  <td className="py-1">Click pipeline, IT visibility lag, WS detect+push</td>
                </tr>
                <tr>
                  <td className="pr-3 py-1 text-slate-200">Question it answers</td>
                  <td className="pr-3 py-1 italic">&quot;Did my click register?&quot;</td>
                  <td className="py-1 italic">&quot;Is fresh data on screen?&quot;</td>
                </tr>
                <tr>
                  <td className="pr-3 py-1 text-slate-200">Streamlit equivalent</td>
                  <td className="pr-3 py-1 text-slate-300">~1646 ms (no separate ack — page freezes during rerun)</td>
                  <td className="py-1 text-slate-300">~1646 ms rerun (p50, apples-to-apples scope)</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div>
            <p className="font-semibold text-slate-200 mb-1">
              Why is the click-ack so fast (~10 ms)?
            </p>
            <p>
              React&apos;s virtual-DOM diffing finds the ONLY thing that changed:
              the latency bar list got one new entry. The text under the fire
              button updated. Everything else (tape, KPIs, sector donut, top
              marks, charts) is unchanged in state, so React touches NOTHING
              else in the DOM. Browser paints just those tiny pixel regions.
              Done.
            </p>
            <p className="mt-1">
              Streamlit doesn&apos;t have a &quot;diff what changed&quot; model.
              Every interaction = full re-render of every component on the page.
              Server reruns <code>app.py</code> top-to-bottom, re-executes all
              12 queries (~1.6 s p50), sends the WHOLE rendered page back over
              WebSocket, browser tears down and rebuilds everything visible.
              That&apos;s why the page freezes for ~1.6 s.
            </p>
          </div>
          <div>
            <p className="font-semibold text-slate-200 mb-1">
              Why is the full snapshot ~840 ms?
            </p>
            <p>
              That&apos;s NOT React rendering slowly — it&apos;s React WAITING for
              fresh data, then doing the diff+paint at the end. The ~840 ms is
              dominated by the 6 SQL queries running in parallel + JSON
              serialization + over-the-wire transport. React&apos;s actual work
              in that ~840 ms is probably ~50-100 ms (the reconcile + chart
              redraw at the end). The other ~700 ms is queries.
            </p>
          </div>
          <div className="bg-slate-900/60 border border-slate-700 rounded p-2">
            <p className="font-semibold text-slate-200 mb-1">
              Timeline of one click (idealized):
            </p>
            <pre className="text-[10px] leading-tight text-slate-300 whitespace-pre overflow-x-auto">
{`t = 0 ms:       Click → POST /api/ingest fires
t = 10 ms:      ✓ React paints click ack (latency bar + text)
                  ↑ this is what you "FEEL" — Streamlit users wait ~1.6 s for
                    this same feedback because their page is frozen mid-rerun

──── meanwhile, on a separate 1.5 s polling timer ────

t = 0 ms:       fetchSnapshot fires (independent of click)
t = 100 ms:     /api/snapshot route receives request
t = 100-700 ms: 6 parallel SQL queries on Interactive Warehouse
t = 700 ms:     JSON response sent to browser
t = 720 ms:     JSON.parse + Zustand store updates
t = 740 ms:     React diffs all subscribed components — finds:
                  - tape: 1 new row added
                  - KPIs: PnL changed
                  - sector totals: shifted
                  - top marks: 1 row's mark moved
t = 830 ms:     Chart.js redraws sector donut + top marks bar
t = 840 ms:     ✓ Browser paints all changes simultaneously
                  ↑ this is the apples-to-apples comparison number
                    ("did the new row land in the tape with full data?")
`}
            </pre>
          </div>
          <div className="bg-slate-900/60 border border-slate-700 rounded p-2">
            <p className="font-semibold text-slate-200 mb-1">
              The honest summary:
            </p>
            <ul className="list-disc list-inside ml-2 space-y-0.5">
              <li>
                <strong className="text-slate-200">React&apos;s actual DOM work per click:</strong>{" "}
                ~10 ms click-ack paint + ~50-100 ms chart redraw when data arrives = <strong>~60-110 ms total React-attributable time</strong>
                {med?.render != null && fullPageMedianMs != null && (
                  <span className="text-emerald-400">
                    {" "}— live: click-ack <strong>{med.render.toFixed(0)} ms</strong> · full snapshot <strong>{fullPageMedianMs.toFixed(0)} ms</strong>
                  </span>
                )}
              </li>
              <li>
                <strong className="text-slate-200">Total user-perceived time to fresh data:</strong>{" "}
                ~840 ms render lifecycle + ~{POLL_WAIT_AVG_MS} ms poll wait + ~1300 ms IT visibility (p50) = <strong>~2.9 s end-to-end (polling path)</strong>
                {fullPageMedianMs != null && med?.it_poll != null && (() => {
                  const totalMs = fullPageMedianMs + POLL_WAIT_AVG_MS + med.it_poll;
                  return (
                    <span className="text-emerald-400">
                      {" "}— live: <strong>{(totalMs / 1000).toFixed(2)} s</strong> ({fullPageMedianMs.toFixed(0)} ms render + {POLL_WAIT_AVG_MS} ms poll wait + {med.it_poll.toFixed(0)} ms IT visibility)
                    </span>
                  );
                })()}
              </li>
              <li>
                {(() => {
                  // React-attributable DOM work = click-ack render (med.render)
                  // + measured chart redraw median across instrumented charts
                  // (chartRenderTimings). Both are real samples, no magic +80.
                  const allChartMs = Object.values(chartRenderTimings).flat();
                  const chartRedrawMs = allChartMs.length > 0
                    ? [...allChartMs].sort((a, b) => a - b)[Math.floor(allChartMs.length / 2)]
                    : null;
                  if (
                    med?.render != null &&
                    fullPageMedianMs != null &&
                    med?.it_poll != null &&
                    chartRedrawMs != null
                  ) {
                    const totalMs = fullPageMedianMs + POLL_WAIT_AVG_MS + med.it_poll;
                    const reactMs = med.render + chartRedrawMs;
                    const pct = Math.max(0, Math.min(100, 100 - (reactMs / totalMs) * 100));
                    return (
                      <>
                        <strong className="text-slate-200">~{pct.toFixed(0)} % of that {(totalMs / 1000).toFixed(2)} s isn&apos;t React</strong>{" "}
                        (live: React = {med.render.toFixed(0)} ms click-ack + {chartRedrawMs.toFixed(0)} ms chart redraw = {reactMs.toFixed(0)} ms total) —
                      </>
                    );
                  }
                  return (
                    <strong className="text-slate-200">~95 % of that 3 s isn&apos;t React</strong>
                  );
                })()}
                {" "}it&apos;s HPA flush + IT visibility + parallel queries +
                network. React isn&apos;t the bottleneck; it&apos;s the part of
                the system that was already nearly instant.
              </li>
            </ul>
          </div>
          <p className="italic">
            Same dashboard. Same click. Two questions, two scopes, two
            correctly-measured numbers — surfaced separately because conflating
            them was the source of the original misleading 125× headline
            (methodology v3).
          </p>
        </div>
      </details>
      <details className="text-xs text-slate-300 bg-slate-900/40 border border-slate-700 rounded p-2 mb-3 leading-relaxed">
        <summary className="cursor-pointer text-slate-200 font-semibold">
          Why does the WebSocket push bar show ~0.10 s? Is it actually measured?
        </summary>
        <div className="mt-2 space-y-3 text-slate-400">
          <p>
            Now: <strong className="text-slate-200">both components are measured</strong>.
            Pre-fix this bar combined a hardcoded 100 ms estimate with a
            bucket-rounded measurement that always rounded to 0 — making the
            bar look suspicious because it was effectively constant.
          </p>
          <table className="text-xs border-collapse">
            <tbody>
              <tr className="border-b border-slate-700 text-slate-300">
                <td className="pr-3 py-1">Component</td>
                <td className="pr-3 py-1">Value</td>
                <td className="py-1">Source</td>
              </tr>
              <tr>
                <td className="pr-3 py-1 text-slate-200">Server scan-detect</td>
                <td className="pr-3 py-1">{scanDetectMedianMs != null ? `${scanDetectRawMs.toFixed(0)} ms` : "(waiting for tape change…)"}</td>
                <td className="py-1 text-emerald-300">
                  MEASURED per tape broadcast: <code>broker_emit_ts − max(INGESTED_TS in batch)</code>.
                  Captures &quot;how stale was the freshest row at the moment
                  the polling reader noticed it&quot;. Server-side, in
                  <code>snowflake-reader.ts</code>; client-side aggregated as
                  <code>scanDetectTimings</code>. Bounded to [0, 5000] ms to
                  drop garbage timestamps.
                </td>
              </tr>
              <tr>
                <td className="pr-3 py-1 text-slate-200">WebSocket wire delivery</td>
                <td className="pr-3 py-1">{wsDeliveryMedianMs != null ? `${wsRawMs.toFixed(0)} ms` : "(measuring…)"}</td>
                <td className="py-1 text-emerald-300">
                  MEASURED on every WS message: <code>client_recv_ts − server_emit_ts</code>.
                  See the green &quot;WebSocket push delivery (live)&quot; box
                  above for the live p50/p95/min/max.
                </td>
              </tr>
            </tbody>
          </table>
          <div>
            <p className="font-semibold text-slate-200 mb-1">
              The bug you spotted (~0.10 s constant pre-fix):
            </p>
            <p>
              The chart was rounding ALL values to the nearest 50 ms for visual
              stability — a leftover from when Chart.js animation was on and we
              wanted to avoid 1-2 ms median jitter tweening every poll. But
              animation is now disabled, so bucketing was redundant stability
              theater that hid real variation.
            </p>
            <p className="mt-1">
              Typical Snowsight-ingress WebSocket wire delivery is 10-30 ms,
              which rounds to <strong>0</strong> in a 50 ms bucket. So the bar
              was showing <code>100 (hardcoded scan) + 0 (rounded wire) = 100 ms</code>
              regardless of actual WS performance — the &quot;measured&quot;
              part was being eaten by the bucket.
            </p>
            <p className="mt-1">
              <strong className="text-slate-200">Fixes:</strong> (a) ALL
              bucketing removed. Every bar shows the raw measured median.
              (b) Server scan-detect is no longer hardcoded — the reader
              stamps each tape broadcast with{" "}
              <code>_scan_detect_ms = Date.now() − max(INGESTED_TS)</code>;
              the client aggregates the median. (c) Chart.js animation stays
              disabled so redraws are clean snaps, not tweens.
            </p>
          </div>
          <p className="italic">
            Bottom line: the WebSocket itself is fast (~10-30 ms wire) and the
            server-side polling lag (~100-300 ms typical, depending on row
            arrival timing within the 200 ms scan interval) is now also a real
            measurement. No remaining hardcoded fudge factors in the swim-lane.
          </p>
        </div>
      </details>
      {/* End-to-end summary — strictly honest narrative (item #14).
          Gated on real WS samples AND a measured scan-detect — without both
          the number would be a fudge. */}
      {hasFullPageRender && fullPageMedianMs != null && hasEnoughSamples && wsDeliveryMedianMs != null && scanDetectMedianMs != null && (
        <div className="text-xs bg-slate-900/60 border border-slate-700 rounded p-2 mb-3 leading-relaxed">
          <div className="font-semibold text-slate-200 mb-1">
            End-to-end click → dashboard fresh (typical):
          </div>
          {(() => {
            const clickPipelineMs =
              (med?.network ?? 0) + (med?.sdk_append ?? 0) + (med?.hpa_flush ?? 0);
            const itVisibilityMs = med?.it_poll ?? 0;
            const wsWireMs = wsDeliveryMedianMs;
            const scanDetectMs = scanDetectMedianMs;
            const wsDetectAndPushMs = scanDetectMs + wsWireMs;
            const reactE2E =
              clickPipelineMs +
              itVisibilityMs +
              wsDetectAndPushMs +
              fullPageMedianMs;
            const streamlitE2E = clickPipelineMs + STREAMLIT_RENDER_MS.typical;
            const delta = streamlitE2E - reactE2E;
            const tied = Math.abs(delta) < 500; // within 0.5 s = effectively tied
            return (
              <>
                <div>
                  React (WebSocket): <strong>~{(reactE2E / 1000).toFixed(2)}s</strong>{" "}
                  <span className="text-slate-500">
                    = click {(clickPipelineMs / 1000).toFixed(2)}s + IT visibility{" "}
                    {(itVisibilityMs / 1000).toFixed(2)}s + WS detect+push{" "}
                    {(wsDetectAndPushMs / 1000).toFixed(2)}s
                    {wsDeliveryMedianMs != null && (
                      <>
                        {" "}
                        <span className="text-emerald-400">
                          (wire={wsDeliveryMedianMs.toFixed(0)} ms measured, n=
                          {wsDeliveryTimings.length})
                        </span>
                      </>
                    )}
                    {" "}+ render {(fullPageMedianMs / 1000).toFixed(2)}s
                  </span>
                </div>
                <div>
                  Streamlit (rerun): <strong>~{(streamlitE2E / 1000).toFixed(2)}s</strong>{" "}
                  <span className="text-slate-500">
                    = click {(clickPipelineMs / 1000).toFixed(2)}s + rerun{" "}
                    {(STREAMLIT_RENDER_MS.typical / 1000).toFixed(1)}s
                  </span>
                </div>
                <div className="mt-2 pt-2 border-t border-slate-700">
                  <strong className="text-slate-200">Verdict:</strong>{" "}
                  {tied ? (
                    <span className="text-amber-300">
                      Effectively tied on raw click-to-fresh-data speed (within{" "}
                      {Math.abs(delta).toFixed(0)} ms). The big React wins are
                      perceived feedback and auto-freshness — not raw latency.
                    </span>
                  ) : delta > 0 ? (
                    <span className="text-violet-300">
                      React (WebSocket) {(delta / 1000).toFixed(2)} s faster end-to-end{" "}
                      <em className="text-slate-400">
                        — and stays fresh between clicks (Streamlit can&apos;t).
                      </em>
                    </span>
                  ) : (
                    <span className="text-slate-300">
                      Streamlit {(Math.abs(delta) / 1000).toFixed(2)} s faster end-to-end
                      <em className="text-slate-400">
                        {" "}
                        — but only when its rerun queries happen to see the new row.
                        If IT hasn&apos;t ingested yet, the user sees stale data and
                        must click again. React stays fresh either way.
                      </em>
                    </span>
                  )}
                </div>
                <div className="mt-2 text-slate-300 leading-relaxed">
                  <div className="font-semibold mb-1">Where React actually wins:</div>
                  <ul className="list-disc list-inside space-y-0.5 text-slate-400">
                    <li>
                      <strong className="text-slate-200">Optimistic row appears:</strong>{" "}
                      {med?.render != null
                        ? (() => {
                            // Honest "row appears" = click pipeline (net+sdk+flush)
                            // + render step. NOT render alone. Compared to Streamlit's
                            // full rerun before its table shows the row.
                            const rowVisibleMs = clickPipelineMs + med.render;
                            const factor = STREAMLIT_RENDER_MS.typical / Math.max(rowVisibleMs, 1);
                            return (
                              <>
                                the just-fired row shows in{" "}
                                <strong>~{(rowVisibleMs / 1000).toFixed(2)} s</strong> (click pipeline{" "}
                                {(clickPipelineMs / 1000).toFixed(2)} s + <strong>{med.render.toFixed(0)} ms</strong> render step)
                                vs <strong>~{(STREAMLIT_RENDER_MS.typical / 1000).toFixed(1)} s</strong> for Streamlit&apos;s full rerun —{" "}
                                <strong>~{factor.toFixed(1)}× faster</strong> to see the row. (The render step itself is ~{med.render.toFixed(0)} ms; the button also shows an instant loading state on click.)
                              </>
                            );
                          })()
                        : (
                            <>
                              the just-fired row shows in ~0.4 s (click pipeline + ~10 ms render step)
                              vs ~{(STREAMLIT_RENDER_MS.typical / 1000).toFixed(1)} s for Streamlit&apos;s rerun —{" "}
                              ~4× faster to see the row (archetypal — fire a click to measure live).
                            </>
                          )
                      }
                    </li>
                    <li>
                      <strong className="text-slate-200">Auto-freshness:</strong>{" "}
                      React polls every 1.5 s; Streamlit goes <em>stale</em> until the
                      next click. If a Streamlit rerun fires before IT has the new row,
                      the user sees old data and must click again.
                    </li>
                    <li>
                      <strong className="text-slate-200">Throughput:</strong>{" "}
                      polling is constant cost regardless of click frequency; Streamlit
                      reruns scale with interaction.
                    </li>
                  </ul>
                </div>
                <details className="mt-3 text-slate-300 leading-relaxed">
                  <summary className="cursor-pointer text-slate-200 font-semibold">
                    Why isn&apos;t React strictly faster end-to-end? (and how to make it so)
                  </summary>
                  <div className="mt-2 space-y-2 text-slate-400">
                    <p>
                      The bottleneck for both forks is the <strong className="text-slate-200">
                      Interactive Table visibility lag</strong> (typically a few hundred ms to
                      ~1.5 s on an XSMALL Interactive Warehouse — live-measured, see the IT-poll
                      segment). Neither architecture can
                      dodge it — the row must commit to RAW_EVENTS and become queryable
                      before any UI can show it. React waits for it via polling cadence;
                      Streamlit waits for it via &quot;the user clicks again because the
                      rerun showed stale data&quot;.
                    </p>
                    <div>
                      <p className="font-semibold text-slate-200 mb-1">
                        Knob 1 — Cut polling cadence (1.5 s → 500 ms)
                      </p>
                      <p>
                        Reduces poll wait from ~0.75 s avg to ~0.25 s avg. Saves ~0.5 s
                        end-to-end. <strong>Implications:</strong>
                      </p>
                      <ul className="list-disc list-inside ml-2 space-y-0.5">
                        <li>
                          <strong className="text-slate-200">3× the snapshot queries.</strong>{" "}
                          Each poll fires 6 queries on the Interactive Warehouse. Going
                          from 1 poll/1.5 s to 1 poll/0.5 s triples query volume per
                          dashboard session. Costs scale linearly.
                        </li>
                        <li>
                          <strong className="text-slate-200">More empty polls.</strong>{" "}
                          When IT hasn&apos;t changed, the snapshot bytes are still
                          fetched and JSON-parsed. The diff is cheap but non-zero.
                        </li>
                        <li>
                          <strong className="text-slate-200">Diminishing returns below ~500 ms.</strong>{" "}
                          IT-poll is ~1.5 s; cutting cadence below the visibility lag
                          itself doesn&apos;t help (the row simply isn&apos;t there yet).
                        </li>
                        <li>
                          <strong className="text-slate-200">Server load.</strong>{" "}
                          /api/snapshot is a fan-out of 6 parallel SQL statements.
                          Tripling the cadence triples warehouse contention if many
                          tabs are open.
                        </li>
                      </ul>
                    </div>
                    <div>
                      <p className="font-semibold text-slate-200 mb-1">
                        Knob 2 — Speed up IT-poll itself
                      </p>
                      <p>
                        Bigger Interactive Warehouse, more aggressive CLUSTER BY on
                        EVENT_ID, or a higher-throughput HPA channel can drop visibility
                        lag from ~1.8 s to ~0.5 s. Saves up to ~1.3 s end-to-end. Costs
                        more credits per hour.
                      </p>
                    </div>
                    <div>
                      <p className="font-semibold text-slate-200 mb-1">
                        Knob 4 — Optimistic prepend (already supported)
                      </p>
                      <p>
                        Toggle &quot;Optimistic prepend&quot; in the Event Generator panel.
                        On click, immediately insert a <em>pending</em> grey row in the
                        tape. When the next snapshot poll arrives, the row swaps to
                        verified. <strong>Apparent</strong> click→fresh latency drops to
                        ~50 ms. The actual fresh-from-IT data still takes ~1.5–2 s — but
                        the user sees something happen instantly.
                      </p>
                    </div>
                    <p className="mt-2">
                      <strong className="text-slate-200">Recommended stack:</strong>{" "}
                      SSE + optimistic prepend + 500 ms poll fallback if SSE drops.
                      That gets you ~50 ms perceived ack, ~200 ms typical refresh
                      after IT visibility, and graceful degradation. Streamlit cannot
                      do any of these — it&apos;s a synchronous full-script-rerun model.
                    </p>
                  </div>
                </details>
                <details className="mt-3 text-slate-300 leading-relaxed">
                  <summary className="cursor-pointer text-slate-200 font-semibold">
                    Why doesn&apos;t Streamlit have a WebSocket data-push channel?
                  </summary>
                  <div className="mt-2 space-y-2 text-slate-400">
                    <p>
                      Streamlit <em>does</em> use WebSocket — but as a{" "}
                      <strong className="text-slate-200">command/render channel</strong>,
                      not a <strong className="text-slate-200">data-push channel</strong>.
                      Totally different runtime model.
                    </p>
                    <div>
                      <p className="font-semibold text-slate-200 mb-1">
                        What happens when you click a button in Streamlit-on-Snowflake:
                      </p>
                      <ol className="list-decimal list-inside ml-2 space-y-0.5">
                        <li>
                          Page loads → browser opens{" "}
                          <code>ws://{`{streamlit-host}`}/_stcore/stream</code>.
                        </li>
                        <li>
                          Streamlit server runs <code>app.py</code> top-to-bottom →
                          executes 12 <code>session.sql(...)</code> calls.
                        </li>
                        <li>
                          Server sends rendered deltas:{" "}
                          <code>{`{type:"delta", id:"metric_1", value:"$1.2M"}`}</code>,{" "}
                          <code>{`{type:"delta", id:"chart_1", figure:{...}}`}</code>,{" "}
                          <code>{`{type:"script_run_finished"}`}</code>.
                        </li>
                        <li>
                          <strong>--- IDLE ---</strong> Page is now STATIC; data is
                          frozen at step 2.
                        </li>
                        <li>
                          User clicks button → browser sends{" "}
                          <code>{`{type:"rerun_script"}`}</code>.
                        </li>
                        <li>
                          Server runs <code>app.py</code> top-to-bottom AGAIN →
                          re-executes all 12 queries.
                        </li>
                        <li>
                          Server sends new deltas for everything.
                        </li>
                      </ol>
                      <p className="mt-1">
                        Streamlit&apos;s WebSocket is essentially a remote-procedure-call:
                        &quot;rerun this script and stream me the rendered output.&quot;
                        It&apos;s the <strong>whole script</strong> every time. There&apos;s
                        no granular &quot;data changed, push me a diff&quot; — that
                        concept doesn&apos;t exist in Streamlit&apos;s runtime.
                      </p>
                    </div>
                    <div>
                      <p className="font-semibold text-slate-200 mb-1">
                        Streamlit does NOT poll in the background.
                      </p>
                      <p>
                        Between clicks, the page is frozen. The data on screen is whatever
                        steps 2 / 6 returned. To get fresh data, the user must interact.
                      </p>
                      <p className="mt-1">
                        Streamlit 1.36+ added{" "}
                        <code>@st.fragment(run_every=&quot;2s&quot;)</code>{" "}
                        for &quot;polling&quot; semantics on individual components — but the
                        parent demo doesn&apos;t use it. Even with <code>run_every</code>,
                        it&apos;s still a script-rerun model: every 2 s the fragment&apos;s
                        body re-executes its queries locally. It&apos;s not data-push;
                        it&apos;s &quot;auto-click the rerun button on a timer.&quot;
                      </p>
                    </div>
                    <div>
                      <p className="font-semibold text-slate-200 mb-1">
                        The fundamental difference:
                      </p>
                      <table className="text-xs border-collapse mt-1">
                        <tbody>
                          <tr className="text-slate-300 border-b border-slate-700">
                            <td className="pr-4 py-1"></td>
                            <td className="pr-4 py-1 text-emerald-300">React fork (this repo)</td>
                            <td className="py-1 text-slate-300">Streamlit parent</td>
                          </tr>
                          <tr>
                            <td className="pr-4 py-1 text-slate-200">WebSocket purpose</td>
                            <td className="pr-4 py-1">One-way data push</td>
                            <td className="py-1">Bidirectional script-rerun RPC</td>
                          </tr>
                          <tr>
                            <td className="pr-4 py-1 text-slate-200">Server work / data change</td>
                            <td className="pr-4 py-1">1 broadcast → all clients</td>
                            <td className="py-1">N reruns (1 per user clicking)</td>
                          </tr>
                          <tr>
                            <td className="pr-4 py-1 text-slate-200">Idle freshness</td>
                            <td className="pr-4 py-1">Auto on IT-change</td>
                            <td className="py-1">Stale until user interacts</td>
                          </tr>
                          <tr>
                            <td className="pr-4 py-1 text-slate-200">Per-user cost</td>
                            <td className="pr-4 py-1">Constant (push is 1:N)</td>
                            <td className="py-1">Linear (each rerun = 12 queries)</td>
                          </tr>
                          <tr>
                            <td className="pr-4 py-1 text-slate-200">50 simultaneous users</td>
                            <td className="pr-4 py-1">1 query stream + 50 pushes</td>
                            <td className="py-1">50 reruns × 12 = 600 queries</td>
                          </tr>
                        </tbody>
                      </table>
                      <p className="mt-1">
                        That&apos;s the throughput-stability win: React WS push is O(1)
                        regardless of user count; Streamlit&apos;s rerun model is O(N).
                      </p>
                    </div>
                  </div>
                </details>
              </>
            );
          })()}
        </div>
      )}
      {hasFullPageRender && fullPageMedianMs != null ? (
        <p className="text-xs text-slate-300 mb-3">
          React render lifecycle: <strong>{fullPageMedianMs.toFixed(0)} ms</strong>{" "}
          (median, n={fullPageRenderTimings.length}) ·{" "}
          Streamlit rerun: <strong>~{STREAMLIT_RENDER_MS.typical} ms</strong>{" "}
          (p50 baseline) →{" "}
          <span className="text-violet-300 font-semibold">
            ~{(STREAMLIT_RENDER_MS.typical / Math.max(fullPageMedianMs, 1)).toFixed(1)}× faster
            on render lifecycle (architectural difference)
          </span>
        </p>
      ) : (
        <p className="text-xs text-amber-400 mb-3 bg-amber-950/30 border border-amber-700/50 rounded px-2 py-1">
          Waiting for first snapshot to land (polling tick or WebSocket push).
          Should appear within ~1.5 s of page load.
        </p>
      )}
      {/* Live WebSocket wire-latency stat — proves the green segment is measured. */}
      <div className="text-xs mb-3 bg-emerald-950/30 border border-emerald-800/50 rounded px-2 py-1 leading-relaxed">
        <strong className="text-emerald-300">WebSocket push delivery (live):</strong>{" "}
        {wsDeliveryMedianMs != null ? (
          <>
            p50 = <strong className="text-emerald-300">{wsDeliveryMedianMs.toFixed(0)} ms</strong>{" "}
            (n={wsDeliveryTimings.length}, last 50 samples)
            {wsDeliveryTimings.length >= 5 && (() => {
              const sorted = [...wsDeliveryTimings].sort((a, b) => a - b);
              const p95 = sorted[Math.floor(sorted.length * 0.95)];
              const min = sorted[0];
              const max = sorted[sorted.length - 1];
              return (
                <span className="text-emerald-400/80">
                  {" "}· p95 = {p95.toFixed(0)} ms · min/max = {min.toFixed(0)}/{max.toFixed(0)} ms
                </span>
              );
            })()}
            <span className="text-slate-400">
              {" "}— measured as <code>(client_recv − server_emit_ts)</code> on
              every WS message arriving on the <code>/api/ws</code> connection
              (tape, kpi, sector, topmarks, optimistic, verified, it_visible).
              Server scan-detect (separate measurement, stamped on tape
              messages):{" "}
              {scanDetectMedianMs != null
                ? `p50 = ${scanDetectRawMs.toFixed(0)} ms (n=${scanSampleCount})`
                : "waiting for first tape change…"}
              .
            </span>
          </>
        ) : (
          <span className="text-slate-400">
            Waiting for first WebSocket message. The <code>/api/ws</code>{" "}
            connection opens on page load via <code>useWebSocket</code>; every
            message carries a server <code>_emit_ts</code> stamp so the wire
            latency is the delta against the browser&apos;s receive time.
            Should appear within ~1 s of page load.
          </span>
        )}
      </div>
      {latencyBars.length === 0 && (
        <div className="mb-2 rounded border border-amber-700/50 bg-amber-950/30 px-3 py-2 text-[11px] text-amber-200/90 leading-snug">
          Only the <span className="text-violet-300 font-medium">render layer</span> is populated
          right now — it&apos;s measured passively from the dashboard&apos;s own snapshot repaint. The{" "}
          <strong>click pipeline</strong>, <strong>IT visibility</strong>, and <strong>WS push</strong>{" "}
          layers are measured from <em>fired events</em>. Click TRADE/MARK below (or flip on{" "}
          <strong>Live market</strong>) and they fill in.
        </div>
      )}
      <div className="h-[160px]">
        <Bar data={chartData} options={options} />
      </div>
      <details className="mt-3 text-xs text-slate-300">
        <summary className="cursor-pointer text-slate-200 font-medium">
          How is this measured? (methodology v7 — WebSocket canonical, SSE retired)
        </summary>
        <div className="mt-2 space-y-3 leading-relaxed">
          {/* Disclaimer: prose below contains illustrative numbers
              (~0.4 s, ~10 ms, ~840 ms etc.). The chart bars + the live-values
              boxes elsewhere on this panel show the actual measurements. */}
          <div className="bg-amber-950/30 border border-amber-700/40 rounded p-2 text-amber-200/90">
            <strong>Heads up:</strong> the prose below uses archetypal
            numbers (~0.4 s click pipeline, ~840 ms render, ~10 ms click ack,
            a few hundred ms – ~1.5 s IT visibility, etc.) to explain concepts and trade-offs.
            The <strong>chart bars above</strong> and the <strong>live-values
            strips</strong> in the &quot;Why are there two render numbers&quot;
            and &quot;Why does the WS bar show ~0.10 s&quot; expanders are the
            authoritative live measurements. If a body number disagrees with a
            live measurement, trust the live measurement.
          </div>
          <div>
            <p className="font-semibold text-slate-200 mb-1">
              Click pipeline: shared infrastructure (live median{" "}
              {latencyBars.length > 0
                ? `${(networkRawMs + sdkRawMs + flushRawMs).toFixed(0)} ms over n=${latencyBars.length}`
                : "no clicks yet"}
              )
            </p>
            <p>
              Both forks now use a byte-identical click pipeline: network +
              SDK append + HPA <code>wait_for_flush</code>. Numbers come from your
              live browser session — median of the most recent{" "}
              {latencyBars.length} click(s). Prior to this session,{" "}
              <code>/api/ingest</code> awaited a server-side IT visibility check
              (a few hundred ms – ~1.5 s) BEFORE returning, which inflated React&apos;s click
              pipeline ~4× vs Streamlit&apos;s parent fork (which doesn&apos;t verify
              visibility on click). That made the comparison apples-to-oranges.
              Fixed by moving the visibility probe to a fire-and-forget background
              task; the result is broadcast via WS as <code>it_visible</code> and
              updates the latency bar post-hoc.
            </p>
          </div>
          <div>
            <p className="font-semibold text-slate-200 mb-1">
              Visibility lag (React only): IT-poll minus poll cadence
            </p>
            <p>
              Even after the architectural fix, the row takes some time to land
              in the Interactive Table. The snapshot poller fires every 1.5 s,
              so on average a fresh row waits 0.75 s before the next poll picks it
              up. If IT-poll exceeds the poll cadence, the EXCESS is user-visible
              latency — that&apos;s the amber &quot;visibility lag&quot; segment.
              Streamlit doesn&apos;t have a corresponding segment because it
              doesn&apos;t poll, but it pays an implicit cost: if a rerun fires
              before IT has the new row, the user sees stale data and must click
              again. (Freshness, not raw speed, is React&apos;s actual win.)
            </p>
          </div>
          <div>
            <p className="font-semibold text-slate-200 mb-1">
              Streamlit rerun: direct burst-clustering measurement
            </p>
            <p className="mb-1 rounded bg-amber-950/40 border border-amber-800/40 px-2 py-1 text-amber-200">
              STORED HISTORICAL BASELINE — measured 2026-05-19 on the parent
              Streamlit demo (different account, old architecture). It is{" "}
              <strong>not</strong> re-measured live in this app; the parent
              Streamlit demo is not deployed on this account. The React bars on
              the chart above ARE measured live this session.
            </p>
            <p>
              Each Streamlit rerun appears in <code>QUERY_HISTORY</code> as a
              tight burst of 8-20 queries from a <code>STPLATSTREAMLIT*</code>{" "}
              user, separated from the next rerun by &gt;500 ms idle. We
              cluster bursts and measure wall-clock from first query start to
              last query end. That delta IS the rerun cost on the Snowflake
              side. Add ~50-200 ms for browser chart render and you have the
              wall-clock the user perceives.
            </p>
            <table className="mt-2 text-xs border-collapse">
              <tbody>
                <tr className="text-slate-400">
                  <td className="pr-4">metric</td>
                  <td className="pr-4">measured</td>
                </tr>
                <tr>
                  <td className="pr-4">bursts observed (n)</td>
                  <td><strong>88</strong> (parent demo, 2026-05-19)</td>
                </tr>
                <tr>
                  <td className="pr-4">p50 (typical) rerun</td>
                  <td><strong>{STREAMLIT_RENDER_MS.typical} ms</strong></td>
                </tr>
                <tr>
                  <td className="pr-4">p95 rerun</td>
                  <td><strong>{STREAMLIT_RENDER_MS.p95} ms</strong></td>
                </tr>
                <tr>
                  <td className="pr-4">shown on chart</td>
                  <td><strong>{STREAMLIT_RENDER_MS.typical} ms</strong> (p50)</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div>
            <p className="font-semibold text-slate-200 mb-1">
              Interactive vs Standard WH — same serving query (re-benchmarked{" "}
              {REACT_FORK_SERVING_MS.measurement_window})
            </p>
            <table className="mt-1 text-xs border-collapse">
              <tbody>
                <tr className="text-slate-400">
                  <td className="pr-4">warehouse</td>
                  <td className="pr-4">n</td>
                  <td className="pr-4">p50</td>
                  <td>p95</td>
                </tr>
                <tr>
                  <td className="pr-4"><code>{PUBLIC_INTERACTIVE_WH}</code></td>
                  <td className="pr-4">{REACT_FORK_SERVING_MS.int_wh.n}</td>
                  <td className="pr-4">{REACT_FORK_SERVING_MS.int_wh.p50} ms</td>
                  <td>{REACT_FORK_SERVING_MS.int_wh.p95} ms</td>
                </tr>
                <tr>
                  <td className="pr-4"><code>{PUBLIC_STANDARD_WH}</code></td>
                  <td className="pr-4">{REACT_FORK_SERVING_MS.std_wh.n}</td>
                  <td className="pr-4">{REACT_FORK_SERVING_MS.std_wh.p50} ms</td>
                  <td>{REACT_FORK_SERVING_MS.std_wh.p95} ms</td>
                </tr>
              </tbody>
            </table>
            <p className="mt-1 text-slate-400">
              This fork&apos;s book-rollup serving query (aggregated at query time
              over the <code>RAW_EVENTS</code> interactive table), 30× per WH,
              server-side <code>TOTAL_ELAPSED_TIME</code>. Interactive is ~2.3×
              faster at p50 and ~5.8× faster at p95 for the identical query. The
              live <strong>WH toggle</strong> above measures your own round-trips
              in real time.
            </p>
            <p className="mt-2 text-slate-500">
              For context, the parent Streamlit demo&apos;s historical per-WH
              single-query profile (2026-05-19, different account, old
              architecture — <em>not</em> re-measured live): INT{" "}
              {STREAMLIT_QUERY_PROFILE_MS.int_wh.p50}/{STREAMLIT_QUERY_PROFILE_MS.int_wh.p95} ms
              (n={STREAMLIT_QUERY_PROFILE_MS.int_wh.n.toLocaleString()}), STD{" "}
              {STREAMLIT_QUERY_PROFILE_MS.std_wh.p50}/{STREAMLIT_QUERY_PROFILE_MS.std_wh.p95} ms
              (n={STREAMLIT_QUERY_PROFILE_MS.std_wh.n.toLocaleString()}). That was a
              simple single-row lookup, not this fork&apos;s query-time rollup.
              Parent <code>app.py</code> issued {STREAMLIT_QUERIES_PER_RERUN.total}{" "}
              queries per rerun; no <code>@st.cache_data</code>.
            </p>
          </div>
          <div>
            <p className="font-semibold text-slate-200 mb-1">
              Render measurement (apples-to-apples scope)
            </p>
            <p>
              The chart&apos;s React render bar is the{" "}
              <strong>full snapshot lifecycle</strong>: from{" "}
              <code>fetchSnapshot</code> start → JSON parse → Zustand notify →
              React reconcile → Chart.js redraws → browser paint, instrumented
              in <code>app/page.tsx</code> via <code>requestAnimationFrame×2</code>.{" "}
              <strong>This matches Streamlit&apos;s burst-cluster scope</strong>{" "}
              (rerun start → DOM painted) — both numbers contain the SQL
              queries, the framework runtime, the chart serialization, and the
              paint cycle.
            </p>
            <p className="mt-2">
              Live measurement this browser session:{" "}
              {fullPageRenderTimings.length === 0 ? (
                <span className="text-slate-500">
                  (no samples yet — first snapshot poll arrives within ~1.5 s)
                </span>
              ) : (
                <>
                  n={fullPageRenderTimings.length} · p50={" "}
                  <strong>{fullPageMedianMs?.toFixed(0)} ms</strong>{" "}
                  · vs Streamlit&apos;s {STREAMLIT_RENDER_MS.typical} ms
                  measured rerun
                </>
              )}
            </p>
            <p className="mt-2 text-slate-400">
              Note: a separate, narrower number — the click-acknowledgment
              paint instrumented in <code>EventGenerator.tsx</code> ({(med?.render ?? 0).toFixed(1)} ms median) — measures only the small text mutation
              next to the fire button. It is real (and the perceived &quot;feels
              instant&quot; win) but it is NOT the end-to-end headline.
            </p>
          </div>
          <div>
            <p className="font-semibold text-slate-200 mb-1">
              Chart.js render audit (live measurement, this browser)
            </p>
            <p>
              The headline &quot;render&quot; number above measures{" "}
              <em>EventGenerator&apos;s click-acknowledgment paint</em> via
              RAF×2. That&apos;s a separate cost from <em>Chart.js</em> chart
              re-renders triggered by snapshot polling. The hook{" "}
              <code>useRenderTiming</code> in{" "}
              <code>web/src/lib/useRenderTiming.ts</code> wraps each chart with{" "}
              <code>useLayoutEffect + RAF</code> to measure render → paint
              wall-clock. Cold-mount samples are dropped (Chart.js plugin
              setup is one-time and not representative).
            </p>
            <table className="mt-1 text-xs border-collapse">
              <tbody>
                <tr className="text-slate-400">
                  <td className="pr-4">chart</td>
                  <td className="pr-4">samples</td>
                  <td className="pr-4">p50</td>
                  <td>p95</td>
                </tr>
                {(["LatencyTimeline", "LatencyComparison", "SectorDonut"] as const).map(
                  (chartName) => {
                    const samples = chartRenderTimings[chartName] ?? [];
                    if (samples.length === 0) {
                      return (
                        <tr key={chartName}>
                          <td className="pr-4"><code>{chartName}</code></td>
                          <td className="pr-4 text-slate-500" colSpan={3}>
                            (no samples yet — fire some events / wait for poll)
                          </td>
                        </tr>
                      );
                    }
                    const sorted = [...samples].sort((a, b) => a - b);
                    const p50 = sorted[Math.floor(sorted.length * 0.5)];
                    const p95 = sorted[Math.floor(sorted.length * 0.95)];
                    return (
                      <tr key={chartName}>
                        <td className="pr-4"><code>{chartName}</code></td>
                        <td className="pr-4">{samples.length}</td>
                        <td className="pr-4">{p50.toFixed(1)} ms</td>
                        <td>{p95.toFixed(1)} ms</td>
                      </tr>
                    );
                  }
                )}
              </tbody>
            </table>
            <p className="mt-1 text-slate-400">
              If any chart&apos;s p95 is consistently &gt; 30 ms, the
              chart-render advantage narrows. Live samples surfaced for
              inspection.
            </p>
          </div>
          <div>
            <p className="font-semibold text-slate-200 mb-1">Methodology change log</p>
            <p className="text-slate-400">
              <strong>v7 (current):</strong> SSE retired entirely.{" "}
              <code>/api/snapshot/stream</code> deleted because SPCS Snowsight
              ingress reaps long-lived <code>EventSource</code> GET responses
              (Istio + Envoy + snowservices-ingress port 5102 — verified May
              2026 against Snowflake-internal docs). Replaced with WebSocket
              push via the existing <code>/api/ws</code> broker. Server-side{" "}
              <code>snowflake-reader.ts</code> scans IT every 200 ms and
              broadcasts a diff to every connected client. Each broadcast
              carries a server <code>_emit_ts</code>; the browser measures wire
              delivery as <code>recv − emit</code> on every message. Same
              ~1.5-2 s end-to-end (p50) as the (also working) Cortex Agent SSE
              POST pattern, with the freshness + click-ack-paint wins
              preserved.
              <br/>
              <strong>v6:</strong> SSE canonical attempt (now retired). First
              draft used <code>EventSource</code> on a long-lived GET; the
              connection died at the SPCS ingress and 0 events arrived even
              with X-Accel-Buffering, padding chunks, and 15 s heartbeats.
              <br/>
              <strong>v5:</strong> IT-poll architectural fix.{" "}
              <code>/api/ingest</code> now returns at HPA flush ack (~0.4 s)
              instead of awaiting visibility (~1.9 s). Click pipelines are
              apples-to-apples. End-to-end story honest: in polling mode React
              and Streamlit were roughly tied on raw speed (~1.5–2 s p50).
              <br/>
              <strong>v4:</strong> swim-lane visualization replacing the
              misleading stacked-bar that summed parallel pipelines as if
              sequential. Still over-stated React&apos;s win because IT-poll
              was inside the click pipeline.
              <br/>
              <strong>v3:</strong> direct burst-clustering measurement of
              Streamlit. React side measured only post-data render+paint, which
              created a scope mismatch (~125× misleading headline).
              <br/>
              <strong>v2:</strong> bottoms-up Streamlit (12 queries × p50 +
              estimated framework residual). Over-estimated typical by ~30%.
              <br/>
              <strong>v1:</strong> Streamlit baseline numbers from prose.
              Replaced for being unsourced.
            </p>
          </div>
          <div>
            <p className="font-semibold text-slate-200 mb-1">To re-measure on your account</p>
            <p>
              The exact burst-clustering SQL is in the comment block at the top
              of <code>web/src/lib/baseline.ts</code>. Filter is{" "}
              <code>USER_NAME LIKE &apos;STPLATSTREAMLIT%&apos;</code>.
            </p>
          </div>
        </div>
      </details>
    </div>
  );
}
