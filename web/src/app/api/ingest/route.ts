/**
 * POST /api/ingest — Proxy ingest events to VM tunnel.
 * Broadcasts optimistic + verified messages via WebSocket broker.
 *
 * IT-poll architectural fix (item #12):
 *   The server-side IT visibility check (~1.3 s p50, variable — see measured note
 *   below) used to be awaited BEFORE returning, inflating the apparent click-pipeline cost vs
 *   Streamlit's parent fork (which doesn't verify visibility on click).
 *   That made the "click pipeline" segment look ~4x slower than the
 *   apples-to-apples baseline. Fixed by:
 *     1. Returning at HPA flush ack (~300 ms).
 *     2. Spawning pollVisible() as fire-and-forget AFTER the response — probing
 *        BOTH interactive tables (RAW_EVENTS + POSITION_BOOK).
 *     3. Broadcasting `it_visible` (per table, with a confirmed flag) via WS so
 *        the latency bar updates post-hoc.
 *   Net effect: matches Streamlit's click pipeline exactly. End-to-end story
 *   (click → fresh data) is now strictly honest — React and Streamlit are
 *   roughly tied on raw speed (~1.5–2 s click → IT-confirmed, p50); React's wins
 *   are click-acknowledgment paint (optimistic ~10 ms vs a full Streamlit rerun
 *   ~1.6 s) and auto-freshness, not raw latency.
 *
 *   MEASURED 2026-07-08 (controlled ingest→poll through the live VM path,
 *   CREDIT_DEMO_INT_WH warm, n=32): flush/commit ~0.3 s · commit→queryable
 *   (interactive-table streaming-visibility lag) is VARIABLE — p50 ~1.3 s, range
 *   ~0.7–2.4 s (it's the wait until the interactive table's next incorporation
 *   batch, so it depends where the event lands relative to that batch; no
 *   cold-start pattern, occasional multi-second tail under load) · read round-trip ~0.2 s ·
 *   click→IT-confirmed p50 ~1.5–2 s. The interactive WH serves *reads* sub-second
 *   (~19–130 ms); the lag is the freshly-streamed row becoming queryable — the
 *   honest price of a durable write-through, not a cold warehouse.
 *
 *   MECHANISM (verified 2026-07-08 via burst experiments + docs.snowflake.com/
 *   en/user-guide/interactive): streamed rows commit as new micropartitions; the
 *   interactive WH incorporates them into its warm served state in irregular
 *   BATCHES (a burst of staggered commits becomes queryable at shared instants;
 *   observed batch cadence ~0.35–1.3 s). A row is visible at the next batch after
 *   its commit → that's why the lag is variable, not constant. This is NOT the
 *   TARGET_LAG refresh (min 60 s), which only applies to interactive tables that
 *   auto-refresh FROM a source table — RAW_EVENTS/POSITION_BOOK are DIRECT
 *   streaming targets, so the batch cadence is internal to Snowflake and NOT a
 *   tunable knob. Keeping the WH warm (AUTO_SUSPEND=86400) is all we control.
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { ingestEvent } from "../../../server/vm-proxy";
import { executeQuery } from "../../../server/snowflake-client";
import { APP_FQN } from "../../../server/config";
import * as broker from "../../../server/ws-broker";
import type { IngestRequest, WsOptimisticMsg, WsVerifiedMsg, WsItVisibleMsg } from "../../../lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Poll until `sql` (a `SELECT 1 ... LIMIT 1` visibility check) returns a row.
 * Returns { ms, found }:
 *   - found=true  → ms is the real commit→queryable latency (confirmed).
 *   - found=false → we gave up after the budget; ms is the elapsed budget, NOT a
 *     confirmed visibility number. Callers MUST NOT report it as confirmed.
 * Budget: MAX_POLLS × POLL_INTERVAL_MS ≈ 4 s. Interactive-table streaming
 * visibility measured p50 ~1.3 s, range ~0.7–2.4 s (2026-07-08), with occasional
 * multi-second tails, so a 4 s budget covers the tail without clipping; reads
 * themselves are sub-second.
 */
