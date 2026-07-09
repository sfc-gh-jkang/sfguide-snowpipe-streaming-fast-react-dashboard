"use client";

/**
 * ServingStrategyComparison — serves the position-book P&L rollup THREE ways on
 * the Interactive Warehouse and shows them live, side by side:
 *
 *   1. Query-time window rollup   (RAW_EVENTS, QUALIFY ROW_NUMBER)
 *   2. Pre-agg write-through      (POSITION_BOOK — the "fresh Redis" hot cache)
 *   3. Query-time MAX_BY rollup   (RAW_EVENTS, GROUP BY + MAX_BY)
 *
 * The panel is deliberately precise about THREE different measurements that are
 * easy to conflate (see the "How this works" pop-down for definitions + docs):
 *   - LATENCY  = how long a read takes (round-trip here; warehouse-exec shown too)
 *   - DATA AGE = seconds since the newest row arrived (coarse staleness proxy)
 *   - FRESHNESS = event → visible end-to-end (time-to-queryable + time-to-visualized),
 *                 pulled from the live measured click pipeline (store latencyBars).
 */
import { useEffect, useRef, useState } from "react";
import { useDashboardStore } from "@/lib/store";
import { SERVING_STRATEGY_BENCH } from "@/lib/baseline";

// Authoritative Snowflake docs (sourced via `cortex search docs`, not hand-built).
const DOCS = {
  interactive: "https://docs.snowflake.com/en/user-guide/interactive",
  streaming:
    "https://docs.snowflake.com/en/user-guide/snowpipe-streaming/data-load-snowpipe-streaming-overview",
  streamingHPA:
    "https://docs.snowflake.com/en/user-guide/snowpipe-streaming/snowpipe-streaming-high-performance-overview",
  targetLag: "https://docs.snowflake.com/en/user-guide/dynamic-tables/target-lag",
  dynamicTables: "https://docs.snowflake.com/en/user-guide/dynamic-tables/overview",
  maxBy: "https://docs.snowflake.com/en/sql-reference/functions/max_by",
  qualify: "https://docs.snowflake.com/en/sql-reference/constructs/qualify",
} as const;

interface WhTiming {
  rt_ms: number | null;
  exec_ms: number | null;
  error?: string;
}

interface StrategyResult {
  key: "windowed" | "preagg" | "optimized";
  label: string;
  reads: string;
  interactive: WhTiming;
  standard: WhTiming;
  total_pnl: number | null;
  position_count: number | null;
  gainers: number | null;
  losers: number | null;
  freshness_lag_s: number | null;
}

interface CompareResponse {
  strategies: StrategyResult[];
  controls: { interactive_ms: number | null; standard_ms: number | null };
  totalsMatch: boolean;
  measuredAt: string;
}

const POLL_MS = 4000;
const MAX_SAMPLES = 20;

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function A({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-sky-400 hover:underline">
      {children}
    </a>
  );
}

