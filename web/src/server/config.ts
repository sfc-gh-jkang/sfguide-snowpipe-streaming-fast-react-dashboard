/**
 * Server-side app config — single source of truth for Snowflake object names.
 *
 * All values are read from environment variables with a sensible default
 * matching the canonical SE-demo deployment. Override via env (e.g. in
 * `snowflake.yml` `runtimeRole.spec` or local `.env.local`) for any other
 * account.
 *
 * Why this exists: previously every server module hardcoded
 * `SNOWFLAKE_EXAMPLE.CREDIT_DEMO` / `CREDIT_DEMO_INT_WH` / `CREDIT_DEMO_WH`
 * inline. That meant porting this repo to a different account required
 * patching ~6 files. Now there's exactly one place.
 */

export const APP_DB = process.env.APP_DB || "SNOWFLAKE_EXAMPLE";
export const APP_SCHEMA = process.env.APP_SCHEMA || "CREDIT_DEMO";

/** Fully-qualified `<DB>.<SCHEMA>` prefix used in SQL. */
export const APP_FQN = `${APP_DB}.${APP_SCHEMA}`;

/** Interactive warehouse for serving live dashboard queries. */
export const INTERACTIVE_WH = process.env.INTERACTIVE_WH || "CREDIT_DEMO_INT_WH";

/** Standard warehouse used by the demo's `/api/snapshot/standard` route. */
export const STANDARD_WH = process.env.STANDARD_WH || "CREDIT_DEMO_WH";

/** Cortex Agent name for the natural-language Q&A over the live book. */
export const AGENT_NAME = process.env.AGENT_NAME || "CREDIT_AGENT";
