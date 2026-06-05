/**
 * Shared dashboard constants. Single source of truth for any tunable that
 * appears in BOTH the engineering code path AND user-visible prose, so
 * changing the value here updates everything (no drift between code and
 * label text).
 */

/**
 * Snapshot polling cadence (ms). Used by:
 *   - page.tsx fetchSnapshot setInterval
 *   - LatencyComparison "average poll wait" derivation (= POLL_INTERVAL_MS / 2)
 *   - any prose that quotes "every 1.5 s polling"
 */
export const POLL_INTERVAL_MS = 1500;

/** Average wait for a freshly-landed row to be picked up by the next poll. */
export const POLL_WAIT_AVG_MS = POLL_INTERVAL_MS / 2;

/**
 * Server-side IT visibility scan cadence (ms) — `snowflake-reader.ts` runs
 * its diff-broadcast loop on this interval. Surfaced in prose / methodology
 * expanders.
 */
export const SCAN_INTERVAL_MS = 200;

/**
 * Cold-start banner threshold (ms). A poll slower than this fires the
 * "warehouse cold-start" callout. Set above the typical warm-WH + Next.js
 * JIT + cloud-services first-call ceiling (~1100 ms) so we don't
 * false-trigger on routine cold-route compiles.
 */
export const COLD_START_THRESHOLD_MS = 2500;

/** Lower bound for "warm" polls — used to clear the banner. */
export const WARM_POLL_THRESHOLD_MS = 700;

/**
 * Public-facing object names — readable on both server and client. Mirror
 * of `src/server/config.ts` (which can't be imported by client components
 * because it touches `process.env` directly). Falls back to the same
 * SE-demo defaults; server-side env-driven values take precedence at
 * actual SQL execution time.
 *
 * Kept here so customer-visible prose (tooltips, doc tables, methodology
 * explainers) can reference warehouse / database / schema names without
 * hardcoding the strings inline. NEXT_PUBLIC_* is the Next.js convention
 * for env vars exposed to the browser bundle.
 */
export const PUBLIC_APP_DB =
  process.env.NEXT_PUBLIC_APP_DB || "SNOWFLAKE_EXAMPLE";
export const PUBLIC_APP_SCHEMA =
  process.env.NEXT_PUBLIC_APP_SCHEMA || "CREDIT_DEMO";
export const PUBLIC_APP_FQN = `${PUBLIC_APP_DB}.${PUBLIC_APP_SCHEMA}`;
export const PUBLIC_INTERACTIVE_WH =
  process.env.NEXT_PUBLIC_INTERACTIVE_WH || "CREDIT_DEMO_INT_WH";
export const PUBLIC_STANDARD_WH =
  process.env.NEXT_PUBLIC_STANDARD_WH || "CREDIT_DEMO_WH";
