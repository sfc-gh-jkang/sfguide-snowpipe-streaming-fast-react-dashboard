"use client";

import { InteractiveLatency } from "@/components/InteractiveLatency";
import { useDashboardStore } from "@/lib/store";
import { fmtMs } from "@/lib/liveStats";
import type { LatencyBar } from "@/lib/types";

/**
 * /latency — "How fresh & how fast?" A plain-English explainer of every
 * freshness / latency / lag component in the demo, for a non-technical reader,
 * with a simple Fire & measure widget so they can watch it happen live.
 *
 * All numbers here are live-measured on this account (see README / ASSUMPTIONS).
 */

const GLOSSARY: { term: string; plain: string; detail: string; color: string }[] = [
  {
    term: "Freshness",
    plain: "How old is the newest data you're looking at?",
    detail:
      "The gap between 'now' and the timestamp of the most recent event you can actually query. In this demo, freshness floors at the streaming visibility lag (~1.3 s) — once a new event is incorporated, reads are sub-second, so the data you see is at most a second or two old.",
    color: "#34D399",
  },
  {
    term: "Latency",
    plain: "Once something happens, how long until you can see it?",
    detail:
      "The end-to-end time for a single new event to travel from 'it happened' to 'it's on my screen, backed by a real Interactive-Table read.' It's the sum of several sequential steps (network, streaming append, commit, visibility, paint) — broken out below.",
    color: "#67E8F9",
  },
  {
    term: "Lag",
    plain: "The slowest single step in that journey.",
    detail:
      "We use 'lag' for the dominant component — here it's the streaming visibility lag: the time for Snowflake to fold a just-committed row into the Interactive Table's served state (batched micropartition incorporation). It's ~1.3 s and drives most of the total latency.",
    color: "#FBBF24",
  },
  {
    term: "Serving speed",
    plain: "How fast is a query for data that's already there?",
    detail:
      "Separate from freshness: reading data that's already visible. On the Interactive warehouse a full book rollup returns in ~19–130 ms; the same query on a standard warehouse is ~250–800 ms. This is the 'hot serving layer' part.",
    color: "#A78BFA",
  },
];

