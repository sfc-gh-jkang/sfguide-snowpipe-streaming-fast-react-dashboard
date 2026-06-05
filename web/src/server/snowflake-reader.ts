/**
 * Snowflake polling reader — async loop that queries Snowflake at 200ms cadence,
 * hashes results, and broadcasts only on change via ws-broker.
 */

import { createHash } from "crypto";
import { executeQuery, type Row } from "./snowflake-client";
import * as broker from "./ws-broker";
import * as queries from "./queries";
import type {
  WsTapeMsg,
  WsKpiMsg,
  WsSectorMsg,
  WsTopMarksMsg,
  Event,
  SectorRow,
  TopMarkRow,
} from "../lib/types";

// --- Snapshot cache (sent to new clients on connect) ---
export interface Snapshot {
  tape: Event[];
  kpi: WsKpiMsg | null;
  sector: SectorRow[];
  topmarks: TopMarkRow[];
}

// SHARED STATE: pinned on globalThis so the route-handler copy of this
// module and the server.js copy share the same singleton (same as ws-broker;
// see comment there for why this matters).
interface ReaderGlobal {
  __snowflakeReader?: {
    latestSnapshot: Snapshot;
    hashes: Record<string, string>;
    pollInterval: ReturnType<typeof setInterval> | null;
    running: boolean;
  };
}
const g = globalThis as ReaderGlobal;
g.__snowflakeReader ??= {
  latestSnapshot: { tape: [], kpi: null, sector: [], topmarks: [] },
  hashes: {},
  pollInterval: null,
  running: false,
};
const state = g.__snowflakeReader;

export function getLatestSnapshot(): Snapshot {
  return state.latestSnapshot;
}

function hashResult(rows: Row[]): string {
  const raw = JSON.stringify(rows);
  return createHash("md5").update(raw).digest("hex");
}

/**
 * Stable per-key hashers — used by hasChanged() to avoid re-broadcasting
 * when only volatile time-derived fields changed (AGE_SEC, it_lag_seconds).
 *
 * BACKGROUND: an earlier version hashed the full row JSON, which meant
 *   - tape: AGE_SEC = EXTRACT(EPOCH FROM (NOW() - INGESTED_TS)) advances
 *     every 200 ms scan, so the hash always differs → broadcast every tick
 *     → tape re-renders 5x/sec even when no real data changed.
 *   - kpi: it_lag_seconds (also derived from NOW()) drifts the same way.
 * Result: charts visibly "moved" on idle even with zero new ingest events.
 *
 * Fix: hash only the structural fields that actually identify the data,
 * not the time-derived fields. Time-derived values still flow through
 * because we recompute them on every scan; we just don't TRIGGER a
 * broadcast on their change alone.
 */
const STABLE_HASHERS: Record<string, (rows: Row[]) => string> = {
  // Tape: row identity is EVENT_ID (or POSITION_ID + INGESTED_TS as
  // fallback). EVENT_TYPE captures any new event arriving.
  tape: (rows) => {
    const ids = rows.map(
      (r) =>
        `${r.EVENT_ID ?? `${r.POSITION_ID}-${r.INGESTED_TS}`}|${r.EVENT_TYPE ?? ""}`
    );
    return createHash("md5").update(ids.join(",")).digest("hex");
  },
  // KPI: business numbers only. it_lag_seconds excluded because it's
  // a time-derived liveness gauge that ticks every scan.
  kpi: (rows) => {
    const r = rows[0] || {};
    const stable = `${r.TOTAL_PNL ?? 0}|${r.POSITION_COUNT ?? 0}|${r.GAINERS ?? 0}|${r.LOSERS ?? 0}`;
    return createHash("md5").update(stable).digest("hex");
  },
  // Sector totals: just the sector name + total_par. Stable.
  sector: (rows) => {
    const stable = rows
      .map((r) => `${r.SECTOR ?? ""}:${r.TOTAL_PAR ?? 0}`)
      .join(",");
    return createHash("md5").update(stable).digest("hex");
  },
  // Top marks: issuer + current_mark + bps_change. Real moves only.
  topmarks: (rows) => {
    const stable = rows
      .map(
        (r) =>
          `${r.ISSUER ?? ""}|${r.CURRENT_MARK ?? 0}|${r.MARK_CHANGE_BPS ?? 0}`
      )
      .join(",");
    return createHash("md5").update(stable).digest("hex");
  },
};

function hasChanged(key: string, rows: Row[]): boolean {
  // Use the stable hasher when one is registered for this key; fall back
  // to whole-JSON hash (legacy behavior) for unknown keys.
  const hasher = STABLE_HASHERS[key] ?? hashResult;
  const newHash = hasher(rows);
  if (state.hashes[key] === newHash) return false;
  state.hashes[key] = newHash;
  return true;
}

// --- Error rate-limit state ---
// Without a rate-limit, a transient Snowflake outage at 5 polls/sec floods
// stdout with the same "[snowflake-reader] poll error:" line. We log only
// on healthy → error and error → healthy transitions, plus once every 60 s
// while the error persists. The flow:
//   - First error after a healthy stretch  → log, mark errorState=true
//   - Subsequent errors within 60 s        → silent (counter increments)
//   - Subsequent error after 60 s elapsed  → log "(N suppressed in last 60s)"
//   - First successful poll after errors   → log "recovered after N errors"
const errorLog = {
  errorState: false,
  consecutiveErrors: 0,
  lastLoggedAt: 0,
};
const ERROR_LOG_INTERVAL_MS = 60_000;

