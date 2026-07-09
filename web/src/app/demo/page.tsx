"use client";

/**
 * /demo — "Control room" demo view for SEs presenting to customers.
 *
 * Deliberately SIMPLE and self-narrating: one screen, a big value prop, the
 * Live Market toggle, three proof cards (Fresh / Fast / AI), and the live KPI +
 * tape strip. Each card deep-links into the exact section of the full desk (/)
 * for depth. Live data arrives via the same global WebSocket the full desk uses
 * (KPI + tape are pushed server-side), so this page is live on its own — no
 * extra wiring. The Fresh card runs its own light /api/serving-compare poll.
 */

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useDashboardStore } from "@/lib/store";
import { MarketSimulator } from "@/components/MarketSimulator";
import { KpiTiles } from "@/components/KpiTiles";
import { LiveTape } from "@/components/LiveTape";
import { InteractiveLatency } from "@/components/InteractiveLatency";
import { STREAMLIT_RERUN_MEASURED_MS } from "@/lib/baseline";
import { computeLiveLatency, fmtMs } from "@/lib/liveStats";

interface FreshState {
  totalsMatch: boolean;
  preaggRtP50Ms: number | null; // rolling-median round-trip (stable, honest)
  dataAgeS: number | null;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export default function DemoPage() {
  const itServedP50Ms = useDashboardStore((s) => s.itServedP50Ms);
  const itServedBestMs = useDashboardStore((s) => s.itServedBestMs);
  const latencyBars = useDashboardStore((s) => s.latencyBars);
  const live = computeLiveLatency(latencyBars);
  const tape = useDashboardStore((s) => s.tape);
  const addFullPageRenderTiming = useDashboardStore((s) => s.addFullPageRenderTiming);
  const [fresh, setFresh] = useState<FreshState | null>(null);
  // Rolling window of pre-agg round-trips. Single-shot control-subtracted exec
  // is meaningless for a ~20 ms query under ~200-400 ms jittery REST transport
  // (it clamps to 0 / jumps to 100), so we show a stable median round-trip.
  const preaggRtSamplesRef = useRef<number[]>([]);

  // Light poll for the Fresh card (the full serving panel lives on the desk).
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch(`/api/serving-compare?t=${Date.now()}`, { cache: "no-store" });
        if (!r.ok) return;
        const d = await r.json();
        if (!alive) return;
        const preagg = (d.strategies ?? []).find(
          (s: { key: string }) => s.key === "preagg",
        );
        const rt = preagg?.interactive?.rt_ms;
        if (typeof rt === "number") {
          const arr = preaggRtSamplesRef.current;
          arr.push(rt);
          if (arr.length > 15) arr.shift();
        }
        setFresh({
          totalsMatch: !!d.totalsMatch,
          preaggRtP50Ms: median(preaggRtSamplesRef.current),
          dataAgeS: preagg?.freshness_lag_s ?? null,
        });
      } catch {
        /* best-effort */
      }
    };
    tick();
    const id = setInterval(tick, 4000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // Live render/paint probe: when a WS push updates the tape, time the paint
  // cycle (RAF×2) and record it. Gives the Live Market panel a real render
  // number for the streamed path — the last segment of click→visualized.
  useEffect(() => {
    if (tape.length === 0) return;
    const t = performance.now();
    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(() => addFullPageRenderTiming(performance.now() - t));
    });
    return () => cancelAnimationFrame(raf);
  }, [tape, addFullPageRenderTiming]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 px-6 py-6 max-w-6xl mx-auto space-y-6">
      {/* Hero */}
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">
            One Snowflake account = <span className="text-snow-blue">Kafka + Redis + Spark + a dashboard</span>
          </h1>
          <p className="text-sm text-slate-400 mt-1 max-w-3xl">
            A live buy-side credit desk: events stream in with Snowpipe Streaming, the position book
            is <strong>queried in tens of milliseconds</strong> from Interactive Tables (no cache to
            warm), and you can ask it questions in plain English — all in one account, no extra
            infrastructure.
          </p>
        </div>
        <Link
          href="/"
          className="shrink-0 text-xs font-medium px-3 py-2 rounded bg-slate-800 border border-slate-700 hover:border-slate-500 text-slate-200"
        >
          Open full desk →
        </Link>
      </header>

      {/* Headline proof: honest click → on-screen, served only by the Interactive Table */}
      <InteractiveLatency />

      {/* Live market toggle — the "watch it go live" moment */}
      <MarketSimulator />

      {/* Live book KPIs */}
      <KpiTiles />

      {/* Three proof cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Fresh */}
        <ProofCard
          n={1}
          title="Fresh — three ways, all identical"
          href="/#serving"
          cta="See the serving comparison →"
          accent="text-emerald-300"
        >
          <p className="text-slate-400">
            The same book is served <strong>three ways</strong> on the Interactive Warehouse —
            query-time rollup, a pre-aggregated write-through cache, and a MAX_BY group-by — all live
            and <strong>provably identical</strong>. No <code>TARGET_LAG</code> refresh; the writer
            keeps the hot cache fresh.
          </p>
          <div className="mt-2 flex items-baseline gap-3 font-mono">
            <span
              className={`text-xs px-2 py-0.5 rounded ${
                fresh?.totalsMatch
                  ? "bg-emerald-950/50 text-emerald-300 border border-emerald-800/50"
                  : "bg-slate-800 text-slate-400 border border-slate-700"
              }`}
            >
              {fresh?.totalsMatch ? "totals match ✓" : "measuring…"}
            </span>
            <span className="text-lg text-emerald-300">
              {fresh?.preaggRtP50Ms != null ? fmtMs(fresh.preaggRtP50Ms) : "—"}
            </span>
            <span className="text-[11px] text-slate-500">pre-agg read p50 (round-trip, live)</span>
          </div>
          <p className="text-[11px] text-slate-500 mt-0.5">
            round-trip incl. network; server-side exec ~20 ms (see desk panel) · data age{" "}
            {fresh?.dataAgeS != null ? `${fresh.dataAgeS}s` : "—"} — floors at the ~2.5 s streaming
            visibility lag under load (a freshly-streamed row must become queryable first)
          </p>
        </ProofCard>

        {/* Fast */}
        <ProofCard
          n={2}
          title="Fast — instant paint, honest confirm"
          href="/#latency"
          cta="See the latency timeline →"
          accent="text-violet-300"
        >
          <p className="text-slate-400">
            React paints the just-fired row <strong>optimistically (~10 ms)</strong> for instant
            feedback, then the Interactive Table <strong>confirms it&apos;s actually queryable</strong>{" "}
            a couple seconds later (durable write-through, not an in-memory cache). By contrast the
            Streamlit build re-runs the whole script —{" "}
            <strong>~{(STREAMLIT_RERUN_MEASURED_MS.p50 / 1000).toFixed(1)} s</strong> — every interaction.
          </p>
          <div className="mt-2 flex items-baseline gap-3 font-mono">
            <span className="text-lg text-violet-300">
              {itServedP50Ms != null ? fmtMs(itServedP50Ms) : "—"}
            </span>
            <span className="text-[11px] text-slate-500">
              {itServedP50Ms != null
                ? `click → IT-confirmed p50${itServedBestMs != null ? ` · best ${fmtMs(itServedBestMs)}` : ""} (live)`
                : "click → IT-confirmed — hit Fire & measure above"}
            </span>
          </div>
          <p className="text-[11px] text-slate-500 mt-0.5">
            optimistic paint ~10 ms · confirmed number measured live by the widget at top
          </p>
          <p className="text-[11px] text-slate-500 mt-1 pt-1 border-t border-slate-700/50">
            live produce→queryable p50{" "}
            <span className="font-mono text-violet-300">
              {live.endToEndP50 != null ? fmtMs(live.endToEndP50) : "—"}
            </span>{" "}
            {live.count > 0
              ? `(${live.count} streamed rows — moves with Live Market)`
              : "(start Live Market to stream)"}
          </p>
        </ProofCard>

        {/* AI */}
        <ProofCard
          n={3}
          title="Ask it anything"
          href="/ask"
          cta="Open the analyst →"
          accent="text-sky-300"
        >
          <p className="text-slate-400">
            A <strong>Cortex Agent</strong> (Analyst + Search over a Semantic View) answers
            natural-language questions over the same live book —{" "}
            <em>&quot;show me Apollo&apos;s exposure&quot;</em>, <em>&quot;biggest movers today&quot;</em> — no SQL, no model training.
          </p>
          <div className="mt-2 text-[11px] text-slate-500 font-mono">powered by Cortex Analyst + Cortex Search</div>
        </ProofCard>
      </div>

      {/* Live tape — the desk moving in real time */}
      <div>
        <LiveTape />
      </div>

      <footer className="text-center text-[11px] text-slate-600 pt-2">
        Demo view · <Link href="/" className="text-slate-400 hover:text-slate-200">full credit desk</Link> · producer runs outside Snowflake (GCP VM); everything else is in-Snowflake
      </footer>
    </div>
  );
}

function ProofCard({
  n,
  title,
  href,
  cta,
  accent,
  children,
}: {
  n: number;
  title: string;
  href: string;
  cta: string;
  accent: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-4 flex flex-col">
      <h3 className={`text-sm font-semibold ${accent}`}>
        <span className="text-slate-500">{n}.</span> {title}
      </h3>
      <div className="text-xs mt-1 flex-1">{children}</div>
      <Link href={href} className="mt-3 text-xs font-medium text-sky-400 hover:text-sky-300">
        {cta}
      </Link>
    </div>
  );
}
