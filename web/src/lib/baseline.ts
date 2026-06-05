/**
 * Streamlit parent demo render-segment baseline — DIRECTLY MEASURED.
 *
 * Methodology v7 (current): WebSocket push is the canonical comparison
 * channel; SSE was retired because SPCS Snowsight ingress reaps long-lived
 * EventSource GETs (see global memory rule on SPCS streaming). IT-poll is
 * off the React /api/ingest request
 * path so the click pipeline (network + SDK + HPA wait_for_flush, ~430 ms) is
 * apples-to-apples with Streamlit's parent fork. Streamlit also returns at
 * flush ack — it does not perform a server-side IT visibility check on click.
 * Both forks therefore have IDENTICAL click pipelines; the architectural
 * difference shows up in the render layer (React polls + patches DOM;
 * Streamlit re-runs the entire Python script).
 *
 * Methodology v3 replaced v2's framework-overhead RESIDUAL estimation with a
 * direct measurement of full Streamlit rerun wall-clock from QUERY_HISTORY
 * burst clustering. No more residuals. No more inference.
 *
 * ============================================================================
 * Methodology — burst-clustering of real Streamlit query bursts
 * ============================================================================
 *
 * The parent's `app.py` issues 12 sequential `session.sql(...)` calls per
 * rerun (verified by `grep -c session.sql parent/app.py` and per-line
 * inspection — see comments below). Each rerun therefore shows up in
 * QUERY_HISTORY as a tight burst of 8-20 queries (some conditional, some
 * duplicated) within a few hundred ms of each other, separated from the
 * next rerun by >500 ms of idle time. We cluster these bursts and measure
 * wall-clock from the first query's start_time to the last query's end_time.
 *
 * That delta is the actual time spent inside Streamlit's full-script-rerun
 * model on the Snowflake side. Add the residual ~50-200 ms for WebSocket
 * transport + browser DOM diff + Plotly.js render and you have the wall-
 * clock the user perceives.
 *
 * SQL run against this account 2026-05-19 (last 7 days):
 *
 *   WITH parent_queries AS (
 *     SELECT START_TIME AS s,
 *            DATEADD('millisecond', TOTAL_ELAPSED_TIME, START_TIME) AS e
 *     FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
 *     WHERE START_TIME > DATEADD('day', -7, CURRENT_TIMESTAMP())
 *       AND USER_NAME LIKE 'STPLATSTREAMLIT%'
 *       AND WAREHOUSE_NAME IN ('CREDIT_DEMO_WH','CREDIT_DEMO_INT_WH')
 *       AND QUERY_TEXT ILIKE '%RAW_EVENTS%'
 *       AND EXECUTION_STATUS='SUCCESS'),
 *   gapped AS (
 *     SELECT s, e,
 *       CASE WHEN LAG(e) OVER (ORDER BY s) IS NULL
 *             OR DATEDIFF('millisecond', LAG(e) OVER (ORDER BY s), s) > 500
 *            THEN 1 ELSE 0 END AS new_burst
 *     FROM parent_queries),
 *   bursts AS (
 *     SELECT s, e, SUM(new_burst) OVER (ORDER BY s) AS burst_id FROM gapped),
 *   burst_summary AS (
 *     SELECT burst_id, MIN(s) AS burst_start, MAX(e) AS burst_end,
 *            COUNT(*) AS query_count,
 *            DATEDIFF('millisecond', MIN(s), MAX(e)) AS rerun_ms
 *     FROM bursts GROUP BY burst_id)
 *   SELECT COUNT(*) AS N,
 *          ROUND(MEDIAN(rerun_ms),0) AS P50,
 *          ROUND(APPROX_PERCENTILE(rerun_ms,0.95),0) AS P95
 *   FROM burst_summary
 *   WHERE query_count BETWEEN 8 AND 20;
 *
 * Result (n=88 bursts of 8-20 queries each, last 7 days):
 *   P50_RERUN_MS = 1646 ms (typical)
 *   P95_RERUN_MS = 3391 ms (cold start / heavy chart re-render)
 *
 * ============================================================================
 * What changed vs methodology v2
 * ============================================================================
 *
 * v2 used 8 × 60 + 4 × 98 + estimated 1500-3000 ms framework overhead =
 * 2372 ms typical / 4724 ms p95. The framework-overhead range was inferred
 * from "(parent's documented 3-5 s) - (measured query time)" — an honest
 * residual but not a measurement.
 *
 * v3 measures the rerun directly. Result: typical is **1646 ms (-30% vs
 * v2's claim)** and p95 is **3391 ms (-28%)**. The parent demo's documented
 * "3-5 s" claim from `app.py:477` corresponds to the p95 band, not the
 * typical case. v2 over-estimated typical by treating the 3-5 s memory as
 * mid-range.
 *
 * The burst-measured rerun INCLUDES the 12 queries' total time AND any
 * Python/framework cost between them, because the burst spans first-query-
 * start through last-query-end. The remaining ~50-200 ms residual (Plotly
 * render in browser + WebSocket transport) is on top of the burst window.
 *
 * ============================================================================
 * Honest caveat — comparison is click → acknowledgment vs click → full rerun
 * ============================================================================
 *
 * The React fork's `render_ms` measures `t2_painted - t1_post_done` via
 * `requestAnimationFrame×2` — that is **click-acknowledgment paint of one
 * row**, NOT the time for the polled tape refresh. The polled tape refresh
 * adds ~1500 ms polling phase + ~800 ms snapshot fetch + ~50 ms reconcile
 * = ~2400 ms wall-clock, which is comparable to Streamlit's 1646 ms typical
 * rerun.
 *
 * The headline speedup is real but specifically about user-perceived click
 * feedback (10 ms paint vs 1646 ms rerun, 165× faster). For tape-data
 * freshness (click → row visible in tape), the two architectures are
 * comparable; React wins on optimistic prepend, Streamlit wins on pure
 * server-rendered consistency.
 *
 * The `LatencyComparison` component labels each bar accordingly to avoid
 * apples-vs-oranges.
 */

