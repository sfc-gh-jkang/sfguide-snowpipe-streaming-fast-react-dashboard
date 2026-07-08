/**
 * Parameterized SQL queries for the ACME Credit demo.
 *
 * All reads target the RAW_EVENTS *interactive table* directly — Snowpipe
 * Streaming HPA writes rows straight into it (no landing table), and the
 * dashboard serves everything from it on the Interactive Warehouse. There is
 * no PORTFOLIO_LIVE rollup table and no PORTFOLIO_LIVE_VIEW: the position-book
 * tiles aggregate at query time (62 positions, table clustered on EVENT_TS =>
 * sub-second, well under the 5s interactive timeout).
 *
 * Position attributes (ISSUER/SECTOR/PAR_AMOUNT/BASELINE_MARK/CURRENT_RATING/…)
 * are denormalized onto every event by the producer, so none of these queries
 * join POSITIONS_DIM — an Interactive Warehouse can only join interactive
 * tables. Output column names are preserved from the previous view-based
 * queries so the server/reader mapping layer is unchanged.
 */

import { APP_FQN } from "./config";

const SCHEMA = APP_FQN;

// Events written by channel pre-warm ('warmup') and the startup baseline seed
// ('seed') are internal — filtered out of the live tape.
const TAPE_EXCLUDE = "COALESCE(e.SOURCE_APP, '') NOT IN ('warmup', 'seed')";

function timeTravelClause(secondsAgo: number | null): string {
  if (secondsAgo == null || secondsAgo <= 0) return "";
  return ` AT(OFFSET => -${secondsAgo})`;
}

/**
 * Shared "current book" rollup computed at query time from RAW_EVENTS.
 * Produces one row per position with the latest mark/rating and derived P&L,
 * using the denormalized position attributes carried on each event. `tt` is an
 * optional time-travel clause (AT(OFFSET => -N)) for the /at replay route.
 *
 * Emits columns: POSITION_ID, ISSUER, SECTOR, TRANCHE, PAR_AMOUNT, FUND,
 * WATCHLIST, CURRENT_MARK, OPENING_MARK, MARK_CHANGE_BPS, PNL_TODAY, RATING,
 * LATEST_EVENT_TS. Reference the CTE as `book`.
 */
function bookCte(tt: string = ""): string {
  return `
    WITH ev AS (
      SELECT *
      FROM ${SCHEMA}.RAW_EVENTS${tt}
      WHERE EVENT_TS >= DATEADD('hour', -24, SYSDATE())
    ),
    latest_any AS (
      SELECT POSITION_ID, ISSUER, SECTOR, TRANCHE, PAR_AMOUNT, FUND, WATCHLIST,
             BASELINE_MARK, CURRENT_RATING, EVENT_TS AS LATEST_EVENT_TS
      FROM ev
      QUALIFY ROW_NUMBER() OVER (PARTITION BY POSITION_ID ORDER BY EVENT_TS DESC) = 1
    ),
    latest_mark AS (
      SELECT POSITION_ID, NEW_MARK
      FROM ev
      WHERE EVENT_TYPE = 'MARK'
      QUALIFY ROW_NUMBER() OVER (PARTITION BY POSITION_ID ORDER BY EVENT_TS DESC) = 1
    ),
    latest_rating AS (
      SELECT POSITION_ID, TO_RATING
      FROM ev
      WHERE EVENT_TYPE = 'CREDIT_EVENT'
      QUALIFY ROW_NUMBER() OVER (PARTITION BY POSITION_ID ORDER BY EVENT_TS DESC) = 1
    ),
    book AS (
      SELECT
        la.POSITION_ID,
        la.ISSUER,
        la.SECTOR,
        la.TRANCHE,
        la.PAR_AMOUNT,
        la.FUND,
        la.WATCHLIST,
        COALESCE(lm.NEW_MARK, la.BASELINE_MARK)                              AS CURRENT_MARK,
        la.BASELINE_MARK                                                      AS OPENING_MARK,
        (COALESCE(lm.NEW_MARK, la.BASELINE_MARK) - la.BASELINE_MARK) * 100    AS MARK_CHANGE_BPS,
        (COALESCE(lm.NEW_MARK, la.BASELINE_MARK) - la.BASELINE_MARK)
          / 100.0 * la.PAR_AMOUNT                                            AS PNL_TODAY,
        COALESCE(lr.TO_RATING, la.CURRENT_RATING)                            AS RATING,
        la.LATEST_EVENT_TS
      FROM latest_any la
      LEFT JOIN latest_mark lm   USING (POSITION_ID)
      LEFT JOIN latest_rating lr USING (POSITION_ID)
    )`;
}

export function tape_query(limit: number = 30): string {
  return `
    SELECT
        e.EVENT_ID,
        e.INGESTED_TS,
        e.EVENT_TYPE,
        e.POSITION_ID,
        e.ISSUER,
        e.SECTOR,
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
    WHERE ${TAPE_EXCLUDE}
    ORDER BY e.EVENT_TS DESC
    LIMIT ${limit}
    `;
}

export function pnl_today(): string {
  return `${bookCte()}
    SELECT
        ROUND(SUM(PNL_TODAY), 2) AS TOTAL_PNL,
        COUNT(*) AS POSITION_COUNT,
        SUM(CASE WHEN PNL_TODAY > 0 THEN 1 ELSE 0 END) AS GAINERS,
        SUM(CASE WHEN PNL_TODAY < 0 THEN 1 ELSE 0 END) AS LOSERS
    FROM book
    `;
}

