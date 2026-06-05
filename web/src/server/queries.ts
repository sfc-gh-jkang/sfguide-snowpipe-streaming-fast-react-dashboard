/**
 * Parameterized SQL queries for the ACME Credit demo.
 * Port of parent fork's queries.py — SQL strings kept byte-for-byte identical.
 */

import { APP_FQN } from "./config";

const SCHEMA = APP_FQN;

export function tape_query(limit: number = 30): string {
  return `
    SELECT
        e.EVENT_ID,
        e.INGESTED_TS,
        e.EVENT_TYPE,
        e.POSITION_ID,
        p.ISSUER,
        p.SECTOR,
        GREATEST(0, TIMESTAMPDIFF('second', e.EVENT_TS, SYSDATE())) AS AGE_SEC,
        COALESCE(e.SIDE, '') AS SIDE,
        COALESCE(e.QTY, 0)  AS QTY,
        e.PRICE,
        e.PREV_MARK,
        e.NEW_MARK,
        COALESCE(e.FROM_RATING, '') AS FROM_RATING,
        COALESCE(e.TO_RATING, '') AS TO_RATING,
        COALESCE(e.COUNTERPARTY, '') AS COUNTERPARTY,
        COALESCE(e.SOURCE_APP, '') AS SOURCE_APP
    FROM ${SCHEMA}.RAW_EVENTS e
    LEFT JOIN ${SCHEMA}.POSITIONS_DIM p USING (POSITION_ID)
    WHERE COALESCE(e.SOURCE_APP, '') != 'warmup'
    ORDER BY e.EVENT_TS DESC
    LIMIT ${limit}
    `;
}

export function pnl_today(): string {
  return `
    SELECT
        ROUND(SUM(PNL_TODAY), 2) AS TOTAL_PNL,
        COUNT(*) AS POSITION_COUNT,
        SUM(CASE WHEN PNL_TODAY > 0 THEN 1 ELSE 0 END) AS GAINERS,
        SUM(CASE WHEN PNL_TODAY < 0 THEN 1 ELSE 0 END) AS LOSERS
    FROM ${SCHEMA}.PORTFOLIO_LIVE_VIEW
    `;
}

export function sector_exposure(): string {
  return `
    SELECT
        SECTOR,
        ROUND(SUM(PAR_AMOUNT), 0) AS TOTAL_PAR,
        ROUND(SUM(PAR_AMOUNT) / NULLIF(SUM(SUM(PAR_AMOUNT)) OVER (), 0) * 100, 1)
            AS PCT
    FROM ${SCHEMA}.PORTFOLIO_LIVE_VIEW
    GROUP BY SECTOR
    ORDER BY TOTAL_PAR DESC
    `;
}

export function top_marks(n: number = 10): string {
  return `
    SELECT
        POSITION_ID,
        ISSUER,
        SECTOR,
        TRANCHE,
        CURRENT_MARK,
        ROUND(MARK_CHANGE_BPS, 1) AS MARK_CHANGE_BPS,
        ROUND(PNL_TODAY, 0) AS PNL_TODAY,
        FUND
    FROM ${SCHEMA}.PORTFOLIO_LIVE_VIEW
    ORDER BY ABS(MARK_CHANGE_BPS) DESC
    LIMIT ${n}
    `;
}

export function watchlist(): string {
  return `
    SELECT
        POSITION_ID,
        ISSUER,
        RATING,
        SECTOR,
        ROUND(PAR_AMOUNT, 0) AS PAR_AMOUNT,
        CURRENT_MARK,
        ROUND(PNL_TODAY, 0) AS PNL_TODAY
    FROM ${SCHEMA}.PORTFOLIO_LIVE_VIEW
    WHERE WATCHLIST = TRUE
    ORDER BY PNL_TODAY ASC
    `;
}

export function hourly_trades(): string {
  return `
    SELECT
        DATE_TRUNC('hour', EVENT_TS) AS HOUR,
        COUNT(*) AS TRADE_COUNT
    FROM ${SCHEMA}.RAW_EVENTS
    WHERE EVENT_TYPE = 'TRADE'
      AND EVENT_TS >= DATEADD('hour', -24, CURRENT_TIMESTAMP())
    GROUP BY 1
    ORDER BY 1
    `;
}

export function event_count(): string {
  return `
    SELECT COUNT(*) AS CNT
    FROM ${SCHEMA}.RAW_EVENTS
    WHERE EVENT_TS >= DATEADD('hour', -24, CURRENT_TIMESTAMP())
    `;
}

