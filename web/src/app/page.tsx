"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { LatencyTimeline } from "@/components/LatencyTimeline";
import { LatencyComparison } from "@/components/LatencyComparison";
import { LatencyStats } from "@/components/LatencyStats";
import { LiveTape } from "@/components/LiveTape";
import { KpiTiles } from "@/components/KpiTiles";
import { SectorDonut } from "@/components/SectorDonut";
import { TopMarks } from "@/components/TopMarks";
import { EventGenerator } from "@/components/EventGenerator";
import { HpaStatus } from "@/components/HpaStatus";
import { StressTest } from "@/components/StressTest";
import { BurstStats } from "@/components/BurstStats";
import { Watchlist } from "@/components/Watchlist";
import { TradesPerHour } from "@/components/TradesPerHour";
import { PipelineObservability } from "@/components/PipelineObservability";
import { ArchitectureDiagram } from "@/components/ArchitectureDiagram";
import { DayMetrics } from "@/components/DayMetrics";
import { useDashboardStore } from "@/lib/store";
import {
  POLL_INTERVAL_MS,
  COLD_START_THRESHOLD_MS,
  WARM_POLL_THRESHOLD_MS,
  PUBLIC_APP_FQN,
  PUBLIC_INTERACTIVE_WH,
  PUBLIC_STANDARD_WH,
} from "@/lib/constants";

