/**
 * Snowflake REST API client for SPCS.
 * Uses /snowflake/session/token (OAuth) + Snowflake SQL Statements API.
 * More reliable inside SPCS than snowflake-sdk's Node driver.
 */
import { readFileSync, existsSync } from "fs";
import { APP_DB, APP_SCHEMA, APP_FQN, INTERACTIVE_WH } from "./config";

// Row payload from Snowflake REST API has dynamic shape per query.
export type Row = Record<string, any>;

const TOKEN_PATH = "/snowflake/session/token";

export function getOAuthToken(): string {
  if (existsSync(TOKEN_PATH)) {
    return readFileSync(TOKEN_PATH, "utf-8").trim();
  }
  return process.env.SNOWFLAKE_TOKEN || "";
}

function getAccountHost(): string {
  if (process.env.SNOWFLAKE_HOST) return process.env.SNOWFLAKE_HOST;
  const acct = process.env.SNOWFLAKE_ACCOUNT;
  if (!acct) {
    throw new Error(
      "Neither SNOWFLAKE_HOST nor SNOWFLAKE_ACCOUNT env var is set. " +
        "Inside SPCS, SNOWFLAKE_HOST is auto-mounted; outside, set " +
        "SNOWFLAKE_ACCOUNT to your account locator (e.g. QIB24518) or " +
        "SNOWFLAKE_HOST to a full host (e.g. acct.region.snowflakecomputing.com).",
    );
  }
  return `${acct}.snowflakecomputing.com`;
}

interface ApiResponse {
  resultSetMetaData?: {
    rowType: Array<{ name: string; type: string }>;
  };
  data?: string[][];
  message?: string;
  code?: string;
}

interface ExecuteQueryOptions {
  warehouse?: string;
}

export async function executeQuery(sql: string, opts?: ExecuteQueryOptions): Promise<Row[]> {
  const token = getOAuthToken();
  if (!token) throw new Error("No OAuth token available");
  const host = getAccountHost();
  const warehouse = opts?.warehouse || INTERACTIVE_WH;

  const res = await fetch(`https://${host}/api/v2/statements`, {
    method: "POST",
    // CRITICAL: bypass Next.js 14 App Router Data Cache.
    // The route handler is marked `dynamic = "force-dynamic"`, but that only
    // `cache: "no-store"` opts the fetch out of Next.js's Data Cache, which
    // would otherwise dedupe identical POST bodies (same SQL every 1.5s)
    // and never hit Snowflake — verified empirically: 21 snapshot polls in
    // 30s, 0 queries in INFORMATION_SCHEMA.
    // (Setting BOTH `cache: "no-store"` AND `next: { revalidate: 0 }` is
    // redundant and Next.js logs a warning, so we use only `cache`.)
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Snowflake-Authorization-Token-Type": "OAUTH",
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "credit-desk-dashboard/1.0",
    },
    // NOTE: We deliberately do NOT send `role:` here. Inside SPCS the OAuth
    // token mounted at /snowflake/session/token is a SCOPED token bound to the
    // app's owner role; trying to switch roles ($DASHBOARD_RL etc.) returns
    // 390186 even when the underlying user has the role granted. The token's
    // default role already has SELECT on every object the dashboard needs.
    body: JSON.stringify({
      statement: sql,
      timeout: 30,
      warehouse,
      database: APP_DB,
      schema: APP_SCHEMA,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Snowflake API ${res.status}: ${text.slice(0, 300)}`);
  }

  const json = (await res.json()) as ApiResponse;
  if (!json.resultSetMetaData || !json.data) {
    return [];
  }

  const cols = json.resultSetMetaData.rowType.map((c) => c.name);
  const types = json.resultSetMetaData.rowType.map((c) => c.type);

  return json.data.map((rowArr) => {
    const row: Row = {};
    rowArr.forEach((rawVal, i) => {
      const col = cols[i];
      const type = types[i];
      let val: unknown = rawVal;
      if (rawVal === null) {
        val = null;
      } else if (
        type === "fixed" ||
        type === "real" ||
        type === "float" ||
        type === "double"
      ) {
        val = parseFloat(rawVal);
      } else if (
        type === "timestamp_ntz" ||
        type === "timestamp_ltz" ||
        type === "timestamp_tz" ||
        type === "date"
      ) {
        // Snowflake REST API returns timestamps as "<epochSeconds>.<fraction>"
        const epochSecs = parseFloat(rawVal);
        if (!isNaN(epochSecs)) {
          val = new Date(epochSecs * 1000).toISOString();
        }
      }
      row[col] = val;
    });
    return row;
  });
}

export async function loadAppConfig(): Promise<Record<string, string>> {
  try {
    const rows = await executeQuery(
      `SELECT KEY, VALUE FROM ${APP_FQN}.APP_CONFIG`
    );
    const cfg: Record<string, string> = {};
    for (const row of rows) {
      cfg[row.KEY] = row.VALUE;
    }
    return cfg;
  } catch {
    return {};
  }
}

export function destroyConnection(): void {
  // No-op for REST; nothing to clean up
}