const PIPELINE: {
  n: string;
  name: string;
  plain: string;
  typical: string;
  kind: "sequential" | "concurrent" | "overlap";
  color: string;
  /** Measured field(s) summed for this step (null = not isolated). */
  liveFields: (keyof LatencyBar)[] | null;
  /** Which path's bars this segment is meaningful for (default: both). */
  liveSource?: "client" | "ws";
  /** Extra caveat about what the live number does / doesn't capture on this path. */
  note?: string;
}[] = [
  {
    n: "0",
    name: "Optimistic paint",
    plain: "The instant you click, a greyed-out 'pending' row appears — before the server has done anything.",
    typical: "~10 ms",
    kind: "overlap",
    color: "#64748B",
    liveFields: null,
    note: "Only on the Live Credit Desk / Live Market. The Fire & measure widget deliberately skips it, so there's no live number here — and because it overlaps, it is NOT part of the end-to-end sum.",
  },
  {
    n: "1",
    name: "Browser → server network",
    plain: "Your click travels over the internet to the app server.",
    typical: "tens of ms",
    kind: "sequential",
    color: "#67E8F9",
    liveFields: ["network_ms"],
    liveSource: "client",
    note: "Only the manual click path has a real browser hop (a streamed event has no browser). On a click the browser hop, the server↔VM tunnel, and the paint are all measured together as one round-trip, so this value combines them — a browser-only clock can't split them apart.",
  },
  {
    n: "2",
    name: "Server ↔ VM tunnel",
    plain: "The app hands the event to the ingest service (a separate machine) across a secure tunnel.",
    typical: "~100–160 ms",
    kind: "sequential",
    color: "#94A3B8",
    liveFields: ["server_transport_ms"],
    liveSource: "ws",
    note: "Isolated only for streamed (Live Market) events. On a manual click it's folded into the browser network above, so it reads '—' until Live Market runs.",
  },
  {
    n: "3",
    name: "SDK append + VM handler",
    plain: "The ingest service writes the event into Snowflake via Snowpipe Streaming, plus the VM's own request handling (parse, in-memory book update, response).",
    typical: "~1–5 ms",
    kind: "sequential",
    color: "#34D399",
    liveFields: ["sdk_appended_ms", "vm_overhead_ms"],
    note: "SDK append is ~1 ms; the rest is the VM handler's leftover time. Bundled so every measured millisecond is accounted for in the sum.",
  },
  {
    n: "4",
    name: "Flush / commit (durable)",
    plain: "The event is committed to Snowflake so it can never be lost. Two tables are written AT THE SAME TIME — the raw events and a pre-computed book — so this step is the slower of the two, not both added up.",
    typical: "~0.3 s",
    kind: "concurrent",
    color: "#29B5E8",
    liveFields: ["flush_committed_ms"],
    note: "The live value is already the slower of the two concurrent writes (raw + book), not their sum.",
  },
  {
    n: "5",
    name: "IT visibility (the lag)",
    plain: "Snowflake folds the just-committed row into the Interactive Table's fast-serving memory. This happens in small batches, so a row waits for the next 'tick' — the biggest and most variable step.",
    typical: "~1.3 s (0.7–2.4 s)",
    kind: "sequential",
    color: "#FBBF24",
    liveFields: ["it_poll_ms"],
  },
  {
    n: "6",
    name: "Render / paint",
    plain: "The browser draws the confirmed row on your screen.",
    typical: "~10 ms",
    kind: "sequential",
    color: "#A78BFA",
    liveFields: ["render_ms"],
    liveSource: "client",
    note: "On the Fire & measure path this is folded into step 1 (network), so it reads '—' here.",
  },
];

const STRATEGIES: { name: string; plain: string; speed: string; isDefault: boolean }[] = [
  {
    name: "Pre-aggregated (POSITION_BOOK)",
    plain: "The book is kept pre-computed and streamed in alongside the raw events — reads just fetch the finished answer. This is the Redis-GET equivalent, and it's the default.",
    speed: "~19 ms p50",
    isDefault: true,
  },
  {
    name: "Optimized query-time",
    plain: "Compute the latest state on the fly with an efficient single-pass query over raw events.",
    speed: "~43 ms p50",
    isDefault: false,
  },
  {
    name: "Windowed rollup",
    plain: "Compute the book from scratch each time with a window over all raw events — most flexible, slowest.",
    speed: "~88 ms p50",
    isDefault: false,
  },
];

function KindBadge({ kind }: { kind: "sequential" | "concurrent" | "overlap" }) {
  const map = {
    sequential: { label: "adds up", cls: "bg-slate-700 text-slate-200" },
    concurrent: { label: "runs in parallel (MAX, not sum)", cls: "bg-sky-900/60 text-sky-200" },
    overlap: { label: "overlaps everything · excluded from the sum", cls: "bg-slate-800 text-slate-400" },
  };
  const m = map[kind];
  return <span className={`text-[10px] px-1.5 py-0.5 rounded ${m.cls}`}>{m.label}</span>;
}