export function ServingStrategyComparison() {
  const [resp, setResp] = useState<CompareResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const samplesRef = useRef<Record<string, number[]>>({});
  const [, force] = useState(0);

  // Live measured click pipeline, from the same latency bars the LatencyTimeline
  // uses. We show BOTH anchors because both are legitimate:
  //   • pipeline (from produce) = classic streaming data-freshness; starts when the
  //     event is stamped at the source (VM). Excludes the client→VM network hop.
  //   • user (from click)       = user-perceived; starts at the click, so it adds
  //     the browser→VM network hop. This is what the person at the screen feels.
  // The only difference between the two anchors is network_ms.
  const latencyBars = useDashboardStore((s) => s.latencyBars);
  const dayMetrics = useDashboardStore((s) => s.dayMetrics);
  // Client-measured + IT-confirmed bars only. Client bars have accurate network +
  // render; WS-path (MarketSimulator) bars have server-side network only and no
  // render, so they'd bias the per-segment freshness medians. Unconfirmed probes
  // report a give-up floor, not real latency — also excluded.
  const visibleBars = latencyBars.filter(
    (b) => b.source === "client" && b.it_poll_ms > 0 && b.it_poll_confirmed !== false
  );
  //   queryable (raw)  = event/click → first readable in RAW_EVENTS
  //                      (SDK + flush + VM overhead + IT visibility)
  //   queryable (book) = same, but the POSITION_BOOK pre-agg table (strategy 2)
  //   visualized       = optimistic paint (SDK + flush + VM overhead + render),
  //                      which fires at flush-ack BEFORE the IT confirms, so it is
  //                      typically LESS than queryable — render does NOT stack on it_poll.
  const q_pipeline = median(
    visibleBars.map(
      (b) => b.sdk_appended_ms + b.flush_committed_ms + b.vm_overhead_ms + b.it_poll_ms,
    ),
  );
  const q_user = median(
    visibleBars.map(
      (b) =>
        b.network_ms +
        b.sdk_appended_ms +
        b.flush_committed_ms +
        b.vm_overhead_ms +
        b.it_poll_ms,
    ),
  );
  // POSITION_BOOK commit→queryable (strategy-2 pre-agg freshness), from the
  // second visibility probe. Only confirmed book probes.
  const bookBars = visibleBars.filter(
    (b) => b.book_poll_ms != null && b.book_poll_confirmed !== false,
  );
  const qbook_pipeline = median(
    bookBars.map(
      (b) => b.sdk_appended_ms + b.flush_committed_ms + b.vm_overhead_ms + (b.book_poll_ms ?? 0),
    ),
  );
  const qbook_user = median(
    bookBars.map(
      (b) =>
        b.network_ms +
        b.sdk_appended_ms +
        b.flush_committed_ms +
        b.vm_overhead_ms +
        (b.book_poll_ms ?? 0),
    ),
  );
  const v_pipeline = median(
    visibleBars.map(
      (b) => b.sdk_appended_ms + b.flush_committed_ms + b.vm_overhead_ms + b.render_ms,
    ),
  );
  const v_user = median(
    visibleBars.map(
      (b) =>
        b.network_ms +
        b.sdk_appended_ms +
        b.flush_committed_ms +
        b.vm_overhead_ms +
        b.render_ms,
    ),
  );
  const fmtMs = (ms: number | null) =>
    ms == null ? null : ms < 1000 ? `${ms.toFixed(0)} ms` : `${(ms / 1000).toFixed(2)} s`;

  // --- Pipeline health (reliability) from the recent latency bars ---
  const rawProbed = latencyBars.filter((b) => b.it_poll_ms > 0);
  const rawConfirmed = rawProbed.filter((b) => b.it_poll_confirmed !== false).length;
  const rawConfirmPct = rawProbed.length ? (rawConfirmed / rawProbed.length) * 100 : null;
  const bookProbed = latencyBars.filter((b) => b.book_poll_ms != null);
  const bookConfirmed = bookProbed.filter((b) => b.book_poll_confirmed !== false).length;
  const bookConfirmPct = bookProbed.length ? (bookConfirmed / bookProbed.length) * 100 : null;
  // Partition spread over recent bars — a hot-partition / skew proxy.
  const partCounts = new Map<number, number>();
  for (const b of latencyBars) {
    if (b.partition != null) partCounts.set(b.partition, (partCounts.get(b.partition) ?? 0) + 1);
  }
  const distinctParts = partCounts.size;
  const maxPart = Math.max(0, ...partCounts.values());
  const skewPct = latencyBars.length ? (maxPart / latencyBars.length) * 100 : null;
  // Modeled (NOT live-metered) cost: always-on WH credits/yr. Interactive WH ≈
  // 60% of standard credits/hr; both XSMALL here. ACCOUNT_USAGE metering has a
  // multi-hour lag + role limits on this account, so this is a published-rate
  // model, clearly labeled — not a live measurement.
  const INT_CR_HR = 0.6; // interactive XSMALL
  const STD_CR_HR = 1.0; // standard XSMALL
  const intCrYr = Math.round(INT_CR_HR * 24 * 365);
  const stdCrYr = Math.round(STD_CR_HR * 24 * 365);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch(`/api/serving-compare?t=${Date.now()}`, { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = (await r.json()) as CompareResponse;
        if (!alive) return;
        for (const s of data.strategies) {
          const rt = s.interactive.rt_ms;
          if (rt == null) continue;
          const arr = samplesRef.current[s.key] ?? [];
          arr.push(rt);
          if (arr.length > MAX_SAMPLES) arr.shift();
          samplesRef.current[s.key] = arr;
        }
        setResp(data);
        setErr(null);
        force((n) => n + 1);
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      }
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const strategies = resp?.strategies ?? [];
  const p50s = strategies.map((s) => median(samplesRef.current[s.key] ?? []) ?? s.interactive.rt_ms ?? 0);
  const maxP50 = Math.max(1, ...p50s);
  const barColor = (key: string) =>
    key === "preagg" ? "bg-emerald-500" : key === "optimized" ? "bg-violet-500" : "bg-sky-500";

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-4">
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-sm font-semibold text-slate-200">
          Serving strategy comparison — 3 ways, all equally fresh
        </h3>
        {resp && (
          <span
            className={`text-xs font-medium px-2 py-0.5 rounded ${
              resp.totalsMatch
                ? "bg-emerald-950/50 text-emerald-300 border border-emerald-800/50"
                : "bg-amber-950/50 text-amber-300 border border-amber-800/50"
            }`}
            title="All strategies must return the same book totals (same data, different serving path)."
          >
            {resp.totalsMatch ? "totals match ✓" : "totals differ — settling…"}
          </span>
        )}
      </div>
      <p className="text-xs text-slate-500 mb-3">
        Same position-book P&amp;L rollup, computed three ways on the Interactive
        Warehouse. The bar is <strong>read latency</strong> (round-trip). Freshness is
        separate — see below. All three read interactive tables and return the identical
        book (totals-match check), and none uses a <code>TARGET_LAG</code> refresh, so all
        three are equally fresh.
      </p>

      {err && !resp && <p className="text-xs text-amber-400 mb-2">Measuring… ({err})</p>}

      {/* --- Read latency bars --- */}
      <div className="space-y-2">
        {strategies.map((s, i) => {
          const p50 = p50s[i];
          const pct = Math.max(4, (p50 / maxP50) * 100);
          const iErr = s.interactive.error;
          const iExec = s.interactive.exec_ms;
          const sExec = s.standard.exec_ms;
          const sRt = s.standard.rt_ms;
          return (
            <div key={s.key} className="text-xs">
              <div className="flex items-center justify-between mb-0.5">
                <span className="text-slate-300">
                  <span className="text-slate-500">{i + 1}.</span> {s.label}{" "}
                  <code className="text-slate-500">{s.reads}</code>
                </span>
                <span className="text-slate-200 font-mono">
                  {iErr ? (
                    <span className="text-red-400">error</span>
                  ) : (
                    <>
                      <strong>{p50.toFixed(0)} ms</strong> round-trip
                      {iExec != null && (
                        <span className="text-slate-500"> · ~{iExec.toFixed(0)} ms exec</span>
                      )}
                      {sRt != null && (
                        <span className="text-amber-400/80" title="Same query on the STANDARD warehouse (live A/B). Standard WH can query interactive tables, just without the interactive warm cache.">
                          {" · std "}{sRt.toFixed(0)}
                          {sExec != null ? `/${sExec.toFixed(0)}` : ""} ms
                        </span>
                      )}
                    </>
                  )}
                </span>
              </div>
              <div className="h-3 rounded bg-slate-900/70 overflow-hidden">
                <div
                  className={`h-full ${barColor(s.key)} transition-all`}
                  style={{ width: `${iErr ? 0 : pct}%` }}
                />
              </div>
              {iErr && <p className="text-[11px] text-red-400/80 mt-0.5">{iErr}</p>}
            </div>
          );
        })}
      </div>
      <p className="text-[11px] text-slate-500 mt-1">
        <strong>round-trip</strong> = live client-observed (app → Snowflake REST → app,
        incl. network/queue). <strong>exec</strong> = live warehouse execution ≈ round-trip −
        a <code>SELECT 1</code> control on the same WH each poll (isolates transport+queue).
        <strong> std</strong> = same query on the Standard warehouse (round-trip/exec) — a live
        interactive-vs-standard A/B; interactive is faster from its warm SSD cache. Historical
        bench: preagg {SERVING_STRATEGY_BENCH.preagg.p50} / optimized {SERVING_STRATEGY_BENCH.optimized.p50} /
        windowed {SERVING_STRATEGY_BENCH.windowed.p50} ms ({SERVING_STRATEGY_BENCH.measured}).
      </p>

      {/* --- Freshness (event → visible), shown from BOTH anchors --- */}
      <div className="mt-3 rounded bg-emerald-950/20 border border-emerald-800/40 p-2 text-xs">
        <div className="flex items-center justify-between mb-1">
          <span className="text-emerald-300 font-semibold">Freshness — event → visible (live)</span>
          <span className="text-slate-500">
            data age (newest row):{" "}
            <span className="font-mono text-slate-300">
              {strategies.find((s) => s.freshness_lag_s != null)?.freshness_lag_s ?? "—"} s
            </span>{" "}
            (~1 s res.)
          </span>
        </div>
        <table className="w-full text-left">
          <thead>
            <tr className="text-slate-500">
              <th className="font-normal py-0.5"></th>
              <th className="font-normal py-0.5">pipeline <span className="text-slate-600">(from produce)</span></th>
              <th className="font-normal py-0.5">user <span className="text-slate-600">(from click)</span></th>
            </tr>
          </thead>
          <tbody className="font-mono text-slate-100">
            <tr>
              <td className="text-slate-300 font-sans pr-3 py-0.5">time-to-queryable <span className="text-slate-600">(RAW_EVENTS)</span></td>
              <td>{fmtMs(q_pipeline) ?? <span className="text-slate-500 font-sans">fire an event</span>}</td>
              <td>{fmtMs(q_user) ?? <span className="text-slate-500 font-sans">fire an event</span>}</td>
            </tr>
            <tr>
              <td className="text-slate-300 font-sans pr-3 py-0.5">time-to-queryable <span className="text-slate-600">(POSITION_BOOK)</span></td>
              <td>{fmtMs(qbook_pipeline) ?? <span className="text-slate-500 font-sans">—</span>}</td>
              <td>{fmtMs(qbook_user) ?? <span className="text-slate-500 font-sans">—</span>}</td>
            </tr>
            <tr>
              <td className="text-slate-300 font-sans pr-3 py-0.5">time-to-visualized <span className="text-slate-600">(optimistic paint)</span></td>
              <td>{fmtMs(v_pipeline) ?? <span className="text-slate-500 font-sans">—</span>}</td>
              <td>{fmtMs(v_user) ?? <span className="text-slate-500 font-sans">—</span>}</td>
            </tr>
          </tbody>
        </table>
        <p className="text-[10px] text-slate-500 mt-1 leading-relaxed">
          <strong>queryable</strong> = readable by a query (SDK append + HPA flush commit +
          VM overhead + IT visibility; flush = max of the concurrent RAW/POSITION_BOOK commits).
          Both interactive tables are probed independently — <strong>RAW_EVENTS</strong> (strategies
          1 &amp; 3) and the <strong>POSITION_BOOK</strong> pre-agg (strategy 2) — so the write-through
          freshness claim is verified, not assumed.
          <strong> visualized</strong> = the optimistic paint (…+ browser render), which fires at
          flush-ack <em>before</em> the IT confirms — so it is typically <em>less</em> than
          queryable (the render overlaps the IT-visibility window, it does not stack on it).
          <strong> pipeline</strong> starts when the event is produced (data-freshness);
          <strong> user</strong> starts at your click and adds the browser→VM network hop.
          Client-fired + IT-confirmed events only. <em>Cross-clock note:</em> data-age below uses
          Snowflake <code>SYSDATE</code> − VM <code>EVENT_TS</code> (two clocks); freshness above
          is single-clock (browser <code>performance.now</code>) except the IT-visibility probe
          (Next-server clock).
        </p>
      </div>

      {/* --- Pipeline health, throughput & (modeled) cost --- */}
      <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
        <div className="rounded border border-slate-700 bg-slate-800/40 px-2 py-1.5">
          <div className="text-[10px] uppercase tracking-wide text-slate-400">IT-confirmed (raw / book)</div>
          <div className="font-mono text-slate-200 mt-0.5">
            {rawConfirmPct == null ? "—" : `${rawConfirmPct.toFixed(0)}%`}
            <span className="text-slate-500"> / </span>
            {bookConfirmPct == null ? "—" : `${bookConfirmPct.toFixed(0)}%`}
          </div>
          <div className="text-[9px] text-slate-500">
            {rawProbed.length === 0
              ? "fire events / turn on Live Market to populate"
              : `${rawConfirmed}/${rawProbed.length} raw · ${bookConfirmed}/${bookProbed.length} book probes`}
          </div>
        </div>
        <div className="rounded border border-slate-700 bg-slate-800/40 px-2 py-1.5">
          <div className="text-[10px] uppercase tracking-wide text-slate-400">Throughput</div>
          <div className="font-mono text-slate-200 mt-0.5">
            {dayMetrics ? `${dayMetrics.evt_per_sec_30s.toFixed(1)}/s` : "—"}
          </div>
          <div className="text-[9px] text-slate-500">
            {dayMetrics ? `peak ${dayMetrics.peak_burst_per_sec}/s · ${dayMetrics.events_today} today` : "last 30s"}
          </div>
        </div>
        <div className="rounded border border-slate-700 bg-slate-800/40 px-2 py-1.5">
          <div className="text-[10px] uppercase tracking-wide text-slate-400">Partition spread</div>
          <div className="font-mono text-slate-200 mt-0.5">
            {distinctParts || "—"} used
          </div>
          <div className="text-[9px] text-slate-500">
            {latencyBars.length === 0
              ? "fire events / Live Market"
              : skewPct == null
                ? "hot-partition proxy"
                : `busiest ${skewPct.toFixed(0)}% of recent (${latencyBars.length} bars)`}
          </div>
        </div>
        <div className="rounded border border-slate-700 bg-slate-800/40 px-2 py-1.5">
          <div className="text-[10px] uppercase tracking-wide text-slate-400">WH cost (modeled)</div>
          <div className="font-mono text-slate-200 mt-0.5">
            {intCrYr.toLocaleString()} <span className="text-slate-500">cr/yr</span>
          </div>
          <div className="text-[9px] text-slate-500">
            interactive XS vs {stdCrYr.toLocaleString()} standard · always-on, published rates
          </div>
        </div>
      </div>
      <p className="text-[10px] text-slate-500 mt-1 leading-relaxed">
        <strong>IT-confirmed</strong> = share of visibility probes that actually found the row
        within the ~4 s budget (unconfirmed = a floor, excluded from freshness stats).
        <strong> Cost is MODELED</strong> from published always-on credit rates (interactive WH ≈
        60% of standard, both XSMALL) — <em>not</em> live-metered: ACCOUNT_USAGE metering lags
        multiple hours and the app role can&apos;t read it. <strong>Queue time</strong> is folded
        into the <code>SELECT 1</code> control above (interactive WH 5 s query timeout), not
        measured separately.
      </p>

      {resp && strategies.some((s) => s.total_pnl != null) && (
        <p className="text-[11px] text-slate-500 mt-2">
          Book:{" "}
          {(() => {
            const s = strategies.find((x) => x.total_pnl != null)!;
            const pnl = s.total_pnl as number;
            return (
              <>
                {s.position_count} positions · P&amp;L{" "}
                <span className={pnl >= 0 ? "text-emerald-400" : "text-red-400"}>
                  {pnl >= 0 ? "+" : ""}
                  {pnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </span>{" "}
                ({s.gainers}↑ / {s.losers}↓) — identical across all serving paths.
              </>
            );
          })()}
        </p>
      )}

      {/* --- Deep explainer pop-down --- */}
      <details className="mt-3 group">
        <summary className="cursor-pointer text-xs font-medium text-sky-300 hover:text-sky-200 select-none">
          How this works — strategies + latency vs. lag vs. freshness (with docs) ▾
        </summary>
        <div className="mt-2 space-y-3 text-xs text-slate-300 leading-relaxed border-l-2 border-slate-700 pl-3">
          <div>
            <p className="font-semibold text-slate-200 mb-1">The three serving strategies</p>
            <ul className="list-disc list-inside space-y-1 text-slate-400">
              <li>
                <strong className="text-sky-300">1 · Query-time window rollup</strong> —
                recompute the book on every read from{" "}
                <code>RAW_EVENTS</code> (an{" "}
                <A href={DOCS.interactive}>Interactive Table</A>) using{" "}
                <A href={DOCS.qualify}>
                  <code>QUALIFY ROW_NUMBER()</code>
                </A>{" "}
                to take the latest MARK and latest CREDIT_EVENT per position, then derive
                P&amp;L. Nothing is pre-stored — the read does the aggregation. Freshest
                possible (sees the just-committed event immediately); most read work.
              </li>
              <li>
                <strong className="text-emerald-300">2 · Pre-agg write-through</strong> —
                the producer keeps a running per-position book in memory and streams the{" "}
                <em>already-computed</em> book line into a second Interactive Table
                (<code>POSITION_BOOK</code>) on every event, via a parallel{" "}
                <A href={DOCS.streamingHPA}>Snowpipe Streaming HPA</A> channel. The read is
                just the latest row per position — pre-aggregated, so it&apos;s the fastest
                (compare the live <em>exec</em> numbers on the bars above; historical bench
                ~{SERVING_STRATEGY_BENCH.preagg.p50} ms). This is the &quot;replaces
                Redis&quot; pattern: the <em>writer</em> maintains the hot cache.
              </li>
              <li>
                <strong className="text-violet-300">3 · Query-time MAX_BY rollup</strong> —
                same source and result as #1, but a single <code>GROUP BY POSITION_ID</code>{" "}
                +{" "}
                <A href={DOCS.maxBy}>
                  <code>MAX_BY(value, ts)</code>
                </A>{" "}
                (which ignores rows whose ordering key is NULL, so we null the key per event
                type to grab the latest MARK / CREDIT per position) — no window functions, no
                self-joins. Cheaper than #1, still fully query-time.
              </li>
            </ul>
          </div>

          <div>
            <p className="font-semibold text-slate-200 mb-1">
              Latency vs. lag vs. freshness — they are not the same thing
            </p>
            <ul className="list-disc list-inside space-y-1 text-slate-400">
              <li>
                <strong className="text-slate-200">Read / query latency</strong> — how long a
                single read takes. The bar above is the <em>round-trip</em> (app →
                Snowflake&apos;s SQL REST API → app, incl. network + queue), which is larger
                than <em>exec</em> (the warehouse&apos;s own execution time — we estimate it live
                as round-trip minus a <code>SELECT 1</code> control). Both are real;
                they measure different spans. Latency says nothing about how old the data is.
              </li>
              <li>
                <strong className="text-slate-200">Data age / lag</strong> — here,{" "}
                <code>SYSDATE() − MAX(EVENT_TS)</code> = seconds since the newest row arrived.
                It&apos;s a coarse (~1 s) staleness proxy, not an end-to-end measure. In
                Snowflake&apos;s Dynamic Tables,{" "}
                <A href={DOCS.targetLag}>&quot;lag&quot;</A> is a formal{" "}
                <em>staleness target</em> (&quot;data should be no more than N old&quot;) — and
                its minimum is <strong>60 s</strong>, which is exactly the staleness a{" "}
                <A href={DOCS.dynamicTables}>dynamic table</A> would add and this demo avoids.
              </li>
              <li>
                <strong className="text-slate-200">Freshness (end-to-end / data latency)</strong>{" "}
                — the one you actually care about: from when the event happened until it is
                visible. It has <strong>two stages</strong> and <strong>two valid anchors</strong>,
                and the panel shows all of them:
                <ul className="list-[circle] list-inside ml-4 mt-1 space-y-0.5">
                  <li>
                    <strong className="text-emerald-300">time-to-queryable</strong> — until the row
                    is readable by <em>any</em> query = SDK append + HPA{" "}
                    <code>wait_for_flush</code> commit + interactive-table visibility. The
                    &quot;can be visualized&quot; number.{" "}
                    <A href={DOCS.streaming}>Snowpipe Streaming</A> commits the flush in ~0.3 s, but
                    the interactive table&apos;s <em>streaming visibility lag</em> (commit→queryable)
                    adds ~1.3 s (varies ~0.7–2.4 s; measured 2026-07-08), so time-to-queryable is
                    typically ~1.5 s. Mechanism: the just-committed micropartition is incorporated
                    into the interactive WH&apos;s served state in irregular <em>batches</em> (~0.35–1.3 s
                    cadence), so a row is visible at the next batch — it is NOT a tunable{" "}
                    <code>TARGET_LAG</code> (that min-60 s knob only applies to interactive tables that
                    auto-refresh from a source; these are direct streaming targets). Reads of
                    already-visible data are sub-second.
                  </li>
                  <li>
                    <strong className="text-emerald-300">time-to-visualized</strong> — until it is
                    painted on screen = the above + browser render/paint (WebSocket push path; the
                    polling fallback adds up to the ~1.5 s poll interval).
                  </li>
                  <li>
                    <strong className="text-slate-200">anchor: pipeline (from produce)</strong> —
                    starts when the event is stamped at the source (the VM). This is classic
                    streaming <em>data freshness</em> — how current the data is, independent of who
                    triggered it. Excludes the client→VM network hop.
                  </li>
                  <li>
                    <strong className="text-slate-200">anchor: user (from click)</strong> — starts
                    at <em>your click</em>, so it adds the browser→VM network hop. This is what the
                    person at the screen actually experiences (&quot;I clicked; when did I see
                    it?&quot;). The two anchors differ by exactly that network hop.
                  </li>
                </ul>
                All measured live from your clicks (they show &quot;fire an event&quot; until
                there&apos;s a sample). <strong>All three serving strategies share this same
                freshness</strong> — they read data committed by the same streaming path, so no
                strategy is staler than another. The pre-agg path buys read <em>speed</em>, not
                freshness.
              </li>
            </ul>
          </div>

          <p className="text-slate-500">
            Docs: <A href={DOCS.interactive}>Interactive tables &amp; warehouses</A> ·{" "}
            <A href={DOCS.streaming}>Snowpipe Streaming</A> ·{" "}
            <A href={DOCS.targetLag}>Dynamic Tables target lag (staleness)</A> ·{" "}
            <A href={DOCS.maxBy}>MAX_BY</A> · <A href={DOCS.qualify}>QUALIFY</A>
          </p>
        </div>
      </details>
    </div>
  );
}
