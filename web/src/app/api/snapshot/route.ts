/**
 * GET /api/snapshot — Returns full dashboard state in one fetch.
 * Polled by the frontend every 1.5s as a fallback when WebSocket isn't available.
 */
import { NextResponse } from "next/server";
import { executeQuery } from "../../../server/snowflake-client";
import * as queries from "../../../server/queries";
import type { Event, SectorRow, TopMarkRow, WsKpiMsg } from "../../../lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  // Promise.allSettled so one failed query doesn't take down
  // the whole snapshot. Each query falls back to a sane default; client gets
  // partial data + a `partial: true` flag to show a small banner.
  const settled = await Promise.allSettled([
    executeQuery(queries.tape_query(30)),
    executeQuery(queries.pnl_today()),
    executeQuery(queries.sector_exposure()),
    executeQuery(queries.top_marks(10)),
    executeQuery(queries.watchlist()),
    executeQuery(queries.interactive_table_lag()),
    executeQuery(queries.day_metrics()),
  ]);

  const labels = ["tape", "pnl", "sector", "topmarks", "watchlist", "lag", "dayMetrics"];
  const failedQueries: string[] = [];
  const rows = settled.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    failedQueries.push(labels[i]);
    console.warn(`[snapshot] query failed (${labels[i]}):`, r.reason);
    return [];
  });
  const [tapeRows, pnlRows, sectorRows, topRows, wlRows, lagRows, dayMetricRows] = rows;

  const tape: Event[] = tapeRows.map((row) => ({
    event_id: row.EVENT_ID || `${row.POSITION_ID}-${row.INGESTED_TS}`,
    event_type: row.EVENT_TYPE,
    position_id: row.POSITION_ID,
    issuer: row.ISSUER || "",
    sector: row.SECTOR || "",
    side: row.SIDE || undefined,
    qty: row.QTY || undefined,
    price: row.PRICE ?? undefined,
    prev_mark: row.PREV_MARK ?? undefined,
    new_mark: row.NEW_MARK ?? undefined,
    from_rating: row.FROM_RATING || undefined,
    to_rating: row.TO_RATING || undefined,
    counterparty: row.COUNTERPARTY || undefined,
    partition: 0,
    ingested_ts: String(row.INGESTED_TS),
    latency_ms: row.AGE_SEC != null ? row.AGE_SEC * 1000 : undefined,
    status: "verified",
  }));

  const r = pnlRows[0] || {};
  const kpi: WsKpiMsg = {
    type: "kpi",
    total_pnl: r.TOTAL_PNL ?? 0,
    position_count: r.POSITION_COUNT ?? 0,
    gainers: r.GAINERS ?? 0,
    losers: r.LOSERS ?? 0,
    watchlist_count: wlRows.length,
    it_lag_seconds: lagRows[0]?.LAG_SECONDS ?? 0,
  };

  const sector: SectorRow[] = sectorRows.map((r) => ({
    sector: r.SECTOR,
    total_par: r.TOTAL_PAR,
  }));

  const topmarks: TopMarkRow[] = topRows.map((r) => ({
    issuer: r.ISSUER,
    sector: r.SECTOR,
    current_mark: r.CURRENT_MARK,
    mark_change_bps: r.MARK_CHANGE_BPS,
    pnl_today: r.PNL_TODAY,
  }));

  const dm = dayMetricRows[0] || {};
  const dayMetrics = {
    events_today: dm.EVENTS_TODAY ?? 0,
    evt_per_sec_30s: dm.EVT_PER_SEC_30S ?? 0,
    peak_burst_per_sec: dm.PEAK_BURST_PER_SEC ?? 0,
    total_notional_today: dm.TOTAL_NOTIONAL_TODAY ?? 0,
  };

  return NextResponse.json(
    {
      tape,
      kpi,
      sector,
      topmarks,
      dayMetrics,
      partial: failedQueries.length > 0,
      failedQueries,
    },
    {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        Pragma: "no-cache",
      },
    }
  );
}