async function pollVisible(sql: string): Promise<{ ms: number; found: boolean }> {
  const start = Date.now();
  const MAX_POLLS = 40;
  const POLL_INTERVAL_MS = 100;
  for (let i = 0; i < MAX_POLLS; i++) {
    try {
      const rows = await executeQuery(sql);
      if (rows.length > 0) return { ms: Date.now() - start, found: true };
    } catch {
      /* retry */
    }
    if (i < MAX_POLLS - 1) await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return { ms: Date.now() - start, found: false };
}

export async function POST(req: NextRequest) {
  const t0 = Date.now();

  let body: IngestRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.event_type) {
    return NextResponse.json(
      { error: "event_type is required" },
      { status: 400 }
    );
  }

  const eventId = randomUUID();
  const networkMs = Date.now() - t0;

  const optimisticMsg: WsOptimisticMsg = {
    type: "optimistic",
    event: {
      event_id: eventId,
      event_type: body.event_type,
      position_id: body.position_id || "",
      issuer: "",
      sector: "",
      partition: 0,
      ingested_ts: new Date().toISOString(),
      status: "pending",
    },
    latency: { network_ms: networkMs, sdk_appended_ms: 0, flush_committed_ms: 0 },
  };
  broker.broadcast(optimisticMsg);

  try {
    // Pass our pre-generated eventId to the VM so it becomes the row's EVENT_ID.
    // This makes optimistic (eventId) === verified/it_visible (vmResponse.event_id),
    // so the ws bar actually receives its it_poll_ms backfill (fixes the /demo
    // "live produce→queryable —" bug where ws bars never got visibility).
    const vmResponse = await ingestEvent({ ...body, event_id: eventId });

    // Broadcast `verified` immediately at HPA flush ack — the row is committed
    // server-side. it_poll_ms=0 here; the actual visibility lag is broadcast
    // separately via `it_visible` once the probes resolve below. Carries the
    // book flush + total handler so WS-path (MarketSimulator) bars can backfill
    // their real VM segments (they were created with 0s at optimistic time).
    const verifiedMsg: WsVerifiedMsg = {
      type: "verified",
      event_id: vmResponse.event_id,
      partition: vmResponse.partition,
      latency: {
        network_ms: networkMs,
        sdk_appended_ms: vmResponse.sdk_appended_ms,
        flush_committed_ms: vmResponse.flush_committed_ms,
        book_flush_committed_ms: vmResponse.book_flush_committed_ms,
        total_handler_ms: vmResponse.total_handler_ms,
        it_poll_ms: 0,
        total_ms: Date.now() - t0,
      },
    };
    broker.broadcast(verifiedMsg);

    // Fire-and-forget visibility probes. Run AFTER we return so the response
    // matches Streamlit's parent fork (which doesn't verify visibility either).
    // Probe BOTH interactive tables:
    //   • RAW_EVENTS  — by EVENT_ID (strategies 1 & 3).
    //   • POSITION_BOOK — by POSITION_ID + BOOK_TS >= EVENT_TS (strategy 2 pre-agg;
    //     the book table has no EVENT_ID, and BOOK_TS is set to the same EVENT_TS).
    // Each result is broadcast with a `table` tag + `confirmed` flag.
    const rawSql = `SELECT 1 FROM ${APP_FQN}.RAW_EVENTS WHERE EVENT_ID = '${vmResponse.event_id}' LIMIT 1`;
    void pollVisible(rawSql).then(({ ms, found }) => {
      broker.broadcast({
        type: "it_visible",
        event_id: vmResponse.event_id,
        it_poll_ms: ms,
        confirmed: found,
        table: "raw",
      } as WsItVisibleMsg);
    });

    if (vmResponse.event_ts && vmResponse.position_id) {
      const pid = vmResponse.position_id.replace(/'/g, "''");
      const ets = vmResponse.event_ts.replace(/'/g, "''");
      const bookSql = `SELECT 1 FROM ${APP_FQN}.POSITION_BOOK WHERE POSITION_ID = '${pid}' AND BOOK_TS >= '${ets}'::TIMESTAMP_NTZ LIMIT 1`;
      void pollVisible(bookSql).then(({ ms, found }) => {
        broker.broadcast({
          type: "it_visible",
          event_id: vmResponse.event_id,
          it_poll_ms: ms,
          confirmed: found,
          table: "book",
        } as WsItVisibleMsg);
      });
    }

    return NextResponse.json({
      event_id: vmResponse.event_id,
      event_type: body.event_type,
      position_id: vmResponse.position_id,
      partition: vmResponse.partition,
      event_ts: vmResponse.event_ts,
      vm_received_ms: vmResponse.vm_received_ms,
      sdk_appended_ms: vmResponse.sdk_appended_ms,
      flush_committed_ms: vmResponse.flush_committed_ms,
      book_flush_committed_ms: vmResponse.book_flush_committed_ms,
      total_handler_ms: vmResponse.total_handler_ms,
      server_total_ms: Date.now() - t0,
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Ingest failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 }
    );
  }
}
