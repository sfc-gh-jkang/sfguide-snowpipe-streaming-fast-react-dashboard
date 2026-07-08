/**
 * @jest-environment node
 */

/**
 * Tests for queries.ts.
 *
 * These queries were rewritten to read the RAW_EVENTS *interactive table*
 * directly and aggregate the position book at query time (no PORTFOLIO_LIVE
 * rollup table, no PORTFOLIO_LIVE_VIEW). We assert the structural contract —
 * source object, output aliases, filters — rather than byte-for-byte SQL, so
 * the tests stay meaningful as the SQL is tuned.
 */

import * as queries from "../../src/server/queries";

function normalize(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

const SCHEMA = "SNOWFLAKE_EXAMPLE.CREDIT_DEMO";

// Every rollup tile query + its time-travel variant.
const ROLLUP_QUERIES: Array<[string, string]> = [
  ["pnl_today", queries.pnl_today()],
  ["sector_exposure", queries.sector_exposure()],
  ["top_marks", queries.top_marks(10)],
  ["watchlist", queries.watchlist()],
  ["pnl_today_at", queries.pnl_today_at(null)],
  ["sector_exposure_at", queries.sector_exposure_at(null)],
  ["top_marks_at", queries.top_marks_at(null, 10)],
  ["watchlist_at", queries.watchlist_at(null)],
];

// Everything the dashboard executes.
const ALL_QUERIES: Array<[string, string]> = [
  ...ROLLUP_QUERIES,
  ["tape_query", queries.tape_query(30)],
  ["hourly_trades", queries.hourly_trades()],
  ["event_count", queries.event_count()],
  ["ingest_latency_stats", queries.ingest_latency_stats(5)],
  ["interactive_table_lag", queries.interactive_table_lag()],
  ["throughput", queries.throughput(5)],
  ["day_metrics", queries.day_metrics()],
  ["tape_query_at", queries.tape_query_at(60)],
  ["day_metrics_at", queries.day_metrics_at(60)],
];

describe("queries.ts — interactive RAW_EVENTS source", () => {
  it("no query references the retired PORTFOLIO_LIVE table or view", () => {
    for (const [name, sql] of ALL_QUERIES) {
      expect(`${name}:${sql}`).not.toMatch(/PORTFOLIO_LIVE/);
    }
  });

  it("every query reads from RAW_EVENTS", () => {
    for (const [name, sql] of ALL_QUERIES) {
      expect(`${name}:${sql}`).toContain(`${SCHEMA}.RAW_EVENTS`);
    }
  });

  it("no query joins POSITIONS_DIM (attributes are denormalized onto events)", () => {
    for (const [name, sql] of ALL_QUERIES) {
      expect(`${name}:${sql}`).not.toMatch(/POSITIONS_DIM/);
    }
  });
});

describe("queries.ts — rollup book contract", () => {
  it("rollup queries derive latest-per-position from the book CTE", () => {
    for (const [name, sql] of ROLLUP_QUERIES) {
      const n = normalize(sql);
      expect(`${name}`).toBeTruthy();
      expect(n).toContain("book AS");
      expect(n).toContain("FROM book");
      // latest-per-position is done with a window function, not a dim join.
      expect(n).toContain("ROW_NUMBER() OVER (PARTITION BY POSITION_ID");
    }
  });

  it("pnl_today aggregates PnL with the expected KPI aliases", () => {
    const n = normalize(queries.pnl_today());
    expect(n).toContain("SUM(PNL_TODAY)");
    expect(n).toMatch(/AS TOTAL_PNL/);
    expect(n).toMatch(/AS POSITION_COUNT/);
    expect(n).toMatch(/AS GAINERS/);
    expect(n).toMatch(/AS LOSERS/);
  });

  it("sector_exposure groups by SECTOR and emits TOTAL_PAR + PCT", () => {
    const n = normalize(queries.sector_exposure());
    expect(n).toContain("GROUP BY SECTOR");
    expect(n).toMatch(/AS TOTAL_PAR/);
    expect(n).toMatch(/AS PCT/);
  });

  it("top_marks exposes CURRENT_MARK and honors the row limit", () => {
    expect(queries.top_marks(20)).toContain("LIMIT 20");
    const n = normalize(queries.top_marks(10));
    expect(n).toContain("CURRENT_MARK");
    expect(n).toContain("MARK_CHANGE_BPS");
    expect(n).toContain("ORDER BY ABS(MARK_CHANGE_BPS) DESC");
  });

  it("watchlist filters WATCHLIST = TRUE and exposes RATING + CURRENT_MARK", () => {
    const n = normalize(queries.watchlist());
    expect(n).toContain("WHERE WATCHLIST = TRUE");
    expect(n).toContain("RATING");
    expect(n).toContain("CURRENT_MARK");
  });
});

describe("queries.ts — tape + freshness", () => {
  it("tape_query selects denormalized ISSUER/SECTOR without a join and excludes internal events", () => {
    const n = normalize(queries.tape_query(30));
    expect(n).toContain("e.ISSUER");
    expect(n).toContain("e.SECTOR");
    expect(n).toContain("NOT IN ('warmup', 'seed')");
    expect(n).toMatch(/ORDER BY .+ DESC LIMIT 30/);
  });

  it("tape_query uses SYSDATE() (not CURRENT_TIMESTAMP()) for age calc (UTC clock-skew fix)", () => {
    const sql = queries.tape_query();
    expect(sql).toContain("SYSDATE()");
    expect(sql).not.toMatch(/CURRENT_TIMESTAMP\(\).*AGE_SEC/s);
  });

  it("interactive_table_lag reports LAG_SECONDS from RAW_EVENTS", () => {
    const n = normalize(queries.interactive_table_lag());
    expect(n).toContain("AS LAG_SECONDS");
    expect(n).toContain("MAX(EVENT_TS)");
  });

  it("day_metrics + ingest_latency_stats exclude warmup and seed events", () => {
    expect(normalize(queries.day_metrics())).toContain("NOT IN ('warmup', 'seed')");
    expect(normalize(queries.ingest_latency_stats(5))).toContain(
      "NOT IN ('warmup', 'seed')"
    );
  });
});

describe("queries.ts — time-travel variants", () => {
  it("append AT(OFFSET => -N) to RAW_EVENTS when a positive offset is given", () => {
    expect(queries.tape_query_at(120)).toContain("AT(OFFSET => -120)");
    expect(queries.pnl_today_at(300)).toContain("AT(OFFSET => -300)");
    expect(queries.top_marks_at(90, 10)).toContain("AT(OFFSET => -90)");
    expect(queries.day_metrics_at(45)).toContain("AT(OFFSET => -45)");
  });

  it("omit the time-travel clause for null / non-positive offsets (live mode)", () => {
    expect(queries.tape_query_at(null)).not.toContain("AT(OFFSET");
    expect(queries.pnl_today_at(0)).not.toContain("AT(OFFSET");
    expect(queries.sector_exposure_at(null)).not.toContain("AT(OFFSET");
  });
});