function logPollError(err: unknown): void {
  errorLog.consecutiveErrors += 1;
  const now = Date.now();
  if (!errorLog.errorState) {
    // healthy → error transition
    errorLog.errorState = true;
    errorLog.lastLoggedAt = now;
    console.error("[snowflake-reader] poll error:", err);
    return;
  }
  if (now - errorLog.lastLoggedAt >= ERROR_LOG_INTERVAL_MS) {
    errorLog.lastLoggedAt = now;
    console.error(
      `[snowflake-reader] poll error (${errorLog.consecutiveErrors} consecutive, last 60s suppressed):`,
      err,
    );
  }
}

function logPollRecovered(): void {
  if (!errorLog.errorState) return;
  console.warn(
    `[snowflake-reader] poll recovered after ${errorLog.consecutiveErrors} consecutive error(s)`,
  );
  errorLog.errorState = false;
  errorLog.consecutiveErrors = 0;
}

// --- Row mappers ---
function mapTapeRows(rows: Row[]): Event[] {
  return rows.map((r) => ({
    event_id: `${r.POSITION_ID}-${r.INGESTED_TS}`,
    event_type: r.EVENT_TYPE,
    position_id: r.POSITION_ID,
    issuer: r.ISSUER || "",
    sector: r.SECTOR || "",
    side: r.SIDE || undefined,
    qty: r.QTY || undefined,
    price: r.PRICE ?? undefined,
    prev_mark: r.PREV_MARK ?? undefined,
    new_mark: r.NEW_MARK ?? undefined,
    from_rating: r.FROM_RATING || undefined,
    to_rating: r.TO_RATING || undefined,
    counterparty: r.COUNTERPARTY || undefined,
    partition: 0,
    ingested_ts: String(r.INGESTED_TS),
    latency_ms: r.LATENCY_MS ?? undefined,
    status: "verified" as const,
  }));
}

// --- Polling loop ---
async function poll(): Promise<void> {
  try {
    // Run queries in parallel
    const [tapeRows, pnlRows, sectorRows, topRows] = await Promise.all([
      executeQuery(queries.tape_query(30)),
      executeQuery(queries.pnl_today()),
      executeQuery(queries.sector_exposure()),
      executeQuery(queries.top_marks(10)),
    ]);

    // Tape
    if (hasChanged("tape", tapeRows)) {
      const events = mapTapeRows(tapeRows);
      state.latestSnapshot.tape = events;

      // Scan-detect = (broker_emit_now − max INGESTED_TS in this batch).
      // Captures "how stale was the freshest row at the moment we noticed".
      // Bounded to [0, 5000] to drop garbage timestamps (clock skew, missing
      // INGESTED_TS values that parse to NaN, etc).
      let scanDetectMs: number | undefined;
      const tsValues = tapeRows
        .map((r) => {
          const raw = r.INGESTED_TS;
          if (raw == null) return NaN;
          // Snowflake driver may return Date or string; both work with new Date().
          const d = new Date(raw as string | Date);
          return d.getTime();
        })
        .filter((t) => Number.isFinite(t));
      if (tsValues.length > 0) {
        const maxTs = Math.max(...tsValues);
        const candidate = Date.now() - maxTs;
        if (candidate >= 0 && candidate <= 5000) {
          scanDetectMs = candidate;
        }
      }

      const msg: WsTapeMsg = scanDetectMs != null
        ? { type: "tape", events, _scan_detect_ms: scanDetectMs }
        : { type: "tape", events };
      broker.broadcast(msg);
    }

    // KPI (includes watchlist count + IT lag)
    if (hasChanged("kpi", pnlRows)) {
      const r = pnlRows[0] || {};
      // Fetch watchlist count and IT lag in parallel
      const [wlRows, lagRows] = await Promise.all([
        executeQuery(queries.watchlist()),
        executeQuery(queries.interactive_table_lag()),
      ]);
      const kpiMsg: WsKpiMsg = {
        type: "kpi",
        total_pnl: r.TOTAL_PNL ?? 0,
        position_count: r.POSITION_COUNT ?? 0,
        gainers: r.GAINERS ?? 0,
        losers: r.LOSERS ?? 0,
        watchlist_count: wlRows.length,
        it_lag_seconds: lagRows[0]?.LAG_SECONDS ?? 0,
      };
      state.latestSnapshot.kpi = kpiMsg;
      broker.broadcast(kpiMsg);
    }

    // Sector
    if (hasChanged("sector", sectorRows)) {
      const mapped: SectorRow[] = sectorRows.map((r) => ({
        sector: r.SECTOR,
        total_par: r.TOTAL_PAR,
      }));
      state.latestSnapshot.sector = mapped;
      const msg: WsSectorMsg = { type: "sector", rows: mapped };
      broker.broadcast(msg);
    }

    // Top marks
    if (hasChanged("topmarks", topRows)) {
      const mapped: TopMarkRow[] = topRows.map((r) => ({
        issuer: r.ISSUER,
        sector: r.SECTOR,
        current_mark: r.CURRENT_MARK,
        mark_change_bps: r.MARK_CHANGE_BPS,
        pnl_today: r.PNL_TODAY,
      }));
      state.latestSnapshot.topmarks = mapped;
      const msg: WsTopMarksMsg = { type: "topmarks", rows: mapped };
      broker.broadcast(msg);
    }
    // Successful poll — log recovery if we were previously in error state.
    logPollRecovered();
  } catch (err) {
    logPollError(err);
  }
}

export function start(): void {
  if (state.running) return;
  state.running = true;
  // Initial poll immediately
  poll();
  // Then every 200ms
  state.pollInterval = setInterval(poll, 200);
}

export function stop(): void {
  state.running = false;
  if (state.pollInterval) {
    clearInterval(state.pollInterval);
    state.pollInterval = null;
  }
}

export function isRunning(): boolean {
  return state.running;
}

// Graceful shutdown
process.on("SIGTERM", () => {
  stop();
});
