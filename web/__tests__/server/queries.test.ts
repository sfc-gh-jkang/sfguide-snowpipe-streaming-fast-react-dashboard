/**
 * @jest-environment node
 */

/**
 * Tests for queries.ts — verify SQL strings match parent fork's queries.py.
 * Compares normalized SQL (whitespace-collapsed) to ensure semantic identity.
 */

import * as queries from "../../src/server/queries";

// Normalize SQL: collapse all whitespace sequences to single space, trim
function normalize(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

// Expected SQL from parent fork's queries.py (normalized)
const SCHEMA = "SNOWFLAKE_EXAMPLE.CREDIT_DEMO";

describe("queries.ts matches parent fork queries.py", () => {
  it("tape_query matches", () => {
    const expected = normalize(`
      SELECT
        e.EVENT_ID,
        e.INGESTED_TS,
        e.EVENT_TYPE,
        e.POSITION_ID,
        p.ISSUER,
        p.SECTOR,
        GREATEST(0, TIMESTAMPDIFF('second', e.EVENT_TS, SYSDATE())) AS AGE_SEC,
        COALESCE(e.SIDE, '') AS SIDE,
        COALESCE(e.QTY, 0) AS QTY,
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
      LIMIT 30
    `);
    expect(normalize(queries.tape_query(30))).toBe(expected);
  });

  it("pnl_today matches", () => {
    const expected = normalize(`
      SELECT
        ROUND(SUM(PNL_TODAY), 2) AS TOTAL_PNL,
        COUNT(*) AS POSITION_COUNT,
        SUM(CASE WHEN PNL_TODAY > 0 THEN 1 ELSE 0 END) AS GAINERS,
        SUM(CASE WHEN PNL_TODAY < 0 THEN 1 ELSE 0 END) AS LOSERS
      FROM ${SCHEMA}.PORTFOLIO_LIVE_VIEW
    `);
    expect(normalize(queries.pnl_today())).toBe(expected);
  });

  it("sector_exposure matches", () => {
    const expected = normalize(`
      SELECT
        SECTOR,
        ROUND(SUM(PAR_AMOUNT), 0) AS TOTAL_PAR,
        ROUND(SUM(PAR_AMOUNT) / NULLIF(SUM(SUM(PAR_AMOUNT)) OVER (), 0) * 100, 1) AS PCT
      FROM ${SCHEMA}.PORTFOLIO_LIVE_VIEW
      GROUP BY SECTOR
      ORDER BY TOTAL_PAR DESC
    `);
    expect(normalize(queries.sector_exposure())).toBe(expected);
  });

  it("top_marks matches", () => {
    const expected = normalize(`
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
      LIMIT 10
    `);
    expect(normalize(queries.top_marks(10))).toBe(expected);
  });

  it("watchlist matches", () => {
    const expected = normalize(`
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
    `);
    expect(normalize(queries.watchlist())).toBe(expected);
  });

  it("hourly_trades matches", () => {
    const expected = normalize(`
      SELECT
        DATE_TRUNC('hour', EVENT_TS) AS HOUR,
        COUNT(*) AS TRADE_COUNT
      FROM ${SCHEMA}.RAW_EVENTS
      WHERE EVENT_TYPE = 'TRADE'
        AND EVENT_TS >= DATEADD('hour', -24, CURRENT_TIMESTAMP())
      GROUP BY 1
      ORDER BY 1
    `);
    expect(normalize(queries.hourly_trades())).toBe(expected);
  });

  it("event_count matches", () => {
    const expected = normalize(`
      SELECT COUNT(*) AS CNT
      FROM ${SCHEMA}.RAW_EVENTS
      WHERE EVENT_TS >= DATEADD('hour', -24, CURRENT_TIMESTAMP())
    `);
    expect(normalize(queries.event_count())).toBe(expected);
  });

  it("ingest_latency_stats matches", () => {
    const expected = normalize(`
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
      WHERE EVENT_TS >= DATEADD('minute', -5, SYSDATE())
        AND COALESCE(SOURCE_APP, '') != 'warmup'
    `);
    expect(normalize(queries.ingest_latency_stats(5))).toBe(expected);
  });

  it("interactive_table_lag matches", () => {
    const expected = normalize(`
      SELECT
        GREATEST(0, TIMESTAMPDIFF('second', MAX(LATEST_EVENT_TS), SYSDATE())) AS LAG_SECONDS
      FROM ${SCHEMA}.PORTFOLIO_LIVE_VIEW
    `);
    expect(normalize(queries.interactive_table_lag())).toBe(expected);
  });

  it("throughput matches", () => {
    const expected = normalize(`
      SELECT
        ROUND(COUNT(*) / GREATEST(5, 1), 1) AS EVENTS_PER_MIN
      FROM ${SCHEMA}.RAW_EVENTS
      WHERE EVENT_TS >= DATEADD('minute', -5, CURRENT_TIMESTAMP())
    `);
    expect(normalize(queries.throughput(5))).toBe(expected);
  });

  it("tape_query respects custom limit", () => {
    const sql = queries.tape_query(50);
    expect(sql).toContain("LIMIT 50");
  });

  it("top_marks respects custom n", () => {
    const sql = queries.top_marks(20);
    expect(sql).toContain("LIMIT 20");
  });
});

describe("queries.ts regression guards", () => {
  it("tape_query uses SYSDATE() not CURRENT_TIMESTAMP() for age calc (UTC clock-skew fix)", () => {
    const sql = queries.tape_query();
    expect(sql).toContain("SYSDATE()");
    // The age calculation must NOT use CURRENT_TIMESTAMP() — it returns LTZ
    // which produced negative ages (-24264s) when EVENT_TS was UTC walltime.
    expect(sql).not.toMatch(/CURRENT_TIMESTAMP\(\).*AGE_SEC/s);
  });

  it("tape_query has ORDER BY ... DESC LIMIT clause", () => {
    const sql = normalize(queries.tape_query(30));
    expect(sql).toMatch(/ORDER BY .+ DESC LIMIT 30/);
  });
});