export function sector_exposure(): string {
  return `${bookCte()}
    SELECT
        SECTOR,
        ROUND(SUM(PAR_AMOUNT), 0) AS TOTAL_PAR,
        ROUND(SUM(PAR_AMOUNT) / NULLIF(SUM(SUM(PAR_AMOUNT)) OVER (), 0) * 100, 1)
            AS PCT
    FROM book
    GROUP BY SECTOR
    ORDER BY TOTAL_PAR DESC
    `;
}

export function top_marks(n: number = 10): string {
  return `${bookCte()}
    SELECT
        POSITION_ID,
        ISSUER,
        SECTOR,
        TRANCHE,
        CURRENT_MARK,
        ROUND(MARK_CHANGE_BPS, 1) AS MARK_CHANGE_BPS,
        ROUND(PNL_TODAY, 0) AS PNL_TODAY,
        FUND
    FROM book
    ORDER BY ABS(MARK_CHANGE_BPS) DESC
    LIMIT ${n}
    `;
}

export function watchlist(): string {
  return `${bookCte()}
    SELECT
        POSITION_ID,
        ISSUER,
        RATING,
        SECTOR,
        ROUND(PAR_AMOUNT, 0) AS PAR_AMOUNT,
        CURRENT_MARK,
        ROUND(PNL_TODAY, 0) AS PNL_TODAY
    FROM book
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
      AND COALESCE(SOURCE_APP, '') NOT IN ('warmup', 'seed')
    `;
}

export function interactive_table_lag(): string {
  // Freshness of the served book = seconds since the newest event in RAW_EVENTS.
  return `
    SELECT
        GREATEST(0, TIMESTAMPDIFF('second', MAX(EVENT_TS), SYSDATE())) AS LAG_SECONDS
    FROM ${SCHEMA}.RAW_EVENTS
    WHERE EVENT_TS >= DATEADD('hour', -24, SYSDATE())
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
  // "last 24h" is timezone-stable and matches the "Events (last 24h)" KPI label.
  // Baseline seed + warmup events are excluded so they don't inflate counts.
  return `
    WITH recent_events AS (
      SELECT EVENT_TS, EVENT_TYPE, QTY, PRICE
      FROM ${SCHEMA}.RAW_EVENTS
      WHERE EVENT_TS >= DATEADD('hour', -24, SYSDATE())
        AND COALESCE(SOURCE_APP, '') NOT IN ('warmup', 'seed')
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
// Time-travel variants — RAW_EVENTS interactive tables support Time Travel,
// so AT(OFFSET => -N) replays the book as it was N seconds ago.
// =========================================================================

export function tape_query_at(secondsAgo: number | null, limit: number = 30): string {
  const tt = timeTravelClause(secondsAgo);
  return `
    SELECT
        e.EVENT_ID,
        e.INGESTED_TS,
        e.EVENT_TYPE,
        e.POSITION_ID,
        e.ISSUER,
        e.SECTOR,
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
    WHERE ${TAPE_EXCLUDE}
    ORDER BY e.EVENT_TS DESC
    LIMIT ${limit}
    `;
}

export function pnl_today_at(secondsAgo: number | null): string {
  return `${bookCte(timeTravelClause(secondsAgo))}
    SELECT
        ROUND(SUM(PNL_TODAY), 2) AS TOTAL_PNL,
        COUNT(*) AS POSITION_COUNT,
        SUM(CASE WHEN PNL_TODAY > 0 THEN 1 ELSE 0 END) AS GAINERS,
        SUM(CASE WHEN PNL_TODAY < 0 THEN 1 ELSE 0 END) AS LOSERS
    FROM book
    `;
}

export function sector_exposure_at(secondsAgo: number | null): string {
  return `${bookCte(timeTravelClause(secondsAgo))}
    SELECT
        SECTOR,
        ROUND(SUM(PAR_AMOUNT), 0) AS TOTAL_PAR,
        ROUND(SUM(PAR_AMOUNT) / NULLIF(SUM(SUM(PAR_AMOUNT)) OVER (), 0) * 100, 1)
            AS PCT
    FROM book
    GROUP BY SECTOR
    ORDER BY TOTAL_PAR DESC
    `;
}

export function top_marks_at(secondsAgo: number | null, n: number = 10): string {
  return `${bookCte(timeTravelClause(secondsAgo))}
    SELECT
        POSITION_ID,
        ISSUER,
        SECTOR,
        TRANCHE,
        CURRENT_MARK,
        ROUND(MARK_CHANGE_BPS, 1) AS MARK_CHANGE_BPS,
        ROUND(PNL_TODAY, 0) AS PNL_TODAY,
        FUND
    FROM book
    ORDER BY ABS(MARK_CHANGE_BPS) DESC
    LIMIT ${n}
    `;
}

export function watchlist_at(secondsAgo: number | null): string {
  return `${bookCte(timeTravelClause(secondsAgo))}
    SELECT
        POSITION_ID,
        ISSUER,
        RATING,
        SECTOR,
        ROUND(PAR_AMOUNT, 0) AS PAR_AMOUNT,
        CURRENT_MARK,
        ROUND(PNL_TODAY, 0) AS PNL_TODAY
    FROM book
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
      WHERE EVENT_TS >= DATEADD('hour', -24, SYSDATE())
        AND COALESCE(SOURCE_APP, '') NOT IN ('warmup', 'seed')
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