/** Real Streamlit rerun wall-clock, directly measured from QUERY_HISTORY. */
export const STREAMLIT_RERUN_MEASURED_MS = {
  p50: 1646,
  p95: 3391,
  n_bursts: 88,
  measurement_window: "7 days ending 2026-05-19",
  source: "QUERY_HISTORY burst clustering (USER_NAME LIKE STPLATSTREAMLIT*)",
} as const;

/** Per-warehouse single-query timings (still useful for comparing vs React REST API). */
export const STREAMLIT_QUERY_PROFILE_MS = {
  int_wh: { p50: 60, p95: 95, n: 8795 },
  std_wh: { p50: 98, p95: 241, n: 22056 },
  measurement_window: "7 days ending 2026-05-19",
  source_user: "STPLATSTREAMLIT* (SiS Container Runtime)",
} as const;

/** Verified count by reading parent app.py + grep "session.sql(". */
export const STREAMLIT_QUERIES_PER_RERUN = {
  int_wh: 8,
  std_wh: 4,
  total: 12,
} as const;

/**
 * Streamlit render-segment baseline range (ms) — directly measured.
 *   typical = p50 burst rerun = 1646 ms
 *   p95     = p95 burst rerun = 3391 ms
 *   midpoint = (1646 + 3391) / 2 = 2519 ms (used as headline number)
 */
export const STREAMLIT_RENDER_MS = {
  typical: STREAMLIT_RERUN_MEASURED_MS.p50, // 1646
  p95: STREAMLIT_RERUN_MEASURED_MS.p95, // 3391
  midpoint: Math.round(
    (STREAMLIT_RERUN_MEASURED_MS.p50 + STREAMLIT_RERUN_MEASURED_MS.p95) / 2
  ), // 2519
} as const;

/** Source label shown in the methodology expander. */
export const STREAMLIT_RENDER_SOURCE =
  `Direct burst-clustering measurement: 88 query bursts of 8-20 queries each, time from first query start to last query end. p50 1646 ms, p95 3391 ms. Replaces earlier v2 framework-residual estimation.`;
