/**
 * GET /api/serving-compare — runs the position-book rollup THREE ways on BOTH
 * the Interactive and Standard warehouses and returns live server-side timing +
 * the summary for each, so the app can prove all three agree (same data) while
 * comparing latency across strategies AND warehouses:
 *
 *   1. windowed  — query-time window rollup on RAW_EVENTS (freshest default)
 *   2. preagg    — pre-aggregated read from the POSITION_BOOK write-through IT
 *   3. optimized — query-time GROUP BY + MAX_BY on RAW_EVENTS (no window/joins)
 *
 * Live warehouse-exec estimate (no QUERY_HISTORY — the REST client is stateless
 * so QUERY_HISTORY_BY_SESSION can't work): each WH runs a `SELECT 1` control per
 * poll; exec ≈ max(0, strategy_rt − control_rt). The control absorbs transport +
 * queue, so exec_ms isolates warehouse execution. Round-trip (rt_ms) is the raw
 * client-observed time. Both interactive + standard are always measured.
 *
 * Queries run sequentially so each timing is isolated (no intra-request WH
 * contention). One failed query doesn't sink the others.
 */
import { NextResponse } from "next/server";
import { executeQuery, type Row } from "../../../server/snowflake-client";
import { INTERACTIVE_WH, STANDARD_WH } from "../../../server/config";
import * as queries from "../../../server/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface WhTiming {
  rt_ms: number | null; // full client-observed round-trip
  exec_ms: number | null; // rt − control (isolated warehouse execution)
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

const CONTROL_SQL = "SELECT 1 AS X";

async function timeQuery(
  sql: string,
  warehouse: string,
): Promise<{ rt: number | null; rows: Row[] | null; error?: string }> {
  try {
    const t0 = Date.now();
    const rows = await executeQuery(sql, { warehouse });
    return { rt: Date.now() - t0, rows };
  } catch (e) {
    return { rt: null, rows: null, error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
}

function whTiming(rt: number | null, control: number | null, error?: string): WhTiming {
  return {
    rt_ms: rt,
    exec_ms: rt != null && control != null ? Math.max(0, rt - control) : null,
    error,
  };
}

export async function GET() {
  // Per-WH control (transport + queue baseline) — subtracted to isolate exec.
  const ctrlI = await timeQuery(CONTROL_SQL, INTERACTIVE_WH);
  const ctrlS = await timeQuery(CONTROL_SQL, STANDARD_WH);

  const defs: Array<{
    key: StrategyResult["key"];
    label: string;
    reads: string;
    sql: string;
    lagSql: string;
  }> = [
    { key: "windowed", label: "Query-time window rollup", reads: "RAW_EVENTS", sql: queries.book_summary_windowed(), lagSql: queries.raw_events_lag() },
    { key: "preagg", label: "Pre-agg write-through", reads: "POSITION_BOOK", sql: queries.book_summary_preagg(), lagSql: queries.position_book_lag() },
    { key: "optimized", label: "Query-time MAX_BY rollup", reads: "RAW_EVENTS", sql: queries.book_summary_optimized(), lagSql: queries.raw_events_lag() },
  ];

  const strategies: StrategyResult[] = [];
  for (const d of defs) {
    const i = await timeQuery(d.sql, INTERACTIVE_WH); // authoritative for totals
    const s = await timeQuery(d.sql, STANDARD_WH);
    let freshness_lag_s: number | null = null;
    try {
      const lagRows = await executeQuery(d.lagSql, { warehouse: INTERACTIVE_WH });
      freshness_lag_s = lagRows[0]?.LAG_SECONDS ?? null;
    } catch {
      /* best-effort */
    }
    const r = i.rows?.[0] || s.rows?.[0] || {};
    strategies.push({
      key: d.key,
      label: d.label,
      reads: d.reads,
      interactive: whTiming(i.rt, ctrlI.rt, i.error),
      standard: whTiming(s.rt, ctrlS.rt, s.error),
      total_pnl: r.TOTAL_PNL ?? null,
      position_count: r.POSITION_COUNT ?? null,
      gainers: r.GAINERS ?? null,
      losers: r.LOSERS ?? null,
      freshness_lag_s,
    });
  }

  // Integrity: do all successful strategies agree on the book totals? Compare
  // TOTAL_PNL to the nearest dollar + POSITION_COUNT exactly.
  const ok = strategies.filter((s) => s.total_pnl != null);
  const pnls = ok.map((s) => Math.round(s.total_pnl as number));
  const counts = ok.map((s) => s.position_count);
  const totalsMatch =
    ok.length > 1 &&
    pnls.every((p) => p === pnls[0]) &&
    counts.every((c) => c === counts[0]);

  return NextResponse.json(
    {
      strategies,
      controls: { interactive_ms: ctrlI.rt, standard_ms: ctrlS.rt },
      totalsMatch,
      measuredAt: new Date().toISOString(),
    },
    {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        Pragma: "no-cache",
      },
    },
  );
}