export default function LatencyPage() {
  // Live per-step medians from the events you've fired (Fire & measure adds a
  // confirmed bar; Live Market streams add more). Confirmed = the IT-visibility
  // probe actually found the row, so it_poll_ms is real, not a give-up floor.
  const bars = useDashboardStore((s) => s.latencyBars);
  const confirmed = bars.filter((b) => b.it_poll_ms > 0 && b.it_poll_confirmed !== false);
  const median = (xs: number[]): number | null => {
    if (!xs.length) return null;
    const sorted = [...xs].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };
  // Sum of one or more fields on a bar (0 for missing/non-numeric).
  const sumFields = (b: LatencyBar, fields: (keyof LatencyBar)[]): number =>
    fields.reduce((a, f) => a + (typeof b[f] === "number" ? (b[f] as number) : 0), 0);
  // Median of a step's summed fields, ignoring zeros (a 0 means "folded into
  // another segment on this path", not a real measurement). `src` restricts to
  // the path where the segment is meaningful: client = manual click, ws = streamed.
  const barsFor = (src?: "client" | "ws") =>
    src ? confirmed.filter((b) => b.source === src) : confirmed;
  const liveMedian = (fields: (keyof LatencyBar)[], src?: "client" | "ws"): number | null => {
    const xs = barsFor(src)
      .map((b) => sumFields(b, fields))
      .filter((v) => v > 0);
    return median(xs);
  };
  const liveLast = (fields: (keyof LatencyBar)[], src?: "client" | "ws"): number | null => {
    const set = barsFor(src);
    const b = set.length ? set[set.length - 1] : null;
    if (!b) return null;
    const v = sumFields(b, fields);
    return v > 0 ? v : null;
  };
  const liveN = confirmed.length;

  // Exact end-to-end reconciliation for the most-recent confirmed event: these
  // six terms are DISJOINT (network already folds transport+paint on a click;
  // ws bars carry transport separately) so they sum to the true end-to-end with
  // no double-count and no gap. `render` is 0 on the Fire path (folded into
  // network). This is the "do the parts add up?" proof.
  const recon = (() => {
    const b = confirmed.length ? confirmed[confirmed.length - 1] : null;
    if (!b) return null;
    const parts = [
      { label: "Network (browser hop + tunnel + paint)", v: b.network_ms, color: "#67E8F9" },
      { label: "Server ↔ VM tunnel (streamed only)", v: b.server_transport_ms ?? 0, color: "#94A3B8" },
      { label: "SDK append + VM handler", v: b.sdk_appended_ms + b.vm_overhead_ms, color: "#34D399" },
      { label: "Flush / commit", v: b.flush_committed_ms, color: "#29B5E8" },
      { label: "IT visibility", v: b.it_poll_ms, color: "#FBBF24" },
      { label: "Render / paint", v: b.render_ms, color: "#A78BFA" },
    ];
    const total = parts.reduce((a, p) => a + p.v, 0);
    return { parts: parts.filter((p) => p.v > 0), total, source: b.source };
  })();

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Hero / summary */}
      <section className="rounded-lg border border-slate-700 bg-slate-900/50 p-5">
        <h2 className="text-lg font-semibold text-slate-100">How fresh &amp; how fast is this dashboard?</h2>
        <p className="mt-2 text-sm text-slate-300 leading-relaxed">
          Two simple questions decide whether a live dashboard feels &ldquo;real time&rdquo;:{" "}
          <strong className="text-emerald-300">how old is the data I&apos;m looking at</strong> (freshness),
          and <strong className="text-cyan-300">when something new happens, how long until I see it</strong>{" "}
          (latency). This page explains every piece of that in plain language — no jargon required — and lets
          you fire a real event and watch the clock.
        </p>
        <div className="mt-4 rounded border border-emerald-800/50 bg-emerald-950/20 p-3 text-sm text-slate-200">
          <span className="font-semibold text-emerald-300">The one-sentence version:</span> when a trade or
          price change happens, the <strong>confirmed, durable, query-backed</strong> row is visible in about{" "}
          <strong className="text-emerald-300">1–2 seconds</strong> — almost all of which is Snowflake safely
          making the new row queryable — and reading data that&apos;s already there is{" "}
          <strong>sub-100 ms</strong>. On the live desk you also see an instant <em>optimistic</em> marker
          (~10 ms) that overlaps this; the Fire &amp; measure widget below deliberately skips that shortcut so
          you see the honest end-to-end number.
        </div>
      </section>

      {/* Glossary — the 4 words people mix up */}
      <section>
        <h3 className="text-sm font-semibold text-slate-300 mb-2">The four words people mix up</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          {GLOSSARY.map((g) => (
            <div key={g.term} className="rounded-lg border border-slate-700 bg-slate-900/40 p-3">
              <div className="flex items-center gap-2">
                <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: g.color }} />
                <span className="text-sm font-semibold text-slate-100">{g.term}</span>
              </div>
              <p className="mt-1 text-xs text-slate-300 italic">&ldquo;{g.plain}&rdquo;</p>
              <p className="mt-1.5 text-[11px] text-slate-400 leading-snug">{g.detail}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Fire & measure — the interactive proof */}
      <section>
        <h3 className="text-sm font-semibold text-slate-300 mb-2">Try it: fire one event and watch the clock</h3>
        <p className="text-xs text-slate-400 mb-3">
          This fires a single event, commits it durably through Snowpipe Streaming, then reads it back from the
          Interactive Table and paints it — no shortcuts. The number is the honest click-to-confirmed time, and
          the bars below break it into the components explained on this page.
        </p>
        <InteractiveLatency />
      </section>

      {/* Detailed pipeline — every component in order */}
      <section>
        <h3 className="text-sm font-semibold text-slate-300 mb-1">
          Every step, in order: from &ldquo;it happened&rdquo; to &ldquo;it&apos;s on my screen&rdquo;
        </h3>
        <p className="text-xs text-slate-400 mb-3">
          The steps happen one after another and <strong>add up</strong> to the total — with two important
          exceptions, flagged below. Each row shows the <span className="text-slate-300">typical</span> value,
          the <span className="text-emerald-300">median</span>, and the{" "}
          <span className="text-cyan-300">last</span> value measured on this device once you&apos;ve fired
          events{liveN > 0 ? ` (n=${liveN})` : ""}. A <span className="font-mono">—</span> means that step
          isn&apos;t separately measured on this path (see its note).
        </p>
        <ol className="space-y-2">
          {PIPELINE.map((s) => {
            const medVal = s.liveFields ? liveMedian(s.liveFields, s.liveSource) : null;
            const lastVal = s.liveFields ? liveLast(s.liveFields, s.liveSource) : null;
            // If there's no live value, say WHY rather than showing a bare dash.
            const reason =
              s.liveFields === null
                ? "not recorded per event"
                : s.liveSource === "ws"
                ? "streamed only — start Live Market"
                : "fire an event above";
            const hasLive = medVal != null || lastVal != null;
            return (
              <li key={s.n} className="rounded-lg border border-slate-700 bg-slate-900/40 p-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className="inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold text-slate-900"
                    style={{ background: s.color }}
                  >
                    {s.n}
                  </span>
                  <span className="text-sm font-medium text-slate-100">{s.name}</span>
                  <span className="text-xs font-mono text-slate-400">
                    typical <span className="text-slate-300">{s.typical}</span>
                  </span>
                  {hasLive ? (
                    <>
                      <span className="text-xs font-mono">
                        <span className="text-slate-500">median</span>{" "}
                        <span className={medVal != null ? "text-emerald-300" : "text-slate-600"}>
                          {medVal != null ? fmtMs(medVal) : "—"}
                        </span>
                      </span>
                      <span className="text-xs font-mono">
                        <span className="text-slate-500">last</span>{" "}
                        <span className={lastVal != null ? "text-cyan-300" : "text-slate-600"}>
                          {lastVal != null ? fmtMs(lastVal) : "—"}
                        </span>
                      </span>
                    </>
                  ) : (
                    <span className="text-[10px] font-mono text-slate-500 italic">live: {reason}</span>
                  )}
                  <KindBadge kind={s.kind} />
                </div>
                <p className="mt-1 text-xs text-slate-400 leading-snug">{s.plain}</p>
                {s.note && (
                  <p className="mt-1 text-[10px] text-slate-500 leading-snug italic">{s.note}</p>
                )}
              </li>
            );
          })}
        </ol>

        {/* Exact reconciliation — do the parts add up? */}
        {recon && recon.parts.length > 0 && (
          <div className="mt-3 rounded-lg border border-emerald-800/50 bg-emerald-950/20 p-3">
            <div className="flex items-baseline justify-between mb-2">
              <span className="text-xs font-semibold text-emerald-300">
                Do the parts add up? — your last fired event
              </span>
              <span className="text-[10px] font-mono text-slate-500">
                {recon.source === "ws" ? "streamed" : "manual click"}
              </span>
            </div>
            <div className="space-y-1">
              {recon.parts.map((p) => (
                <div key={p.label} className="flex items-center gap-2 text-[11px]">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: p.color }} />
                  <span className="flex-1 text-slate-400 truncate" title={p.label}>{p.label}</span>
                  <span className="font-mono text-slate-300">{fmtMs(p.v)}</span>
                  <span className="w-9 text-right text-slate-500">
                    {((p.v / recon.total) * 100).toFixed(0)}%
                  </span>
                </div>
              ))}
              <div className="flex items-center gap-2 text-[11px] border-t border-emerald-800/40 pt-1 mt-1">
                <span className="w-2 shrink-0" />
                <span className="flex-1 font-semibold text-emerald-300">Total (sum of the parts)</span>
                <span className="font-mono font-semibold text-emerald-300">{fmtMs(recon.total)}</span>
                <span className="w-9" />
              </div>
            </div>
            <p className="mt-2 text-[10px] text-slate-500 leading-snug">
              These terms are disjoint — each millisecond is counted once — so they sum exactly to the
              end-to-end above. Optimistic paint isn&apos;t included (it overlaps, doesn&apos;t add time). The
              median column in the table can look slightly off from a sum because a median-of-totals isn&apos;t
              the same as a sum-of-medians; this single-event view is the exact arithmetic.
            </p>
          </div>
        )}

        <div className="mt-3 rounded border border-slate-700/60 bg-slate-900/40 p-3 text-[11px] text-slate-400 leading-snug space-y-1.5">
          <p>
            <strong className="text-sky-300">The one thing that runs in parallel:</strong> step 4 writes two
            tables at once (raw events + a pre-computed book). We count the <strong>slower of the two</strong>,
            not both added together — so the durable pre-aggregation is effectively free on the clock.
          </p>
          <p>
            <strong className="text-slate-300">The one thing we leave out:</strong> the optimistic paint
            (step 0) happens the instant you click and runs <strong>at the same time</strong> as the whole
            server pipeline — you see a pending marker immediately while everything else works in the
            background. Because it overlaps, it isn&apos;t added into the total.
          </p>
        </div>
      </section>

      {/* Two anchors */}
      <section>
        <h3 className="text-sm font-semibold text-slate-300 mb-2">Two ways we measure it (and why they differ)</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-3">
            <div className="text-sm font-semibold text-slate-100">Produce → queryable</div>
            <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">server-anchored</div>
            <p className="text-xs text-slate-400 leading-snug">
              Starts the clock when the event reaches the server and stops when it&apos;s queryable in the
              Interactive Table. This is the pipeline&apos;s own speed — steps 3–5. It&apos;s what the streaming
              feed (Live Market) reports, because there&apos;s no human click to time.
            </p>
          </div>
          <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-3">
            <div className="text-sm font-semibold text-slate-100">Click → visualized</div>
            <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">browser-anchored</div>
            <p className="text-xs text-slate-400 leading-snug">
              Starts when you click and stops when the confirmed pixel is on screen. Adds the browser→server
              hop (step 1) and the paint (step 6) on top of the produce number. This is the number the Fire
              &amp; measure widget above shows: click→IT-confirmed p50 ~1.5–2 s.
            </p>
          </div>
        </div>
        <div className="mt-3 rounded border border-slate-700/60 bg-slate-900/40 p-3 text-[11px] text-slate-400 leading-snug space-y-1.5">
          <p>
            <strong className="text-slate-300">So why don&apos;t the live (streamed) and manual (click)
            numbers match?</strong> There is only <strong>one</strong> pipeline. The three middle steps —{" "}
            <span className="text-emerald-300">SDK append, flush/commit, and IT visibility</span> — are{" "}
            <strong>identical</strong> whether the event came from a click or a background stream, so those
            numbers <em>should</em> agree between the two. Only the two <strong>ends</strong> differ:
          </p>
          <p>
            <strong className="text-slate-300">Getting in:</strong> a click travels the browser→server
            internet hop plus the server↔VM tunnel; a streamed event is produced right at the server, so it
            has no browser hop (network reads ~0) and its tunnel time is reported on its own line.{" "}
            <strong className="text-slate-300">Getting out:</strong> a click is timed all the way to the
            pixel on your screen (adds paint); a streamed event is timed only to &ldquo;queryable&rdquo; —
            there&apos;s no user click to paint for.
          </p>
          <p>
            That&apos;s why the per-step table sources each number from the path where it&apos;s real: the
            browser hop &amp; paint from clicks, the isolated tunnel from streams, and the shared middle from
            both. Same engine, different start and finish lines — the totals differ, the middle matches.
          </p>
        </div>
      </section>
      <section>
        <h3 className="text-sm font-semibold text-slate-300 mb-1">Reading data that&apos;s already there (serving speed)</h3>
        <p className="text-xs text-slate-400 mb-3">
          Freshness is about <em>new</em> events. Serving speed is about <em>querying</em> what&apos;s already
          visible. The dashboard serves the whole book three different ways — all return identical totals, all
          fully fresh (no staleness knob). The pre-aggregated path is the default.
        </p>
        <div className="space-y-2">
          {STRATEGIES.map((s) => (
            <div
              key={s.name}
              className={`rounded-lg border p-3 ${
                s.isDefault ? "border-emerald-700/60 bg-emerald-950/20" : "border-slate-700 bg-slate-900/40"
              }`}
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium text-slate-100">{s.name}</span>
                <span className="text-xs font-mono text-slate-300">{s.speed}</span>
                {s.isDefault && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-800/60 text-emerald-200">default</span>
                )}
              </div>
              <p className="mt-1 text-xs text-slate-400 leading-snug">{s.plain}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Why the lag exists and isn't tunable */}
      <section className="rounded-lg border border-slate-700 bg-slate-900/50 p-5">
        <h3 className="text-sm font-semibold text-slate-100 mb-1">Why is the ~1.3 s visibility lag there — and can we remove it?</h3>
        <p className="text-xs text-slate-400 leading-relaxed">
          It&apos;s the honest price of a <strong className="text-slate-300">durable</strong> write-through: the
          row is safely committed to Snowflake (it can&apos;t be lost), and then folded into the Interactive
          Table&apos;s fast-serving state in small batches — so a row waits for the next incorporation
          &ldquo;tick&rdquo; (irregular, ~0.35–1.3 s apart). That&apos;s why it varies and can&apos;t be dialed
          to zero: the batch cadence is internal to Snowflake, not a setting. (The TARGET_LAG knob only applies
          to tables that refresh <em>from</em> a source, not to a direct streaming target like this one.) The
          only lever is keeping the warehouse warm so it never pays a cold start. The trade-off vs. an
          in-memory cache like Redis: a cache is instant but can drop data and needs separate wiring; this is a
          second or two slower to first-visible but is durable, consistent, and queried with plain SQL.
        </p>
      </section>

      <p className="text-[10px] text-slate-600 text-center pb-4">
        All figures live-measured on this account. Optimistic paint ~10 ms · flush ~0.3 s · visibility p50
        ~1.3 s (0.7–2.4 s) · click→IT-confirmed ~1.5–2 s · serving reads ~19–130 ms.
      </p>
    </div>
  );
}