export function ingest_latency_stats(window_min: number = 5): string {
  // EVENT_TS == INGESTED_TS by VM design (both set in _fill_defaults from same `now`),
  // so the old TIMESTAMPDIFF metric was always 0. Replaced with "event freshness" —
  // the age distribution of recent events relative to query time.
  return `
    SELECT
        COUNT(*) AS EVENT_COUNT,
        ROUND(APPROX_PERCENTILE(
            GREATEST(0, TIMESTAMPDIFF('second', EVENT_TS, SYSDATE())), 0.5
        ), 1) AS P50_MS,
        ROUND(APPROX_PERCENTILE(
            GREATEST(0, TIMESTAMPDIFF('second', EVENT_TS, SYSDATE())), 0.95
        ), 1) AS P95_MS,
        ROUND(APPROX_PERCENTILE(
            GREATEST(0, TIMESTAMPDIFF('second', EVENT_TS, SYSDATE())), 0.99
        ), 1) AS P99_MS
    FROM ${SCHEMA}.RAW_EVENTS
    WHERE EVENT_TS >= DATEADD('minute', -${window_min}, SYSDATE())
      AND COALESCE(SOURCE_APP, '') != 'warmup'
    `;
}

export function interactive_table_lag(): string {
  return `
    SELECT
        GREATEST(0, TIMESTAMPDIFF('second', MAX(LATEST_EVENT_TS), SYSDATE())) AS LAG_SECONDS
    FROM ${SCHEMA}.PORTFOLIO_LIVE_VIEW
    `;
}

export function throughput(window_min: number = 5): string {
  return `
    SELECT
        ROUND(COUNT(*) / GREATEST(${window_min}, 1), 1) AS EVENTS_PER_MIN
    FROM ${SCHEMA}.RAW_EVENTS
    WHERE EVENT_TS >= DATEADD('minute', -${window_min}, CURRENT_TIMESTAMP())
    `;
}

export function day_metrics(): string {
  // Item #3 fix: was filtering on DATE(EVENT_TS) = DATE(SYSDATE()) which is
  // UTC date. PT users saw 0 events for the first 8-16 hours of their local
  // day. Switched to "last 24h" which is timezone-stable and matches the
  // (renamed) "Events (last 24h)" KPI label.
  return `
    WITH recent_events AS (
      SELECT EVENT_TS, EVENT_TYPE, QTY, PRICE
      FROM ${SCHEMA}.RAW_EVENTS
      WHERE EVENT_TS >= DATEADD('hour', -24, SYSDATE())
    ),
    per_second AS (
      SELECT DATE_TRUNC('second', EVENT_TS) AS SEC, COUNT(*) AS CNT
      FROM recent_events
      GROUP BY 1
    )
    SELECT
        (SELECT COUNT(*) FROM recent_events) AS EVENTS_TODAY,
        (SELECT ROUND(COUNT(*) / 30.0, 1) FROM recent_events
         WHERE EVENT_TS >= DATEADD('second', -30, SYSDATE())) AS EVT_PER_SEC_30S,
        (SELECT COALESCE(MAX(CNT), 0) FROM per_second) AS PEAK_BURST_PER_SEC,
        (SELECT COALESCE(ROUND(SUM(QTY * PRICE), 2), 0) FROM recent_events
         WHERE EVENT_TYPE = 'TRADE') AS TOTAL_NOTIONAL_TODAY
    `;
}

// =========================================================================
// Time-travel variants — append AT(OFFSET => -N) to RAW_EVENTS only.
// POSITIONS_DIM is dimension-stable, no time-travel needed.
// =========================================================================

function timeTravelClause(secondsAgo: number | null): string {
  if (secondsAgo == null || secondsAgo <= 0) return "";
  return ` AT(OFFSET => -${secondsAgo})`;
}