export default function LiveDeskPage() {
  const setTape = useDashboardStore((s) => s.setTape);
  const setKpi = useDashboardStore((s) => s.setKpi);
  const setSector = useDashboardStore((s) => s.setSector);
  const setTopMarks = useDashboardStore((s) => s.setTopMarks);
  const setHpaStatus = useDashboardStore((s) => s.setHpaStatus);
  const setObservability = useDashboardStore((s) => s.setObservability);
  const tapeLen = useDashboardStore((s) => s.tape.length);
  const firstEvent = useDashboardStore((s) => s.tape[0]);
  const warehouseMode = useDashboardStore((s) => s.warehouseMode);
  const setWarehouseMode = useDashboardStore((s) => s.setWarehouseMode);
  const setDayMetrics = useDashboardStore((s) => s.setDayMetrics);
  const setInitialLoadDone = useDashboardStore((s) => s.setInitialLoadDone);
  const channelMode = useDashboardStore((s) => s.channelMode);
  const timeTravelOffset = useDashboardStore((s) => s.timeTravelOffset);
  const [lastSnapshotMs, setLastSnapshotMs] = useState<number | null>(null);
  const [snapshotErr, setSnapshotErr] = useState<string | null>(null);
  const [tickKey, setTickKey] = useState(0);
  const [lastTapeFetchedLen, setLastTapeFetchedLen] = useState<number | null>(null);
  // Per-mode snapshot call counter. Polling is the only client-fetch path;
  // WebSocket pushes are counted separately as Nw via wsMessageCount.
  const [snapshotCallCounts, setSnapshotCallCounts] = useState({ polling: 0, timeTravel: 0 });
  // WebSocket diagnostics for the strip (proves WS push is actually working
  // in production; the wire-latency banner relies on these messages arriving).
  const wsState = useDashboardStore((s) => s.wsState);
  const wsMessageCount = useDashboardStore((s) => s.wsMessageCount);
  const wsStateLabel = wsState === "open"
    ? "open"
    : wsState === "connecting"
      ? "connecting…"
      : wsState === "error"
        ? "errored"
        : "closed";

  // Error-recovery banner: latches on after 3+ consecutive snapshot failures
  // and clears once a successful poll lands. See triggerReconnectedToast.
  const [consecutiveErrorCount, setConsecutiveErrorCount] = useState(0);
  const [showReconnected, setShowReconnected] = useState(false);
  // Debounce the reconnected toast — 4 s gate prevents flicker if the
  // network flaps quickly between failures and recoveries.
  const lastReconnectedToastRef = useRef<number>(0);

  // Cold-start callout state — driven by a rolling window of the last 3 polls
  // so the banner can re-trigger if the warehouse suspends mid-session.
  const recentPollsRef = useRef<number[]>([]);
  const [showColdStart, setShowColdStart] = useState(false);

  // Auto-hide the reconnected toast after 2 s.
  useEffect(() => {
    if (!showReconnected) return;
    const t = setTimeout(() => setShowReconnected(false), 2000);
    return () => clearTimeout(t);
  }, [showReconnected]);

  // Helper for the 3 fetch paths to safely show reconnected toast (debounced)
  const triggerReconnectedToast = useCallback(() => {
    const now = Date.now();
    if (now - lastReconnectedToastRef.current >= 4000) {
      lastReconnectedToastRef.current = now;
      setShowReconnected(true);
    }
  }, []);

  // Surface fullPageRender median in the diagnostic strip so users can see
  // the apples-to-apples render number without opening the comparison panel.
  const fullPageRenderTimings = useDashboardStore((s) => s.fullPageRenderTimings);
  const { fullPaintMedian, fullPaintSamples } = (() => {
    if (fullPageRenderTimings.length === 0) {
      return { fullPaintMedian: null as number | null, fullPaintSamples: 0 };
    }
    const sorted = [...fullPageRenderTimings].sort((a, b) => a - b);
    return {
      fullPaintMedian: sorted[Math.floor(sorted.length / 2)],
      fullPaintSamples: fullPageRenderTimings.length,
    };
  })();

  // Live measurements piped into the doc-table prose so we never lie about
  // hardcoded numbers (~30 ms HPA flush, ~50 ms browser update, ~2.2 s e2e).
  // When no samples exist yet, fall back to archetypal hints with explicit
  // "(no clicks yet)" / "(measuring…)" wording.
  const latencyBars = useDashboardStore((s) => s.latencyBars);
  const chartRenderTimings = useDashboardStore((s) => s.chartRenderTimings);
  const liveDocStats = (() => {
    const median = (xs: number[]): number | null => {
      if (xs.length === 0) return null;
      const sorted = [...xs].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    };
    const flushMs = median(latencyBars.map((b) => b.flush_committed_ms));
    const networkMs = median(latencyBars.map((b) => b.network_ms));
    const sdkMs = median(latencyBars.map((b) => b.sdk_appended_ms));
    const itPollMs = median(latencyBars.map((b) => b.it_poll_ms));
    // Browser update = chart render-and-paint median across all instrumented charts.
    const allChartMs = Object.values(chartRenderTimings).flat();
    const browserUpdateMs = median(allChartMs);
    const fmt = (ms: number | null, fallback: string) =>
      ms == null ? fallback : ms < 1000 ? `${ms.toFixed(0)} ms` : `${(ms / 1000).toFixed(2)} s`;
    return {
      n: latencyBars.length,
      flushLabel: fmt(flushMs, "no clicks yet"),
      networkLabel: fmt(networkMs, "—"),
      sdkLabel: fmt(sdkMs, "—"),
      itPollLabel: fmt(itPollMs, "—"),
      browserUpdateLabel: fmt(browserUpdateMs, "measuring…"),
      // Click → painted total = network + sdk + flush + it_poll + chart render.
      // Includes IT visibility wait. Used in the "tape-visible total" sentence.
      e2eClickToPaintedLabel: (() => {
        if (networkMs == null || sdkMs == null || flushMs == null || itPollMs == null || browserUpdateMs == null) {
          return "measuring…";
        }
        const total = networkMs + sdkMs + flushMs + itPollMs + browserUpdateMs;
        return total < 1000 ? `${total.toFixed(0)} ms` : `${(total / 1000).toFixed(2)} s`;
      })(),
    };
  })();

  useEffect(() => {
    let alive = true;

    // When time-travel is active, fetch once and don't poll
    if (timeTravelOffset > 0) {
      const fetchTimeTravel = async () => {
        setSnapshotCallCounts((c) => ({ ...c, timeTravel: c.timeTravel + 1 }));
        const t0 = performance.now();
        // Apples-to-apples: measure from fetch start, same scope as polling
        const tApplesToApplesStart = t0;
        try {
          const res = await fetch(`/api/snapshot/at?offset=${timeTravelOffset}&t=${Date.now()}`, {
            cache: "no-store",
          });
          if (!res.ok || !alive) return;
          const data = await res.json();
          if (!alive || data.error) return;
          if (data.tape) { setTape(data.tape); setLastTapeFetchedLen(data.tape.length); }
          if (data.kpi) setKpi(data.kpi);
          if (data.sector) setSector(data.sector);
          if (data.topmarks) setTopMarks(data.topmarks);
          if (data.dayMetrics) setDayMetrics(data.dayMetrics);
          // Apples-to-apples render measurement (Bug #1 fix: also fires on time-travel path)
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              useDashboardStore
                .getState()
                .addFullPageRenderTiming(performance.now() - tApplesToApplesStart);
            });
          });
          setLastSnapshotMs(performance.now() - t0);
          setSnapshotErr(null);
          setInitialLoadDone();
          // Bug #2 fix: reset error count + reconnected toast on time-travel path
          setConsecutiveErrorCount((prev) => {
            if (prev >= 3) triggerReconnectedToast();
            return 0;
          });
        } catch (e) {
          if (alive) setSnapshotErr(e instanceof Error ? e.message : String(e));
        }
      };
      fetchTimeTravel();
      const i4 = setInterval(() => setTickKey((k) => k + 1), 1000);
      return () => { alive = false; clearInterval(i4); };
    }

    // Polling mode (default) — the only supported channel mode after SSE
    // retirement. WebSocket push is independent and runs in lib/ws.ts.
    const fetchSnapshot = async () => {
      setSnapshotCallCounts((c) => ({ ...c, polling: c.polling + 1 }));
      const t0 = performance.now();
      // Apples-to-apples render measurement starts HERE (snapshot fetch start),
      // matching Streamlit's burst span (rerun start → DOM painted).
      // Streamlit's 2519 ms includes 12 sequential SQL queries + Python script
      // + Plotly + DOM + paint. To compare scope-for-scope, our number must
      // also include the fetch + queries + parse + render + paint, NOT just
      // the post-data render+paint.
      const tApplesToApplesStart = t0;
      try {
        const endpoint = warehouseMode === "standard"
          ? `/api/snapshot/standard?t=${Date.now()}`
          : `/api/snapshot?t=${Date.now()}`;
        const res = await fetch(endpoint, {
          cache: "no-store",
          headers: { "Cache-Control": "no-cache" },
        });
        if (!res.ok) {
          if (alive) {
            setSnapshotErr(`HTTP ${res.status}`);
            setConsecutiveErrorCount((c) => c + 1);
          }
          return;
        }
        const data = await res.json();
        if (!alive) return;
        if (data.error) {
          setSnapshotErr(String(data.error).slice(0, 120));
          setConsecutiveErrorCount((c) => c + 1);
          return;
        }
        if (data.tape) {
          setTape(data.tape);
          setLastTapeFetchedLen(data.tape.length);
        }
        if (data.kpi) setKpi(data.kpi);
        if (data.sector) setSector(data.sector);
        if (data.topmarks) setTopMarks(data.topmarks);
        if (data.dayMetrics) setDayMetrics(data.dayMetrics);
        // Apples-to-apples render measurement: full dashboard repaint after
        // a polled snapshot batch update. RAF×2 captures the moment all
        // subscribed components (KpiTiles, LiveTape, SectorDonut, TopMarks,
        // DayMetrics, charts) have committed and the browser has painted.
        // Span: fetch start → DOM painted (matches Streamlit's burst span:
        // rerun start → DOM painted). Includes queries, network, parse,
        // render, paint — all four of those are also inside Streamlit's 2519 ms.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const fullPaintMs = performance.now() - tApplesToApplesStart;
            useDashboardStore.getState().addFullPageRenderTiming(fullPaintMs);
          });
        });
        const elapsed = performance.now() - t0;
        setLastSnapshotMs(elapsed);
        setSnapshotErr(null);
        setInitialLoadDone();

        // Reset error count and show the reconnected toast if we just recovered.
        setConsecutiveErrorCount((prev) => {
          if (prev >= 3) triggerReconnectedToast();
          return 0;
        });

        // Cold-start callout: rolling window of last 3 polls so the banner can
        // re-trigger if the warehouse suspends mid-session.
        recentPollsRef.current = [...recentPollsRef.current, elapsed].slice(-3);
        const recent = recentPollsRef.current;
        // Cold-start heuristic uses thresholds from lib/constants.ts so the
        // numbers don't drift between the heuristic and any user-facing copy
        // that quotes them. See COLD_START_THRESHOLD_MS docstring for why
        // 2.5 s is the floor (warm-WH + Next.js JIT lands ~1.1 s typical).
        const anySlowInLast3 = recent.some((ms) => ms > COLD_START_THRESHOLD_MS);
        const allFastInLast3 = recent.length === 3 && recent.every((ms) => ms < WARM_POLL_THRESHOLD_MS);
        if (anySlowInLast3 && !useDashboardStore.getState().isInitialLoad) {
          setShowColdStart(true);
        } else if (allFastInLast3) {
          setShowColdStart(false);
        }
      } catch (e) {
        if (alive) {
          setSnapshotErr(e instanceof Error ? e.message : String(e));
          setConsecutiveErrorCount((c) => c + 1);
        }
      }
    };
    const fetchHealth = async () => {
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        const data = await res.json();
        if (!alive) return;
        const channels = data.channel_count ?? 0;
        const status = data.status === "ok" || data.status === "healthy"
          ? "healthy"
          : data.status === "degraded"
          ? "degraded"
          : "unreachable";
        setHpaStatus({
          channel_count: channels,
          pipe_name: data.pipe_name || "RAW_EVENTS-STREAMING",
          status,
        });
      } catch {
        if (!alive) return;
        setHpaStatus({ channel_count: 0, pipe_name: "", status: "unreachable" });
      }
    };
    fetchSnapshot();
    fetchHealth();
    const fetchObservability = async () => {
      try {
        const res = await fetch("/api/observability", { cache: "no-store" });
        if (!res.ok || !alive) return;
        const data = await res.json();
        if (!alive || data.error) return;
        setObservability({
          watchlist: data.watchlist || [],
          hourly_trades: data.hourly_trades || [],
          ingest_stats: data.ingest_stats || null,
          throughput_evt_per_min: data.throughput_evt_per_min || 0,
          total_events_24h: data.total_events_24h || 0,
          it_lag_seconds: data.it_lag_seconds || 0,
        });
      } catch {
        /* swallow */
      }
    };
    fetchObservability();
      const i1 = setInterval(fetchSnapshot, POLL_INTERVAL_MS);
    const i2 = setInterval(fetchHealth, 5000);
    const i3 = setInterval(fetchObservability, 5000);
    const i4 = setInterval(() => setTickKey((k) => k + 1), 1000);
    return () => {
      alive = false;
      clearInterval(i1);
      clearInterval(i2);
      clearInterval(i3);
      clearInterval(i4);
      // Reset error state on channel/mode switch so a stuck red
      // banner from polling mode doesn't carry into SSE / time-travel mode.
      setConsecutiveErrorCount(0);
      setSnapshotErr(null);
    };
  }, [setTape, setKpi, setSector, setTopMarks, setHpaStatus, setObservability, setDayMetrics, setInitialLoadDone, warehouseMode, channelMode, timeTravelOffset, triggerReconnectedToast]);

  return (
    <div className="space-y-6">
      {/* Live diagnostic strip — proves polling is alive */}
      <div className="rounded-md border border-slate-700 bg-slate-800/40 px-3 py-2 text-xs font-mono flex items-center justify-between flex-wrap gap-2">
        <span className="text-slate-400">
          Tick: <span className="text-snow-blue">{tickKey}s</span> · calls:{" "}
          <span className="text-amber-300">
            {snapshotCallCounts.polling}p / {snapshotCallCounts.timeTravel}t
          </span>
          {" · "}
          <span className="text-emerald-300">
            WS: {wsStateLabel}
            {" · "}Nw={wsMessageCount}
          </span>{" "}
          · Last snapshot:{" "}
          {lastSnapshotMs != null ? (
            <span className="text-green-400">{lastSnapshotMs.toFixed(0)}ms</span>
          ) : (
            <span className="text-slate-500">never</span>
          )}
          {" · "}
          Tape: store={" "}
          <span className="text-cyan-300">{tapeLen}</span> rows · last fetch={" "}
          <span className="text-cyan-300">
            {lastTapeFetchedLen != null ? lastTapeFetchedLen : "—"}
          </span>{" "}
          rows
          {firstEvent && (
            <>
              {" · top: "}
              <span className="text-violet-300">
                {firstEvent.event_type}/{firstEvent.position_id}
              </span>{" "}
              ({firstEvent.event_id?.slice(0, 8)}…)
            </>
          )}
          {fullPaintMedian != null && (
            <>
              {" · FullPaint: "}
              <span className="text-violet-300">{fullPaintMedian.toFixed(0)}ms</span>{" "}
              <span className="text-slate-500">(n={fullPaintSamples})</span>
            </>
          )}
        </span>
        <div className="flex items-center gap-3">
          {/* Warehouse toggle */}
          <span
            className="text-slate-500 cursor-help"
            title={`Which Snowflake warehouse the snapshot route uses. INTERACTIVE = ${PUBLIC_INTERACTIVE_WH} (Interactive XSMALL, AUTO_SUSPEND=86400 i.e. 24 h, queries Interactive Tables for sub-second response, ~50-150 ms median). STANDARD = ${PUBLIC_STANDARD_WH} (Standard XSMALL, AUTO_SUSPEND=30 s, queries the same data via Dynamic-Table refresh, ~250-800 ms median, suspends fast = cold-start risk). Toggle to demo the Interactive vs Standard latency delta on the swim-lane chart.`}
          >
            WH: ⓘ
          </span>
          <label
            className="flex items-center gap-1 cursor-pointer"
            title={`Interactive Warehouse (${PUBLIC_INTERACTIVE_WH}, XSMALL, AUTO_SUSPEND=86400 s = 24 h) backed by Interactive Tables. Stays warm. Sub-second median snapshot fetch. Recommended for live dashboards.`}
          >
            <input
              type="radio"
              name="wh-mode"
              value="interactive"
              checked={warehouseMode === "interactive"}
              onChange={() => setWarehouseMode("interactive")}
              className="accent-snow-blue"
            />
            <span className={warehouseMode === "interactive" ? "text-snow-blue" : "text-slate-400"}>
              Interactive
            </span>
          </label>
          <label
            className="flex items-center gap-1 cursor-pointer"
            title={`Standard Warehouse (${PUBLIC_STANDARD_WH}, XSMALL, AUTO_SUSPEND=30 s) querying Dynamic Tables. Suspends after 30 s idle = cold-start spike on first click after a pause. Used to show the latency cost of letting a warehouse idle-suspend, vs Interactive which stays warm.`}
          >
            <input
              type="radio"
              name="wh-mode"
              value="standard"
              checked={warehouseMode === "standard"}
              onChange={() => setWarehouseMode("standard")}
              className="accent-amber-400"
            />
            <span className={warehouseMode === "standard" ? "text-amber-400" : "text-slate-400"}>
              Standard
            </span>
          </label>

          {/* Channel mode toggle — SSE removed (SPCS ingress reaps long-lived
              EventSource GETs; see memory rule on SPCS streaming). Polling is
              the canonical client-fetch path; instant push for events,
              optimistic + verified, IT-poll, KPI/tape/sector/topmarks updates
              all flow through the WebSocket /api/ws connection automatically. */}
          <span className="text-slate-600">|</span>
          <span
            className="text-slate-500 cursor-help"
            title="How the browser receives data from the server. The dashboard uses TWO complementary channels: (1) HTTP polling at /api/snapshot every 1.5 s for periodic full-snapshot reconciliation, AND (2) a long-lived WebSocket at /api/ws for instant pushes (optimistic, verified, IT-visible, KPI/tape/sector/topmarks deltas). SSE was retired because SPCS ingress (Istio/Envoy) reaps long-lived EventSource GET responses in production."
          >
            Ch: ⓘ
          </span>
          <label
            className="flex items-center gap-1 cursor-pointer"
            title="Polling 1.5 s + WebSocket push. Polling provides a periodic full-snapshot truth source (handles dropped messages, reconnection, tab-switch rehydration). WebSocket pushes give sub-100 ms wire latency for click-to-tape so the UI feels instant. Both run concurrently and the store reconciles them. This is the only supported channel mode after the SSE retirement."
          >
            <input
              type="radio"
              name="ch-mode"
              value="polling"
              checked={true}
              readOnly
              className="accent-green-400"
            />
            <span className="text-green-400">
              Polling 1.5s + WS push
            </span>
          </label>

          {snapshotErr ? (
            <span className="text-red-400">⚠ {snapshotErr}</span>
          ) : (
            <span className="text-slate-500">
              polling {warehouseMode === "standard" ? "/api/snapshot/standard" : "/api/snapshot"} every 1.5s · WS /api/ws for instant pushes
            </span>
          )}
        </div>
      </div>

      {/* Error-recovery banner — fires after 3+ consecutive failures */}
      {consecutiveErrorCount >= 3 && (
        <div className="fixed top-0 left-0 right-0 z-50 bg-red-600 text-white text-sm font-medium px-4 py-2 text-center">
          Live data paused — last fetch failed {consecutiveErrorCount}x. Retrying every 1.5s.
        </div>
      )}
      {showReconnected && (
        <div className="fixed top-0 left-0 right-0 z-50 bg-green-600 text-white text-sm font-medium px-4 py-2 text-center">
          ✓ Reconnected
        </div>
      )}

      {/* Cold-start callout banner */}
      {showColdStart && (
        <div className="rounded-md border border-amber-700 bg-amber-900/40 px-4 py-2 text-sm text-amber-200">
          Recent poll &gt; {(COLD_START_THRESHOLD_MS / 1000).toFixed(1)} s — could be warehouse cold-start (auto-suspend
          fired) or transient cloud-services overhead. Subsequent polls will
          be faster. (Note: <code>{PUBLIC_INTERACTIVE_WH}</code> is set to{" "}
          <code>AUTO_SUSPEND = 86400</code> = 24 h, so this should rarely fire
          during a normal day.)
        </div>
      )}

      {/* What this demo proves — expandable */}
      <details className="rounded-lg border border-slate-700 bg-slate-800/50 overflow-hidden">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium hover:bg-slate-800/70 select-none">
          What this demo proves about Snowflake — click to expand
        </summary>
        <div className="px-4 py-3 border-t border-slate-700 text-xs text-slate-300 space-y-3">
          <p>
            Buy-side trading desks have historically needed <strong>four separate systems</strong>:
            Kafka for ingest, Redis for hot reads, Spark for stream processing, a custom dashboard.
            This demo collapses all four into one Snowflake account.
          </p>
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-slate-700">
                <th className="text-left p-2 text-slate-400 font-medium">#</th>
                <th className="text-left p-2 text-slate-400 font-medium">Snowflake product</th>
                <th className="text-left p-2 text-slate-400 font-medium">What it does here</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              <tr><td className="p-2">1</td><td className="p-2"><strong>Snowpipe Streaming HPA</strong> (GA Sept 2025)</td><td className="p-2">Sub-second row-level ingest with <code className="text-snow-blue">wait_for_flush()</code> for <strong className="text-emerald-300">{liveDocStats.flushLabel}</strong> commit acknowledgement (live median, n={liveDocStats.n})</td></tr>
              <tr><td className="p-2">2</td><td className="p-2"><strong>Interactive Tables</strong></td><td className="p-2">Hot serving layer is <code>PORTFOLIO_LIVE</code> (Interactive Table, <code>CLUSTER BY (SECTOR, ISSUER)</code>) — Snowpipe Streaming writes raw events to <code>RAW_EVENTS</code>, the IT auto-refreshes from there. Replaces Redis.</td></tr>
              <tr><td className="p-2">3</td><td className="p-2"><strong>Interactive Warehouses</strong></td><td className="p-2">Dedicated compute SKU bound to Interactive Tables — sub-second concurrent reads</td></tr>
              <tr><td className="p-2">4</td><td className="p-2"><strong>Snowflake Apps Deploy</strong></td><td className="p-2">Next.js + WebSocket on SPCS — Snowsight-gated, OAuth via <code>/snowflake/session/token</code></td></tr>
              <tr><td className="p-2">5</td><td className="p-2"><strong>Cortex Agent</strong> (Analyst + Search)</td><td className="p-2">Natural-language Q&amp;A over the live book — {`"Show me Apollo's exposure"`}</td></tr>
              <tr><td className="p-2">6</td><td className="p-2"><strong>Semantic View</strong></td><td className="p-2">Metadata-rich layer with synonyms + sample values — no model training</td></tr>
            </tbody>
          </table>
          <p className="text-slate-400">
            The producer side runs <strong>outside Snowflake</strong> on a GCP VM (HPA SDK is a client
            library). Everything else — serving, analytics, AI, UI hosting — is in-Snowflake.
          </p>
        </div>
      </details>

      {/* Architecture diagram — expandable, sits next to "What this demo proves" */}
      <details className="rounded-lg border border-slate-700 bg-slate-800/50 overflow-hidden">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium hover:bg-slate-800/70 select-none">
          Architecture — click to expand
        </summary>
        <div className="px-4 py-3 border-t border-slate-700">
          <ArchitectureDiagram />
        </div>
      </details>

      {/* Latency Comparison — React vs Streamlit baseline */}
      <LatencyComparison />

      {/* Latency Timeline — full width headline */}
      <section>
        <h2 className="text-lg font-semibold mb-2">
          Latency Timeline — Click → Visible in Interactive Table → Painted
        </h2>
        <p className="text-xs text-slate-400 mb-3">
          Each bar is one click, broken into <strong>5 measured segments</strong>. Snowflake commits
          via <code className="text-snow-blue">wait_for_flush()</code> in <strong className="text-emerald-300">{liveDocStats.flushLabel}</strong> (live median, n={liveDocStats.n}); the row is
          queryable from any other connection within a few hundred ms; React renders the diff in &lt;16ms.
        </p>
        <LatencyTimeline />
        <LatencyStats />

        {/* How each latency segment is measured — expandable */}
        <details className="mt-3 rounded-lg border border-slate-700 bg-slate-800/30 overflow-hidden">
          <summary className="cursor-pointer px-4 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800/50 select-none">
            ⓘ How each latency segment is measured
          </summary>
          <div className="px-4 py-3 border-t border-slate-700 text-xs text-slate-300">
            <p className="mb-3">
              The chart breaks <strong>click → row visible in Interactive Table → painted on screen</strong> into
              five real measurements, not modeled estimates. Each is captured at a known checkpoint.
            </p>
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b border-slate-700">
                  <th className="text-left p-2 text-slate-400 font-medium">#</th>
                  <th className="text-left p-2 text-slate-400 font-medium">Segment</th>
                  <th className="text-left p-2 text-slate-400 font-medium">Where it&apos;s measured</th>
                  <th className="text-left p-2 text-slate-400 font-medium">Typical</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                <tr>
                  <td className="p-2"><span className="inline-block w-2 h-2 rounded-sm" style={{background:"#67E8F9"}}></span> 1</td>
                  <td className="p-2"><strong>Network</strong> (browser ↔ SPCS ↔ VM)</td>
                  <td className="p-2"><code>performance.now()</code> at click → POST returns. Subtract VM-internal time.</td>
                  <td className="p-2">50-150 ms</td>
                </tr>
                <tr>
                  <td className="p-2"><span className="inline-block w-2 h-2 rounded-sm" style={{background:"#34D399"}}></span> 2</td>
                  <td className="p-2"><strong>HPA SDK append</strong></td>
                  <td className="p-2">VM FastAPI handler: <code>t_in_handler</code> → after <code>channel.append_row()</code></td>
                  <td className="p-2">0.1-2 ms</td>
                </tr>
                <tr>
                  <td className="p-2"><span className="inline-block w-2 h-2 rounded-sm" style={{background:"#29B5E8"}}></span> 3</td>
                  <td className="p-2"><strong>HPA flush commit</strong></td>
                  <td className="p-2"><code>wait_for_flush(timeout=10)</code> blocks until Snowflake server confirms commit</td>
                  <td className="p-2">30-200 ms</td>
                </tr>
                <tr>
                  <td className="p-2"><span className="inline-block w-2 h-2 rounded-sm" style={{background:"#FBBF24"}}></span> 4</td>
                  <td className="p-2"><strong>IT poll</strong></td>
                  <td className="p-2">Server-side <code>checkVisibleQuick()</code> in <code>/api/ingest</code> polls IT every 100 ms; on first appearance the WebSocket broker broadcasts <code>it_visible</code> to the browser</td>
                  <td className="p-2">200-500 ms</td>
                </tr>
                <tr>
                  <td className="p-2"><span className="inline-block w-2 h-2 rounded-sm" style={{background:"#A78BFA"}}></span> 5</td>
                  <td className="p-2"><strong>React render</strong></td>
                  <td className="p-2"><code>requestAnimationFrame</code> × 2 after store update — measures real paint cycle</td>
                  <td className="p-2"><strong>{liveDocStats.browserUpdateLabel}</strong></td>
                </tr>
              </tbody>
            </table>
            <p className="mt-3 text-slate-400">
              <strong>Why segment 5 matters:</strong> The Streamlit version of this demo intentionally hides
              render time because the full-script-rerun is 3-5 s and dominates the chart. React renders
              the diff in one paint cycle, so we show it. That&apos;s the whole point of this fork.
            </p>
          </div>
        </details>
      </section>

      <hr className="border-slate-700" />

      {/* Generator + Live Tape side by side */}
      <section className="grid grid-cols-12 gap-4">
        <div className="col-span-3 space-y-4">
          <EventGenerator />
          <HpaStatus />
          <StressTest />
          <BurstStats />
        </div>
        <div className="col-span-9">
          <LiveTape />
          <details className="mt-3 bg-slate-800 rounded p-3 text-xs text-slate-300">
            <summary className="cursor-pointer text-slate-200 font-medium">
              Why does the tape lag the click → painted timeline by a few seconds?
            </summary>
            <div className="mt-2 space-y-2 leading-relaxed">
              <p>
                The latency timeline above measures the <em>fastest</em> path: the click&apos;s
                own POST response carries an immediate server-side IT-poll
                (<code>SELECT 1 FROM RAW_EVENTS WHERE EVENT_ID = &lt;just-flushed&gt;</code>),
                so it confirms visibility ~250–1800 ms after the wait_for_flush ack and paints
                that single row directly. <strong>It is not the tape</strong> — the tape only
                refreshes when the next snapshot poll lands.
              </p>
              <p>The Live Event Tape adds 4 sources of latency on top of that:</p>
              <ol className="list-decimal list-inside space-y-1 ml-2">
                <li>
                  <strong>Polling phase offset (0 – 1500 ms):</strong> snapshot polls fire every
                  1.5 s on a fixed cadence. If your click lands just after a poll, the next
                  poll is up to 1.5 s away. Average wait = 750 ms.
                </li>
                <li>
                  <strong>Heavier query than the IT-poll (~300 – 800 ms):</strong> the tape query
                  joins <code>RAW_EVENTS</code> with <code>POSITIONS_DIM</code>,
                  computes <code>AGE_SEC</code>, orders by <code>EVENT_TS DESC</code>, and
                  returns 30 rows. The IT-poll is a single point lookup on
                  <code>EVENT_ID</code>. Order-by-limit queries on Interactive Tables also have
                  a slightly wider read-consistency window than point lookups because the new
                  row must be merged into the sorted result set.
                </li>
                <li>
                  <strong>Snapshot fan-out (live{" "}
                  {lastSnapshotMs != null ? `${lastSnapshotMs.toFixed(0)} ms` : "measuring…"}
                  ):</strong> <code>/api/snapshot</code>
                  runs 6 queries in <code>Promise.all</code> (tape + KPI + sector + top marks +
                  watchlist + lag). The slowest one gates the response. Diagnostic strip shows
                  <code> Last snapshot: {lastSnapshotMs != null ? `${lastSnapshotMs.toFixed(0)} ms` : "—"}</code> in your run.
                </li>
                <li>
                  <strong>Browser update (<span className="text-emerald-300">{liveDocStats.browserUpdateLabel}</span>):</strong> JSON parse → Zustand store update
                  → React reconcile → paint. Live chart-render median.
                </li>
              </ol>
              <p>
                Total typical lag from click to tape row appearing:{" "}
                <code>polling wait + snapshot fetch + browser update</code>{" "}
                ≈ <strong className="text-emerald-300">{liveDocStats.e2eClickToPaintedLabel}</strong>{" "}
                end-to-end (live median over n={liveDocStats.n} click(s) — sums network + SDK + flush + IT poll + browser update).
              </p>
              <p className="text-slate-400">
                We could close this gap with: (a) push instead of poll
                (Server-Sent Events), (b) optimistic prepend of the just-flushed row in the
                tape store at click time, or (c) shrinking the snapshot interval to 500 ms.
                We left it at 1.5 s honest polling so this number reflects what an unbiased
                operator would see.
              </p>
            </div>
          </details>
        </div>
      </section>

      <hr className="border-slate-700" />

      {/* Portfolio Dashboard */}
      <section>
        <h2 className="text-lg font-semibold mb-4">Portfolio Dashboard</h2>

        {/* Day metrics — cumulative today KPIs */}
        <DayMetrics />

        {/* KPI Row */}
        <KpiTiles />

        {/* Sector + Top Marks */}
        <div className="grid grid-cols-2 gap-4 mt-4">
          <div>
            <h3 className="text-sm font-medium text-slate-300 mb-2">
              Sector Exposure
            </h3>
            <SectorDonut />
          </div>
          <div>
            <h3 className="text-sm font-medium text-slate-300 mb-2">
              Top 10 Mark Moves
            </h3>
            <TopMarks />
          </div>
        </div>

        {/* Watchlist + Trades-per-Hour row */}
        <div className="grid grid-cols-2 gap-4 mt-4">
          <Watchlist />
          <TradesPerHour />
        </div>
      </section>

      <hr className="border-slate-700" />

      {/* Pipeline Observability */}
      <section>
        <PipelineObservability />
      </section>
    </div>
  );
}
