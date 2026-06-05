/**
 * GET /api/observability — Polled every 5s for watchlist, trades-per-hour, and pipeline metrics.
 * Separate from /api/snapshot (1.5s) so the slower observability queries don't block hot KPIs.
 */
import { NextResponse } from "next/server";
import { executeQuery } from "../../../server/snowflake-client";
import * as queries from "../../../server/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [wlRows, hourlyRows, ingestRows, throughputRows, countRows, lagRows] =
      await Promise.all([
        executeQuery(queries.watchlist()),
        executeQuery(queries.hourly_trades()),
        executeQuery(queries.ingest_latency_stats(5)),
        executeQuery(queries.throughput(5)),
        executeQuery(queries.event_count()),
        executeQuery(queries.interactive_table_lag()),
      ]);

    return NextResponse.json(
      {
        watchlist: wlRows.map((r) => ({
          position_id: r.POSITION_ID,
          issuer: r.ISSUER,
          rating: r.RATING,
          sector: r.SECTOR,
          par_amount: r.PAR_AMOUNT,
          current_mark: r.CURRENT_MARK,
          pnl_today: r.PNL_TODAY,
        })),
        hourly_trades: hourlyRows.map((r) => ({
          hour: String(r.HOUR),
          trade_count: r.TRADE_COUNT,
        })),
        ingest_stats: ingestRows[0]
          ? {
              event_count: ingestRows[0].EVENT_COUNT,
              p50_ms: ingestRows[0].P50_MS,
              p95_ms: ingestRows[0].P95_MS,
              p99_ms: ingestRows[0].P99_MS,
            }
          : null,
        throughput_evt_per_min: throughputRows[0]?.EVENTS_PER_MIN ?? 0,
        total_events_24h: countRows[0]?.CNT ?? 0,
        it_lag_seconds: lagRows[0]?.LAG_SECONDS ?? 0,
      },
      {
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
          Pragma: "no-cache",
        },
      }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