export function tape_query_at(secondsAgo: number | null, limit: number = 30): string {
  const tt = timeTravelClause(secondsAgo);
  return `
    SELECT
        e.EVENT_ID,
        e.INGESTED_TS,
        e.EVENT_TYPE,
        e.POSITION_ID,
        p.ISSUER,
        p.SECTOR,
        GREATEST(0, TIMESTAMPDIFF('second', e.EVENT_TS, SYSDATE())) AS AGE_SEC,
        COALESCE(e.SIDE, '') AS SIDE,
        COALESCE(e.QTY, 0)  AS QTY,
        e.PRICE,
        e.PREV_MARK,
        e.NEW_MARK,
        COALESCE(e.FROM_RATING, '') AS FROM_RATING,
        COALESCE(e.TO_RATING, '') AS TO_RATING,
        COALESCE(e.COUNTERPARTY, '') AS COUNTERPARTY,
        COALESCE(e.SOURCE_APP, '') AS SOURCE_APP
    FROM ${SCHEMA}.RAW_EVENTS${tt} e
    LEFT JOIN ${SCHEMA}.POSITIONS_DIM p USING (POSITION_ID)
    WHERE COALESCE(e.SOURCE_APP, '') != 'warmup'
    ORDER BY e.EVENT_TS DESC
    LIMIT ${limit}
    `;
}

export function pnl_today_at(secondsAgo: number | null): string {
  const tt = timeTravelClause(secondsAgo);
  return `
    SELECT
        ROUND(SUM(PNL_TODAY), 2) AS TOTAL_PNL,
        COUNT(*) AS POSITION_COUNT,
        SUM(CASE WHEN PNL_TODAY > 0 THEN 1 ELSE 0 END) AS GAINERS,
        SUM(CASE WHEN PNL_TODAY < 0 THEN 1 ELSE 0 END) AS LOSERS
    FROM ${SCHEMA}.PORTFOLIO_LIVE_VIEW${tt}
    `;
}

export function sector_exposure_at(secondsAgo: number | null): string {
  const tt = timeTravelClause(secondsAgo);
  return `
    SELECT
        SECTOR,
        ROUND(SUM(PAR_AMOUNT), 0) AS TOTAL_PAR,
        ROUND(SUM(PAR_AMOUNT) / NULLIF(SUM(SUM(PAR_AMOUNT)) OVER (), 0) * 100, 1)
            AS PCT
    FROM ${SCHEMA}.PORTFOLIO_LIVE_VIEW${tt}
    GROUP BY SECTOR
    ORDER BY TOTAL_PAR DESC
    `;
}

export function top_marks_at(secondsAgo: number | null, n: number = 10): string {
  const tt = timeTravelClause(secondsAgo);
  return `
    SELECT
        POSITION_ID,
        ISSUER,
        SECTOR,
        TRANCHE,
        CURRENT_MARK,
        ROUND(MARK_CHANGE_BPS, 1) AS MARK_CHANGE_BPS,
        ROUND(PNL_TODAY, 0) AS PNL_TODAY,
        FUND
    FROM ${SCHEMA}.PORTFOLIO_LIVE_VIEW${tt}
    ORDER BY ABS(MARK_CHANGE_BPS) DESC
    LIMIT ${n}
    `;
}

export function watchlist_at(secondsAgo: number | null): string {
  const tt = timeTravelClause(secondsAgo);
  return `
    SELECT
        POSITION_ID,
        ISSUER,
        RATING,
        SECTOR,
        ROUND(PAR_AMOUNT, 0) AS PAR_AMOUNT,
        CURRENT_MARK,
        ROUND(PNL_TODAY, 0) AS PNL_TODAY
    FROM ${SCHEMA}.PORTFOLIO_LIVE_VIEW${tt}
    WHERE WATCHLIST = TRUE
    ORDER BY PNL_TODAY ASC
    `;
}

export function day_metrics_at(secondsAgo: number | null): string {
  const tt = timeTravelClause(secondsAgo);
  return `
    WITH today_events AS (
      SELECT EVENT_TS, EVENT_TYPE, QTY, PRICE
      FROM ${SCHEMA}.RAW_EVENTS${tt}
      WHERE DATE(EVENT_TS) = DATE(SYSDATE())
    ),
    per_second AS (
      SELECT DATE_TRUNC('second', EVENT_TS) AS SEC, COUNT(*) AS CNT
      FROM today_events
      GROUP BY 1
    )
    SELECT
        (SELECT COUNT(*) FROM today_events) AS EVENTS_TODAY,
        (SELECT ROUND(COUNT(*) / 30.0, 1) FROM today_events
         WHERE EVENT_TS >= DATEADD('second', -30, SYSDATE())) AS EVT_PER_SEC_30S,
        (SELECT COALESCE(MAX(CNT), 0) FROM per_second) AS PEAK_BURST_PER_SEC,
        (SELECT COALESCE(ROUND(SUM(QTY * PRICE), 2), 0) FROM today_events
         WHERE EVENT_TYPE = 'TRADE') AS TOTAL_NOTIONAL_TODAY
    `;
}
