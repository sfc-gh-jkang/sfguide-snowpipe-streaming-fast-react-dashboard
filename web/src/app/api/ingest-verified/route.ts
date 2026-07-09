/**
 * POST /api/ingest-verified — the HONEST "click → on-screen, served ONLY by the
 * Interactive Table" path.
 *
 * Unlike /api/ingest (which returns at flush-ack and lets the UI paint an
 * OPTIMISTIC row before the table confirms), this route:
 *   1. Appends + flushes the event through Snowpipe Streaming HPA (the VM).
 *   2. Tight-polls the RAW_EVENTS Interactive Table on the INTERACTIVE warehouse
 *      by EVENT_ID until the row is queryable, and RETURNS THAT ROW.
 * So the row the client renders was genuinely read back from the Interactive
 * Table — not an optimistic guess. The client times click → painted around this
 * one request to get the true end-to-end IT-served latency.
 */
import { NextRequest, NextResponse } from "next/server";
import { ingestEvent } from "../../../server/vm-proxy";
import { executeQuery } from "../../../server/snowflake-client";
import { APP_FQN } from "../../../server/config";
import type { IngestRequest } from "../../../lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const READ_COLS =
  "EVENT_ID, EVENT_TYPE, POSITION_ID, ISSUER, SECTOR, NEW_MARK, EVENT_TS";

export async function POST(req: NextRequest) {
  const t0 = Date.now();

  let body: IngestRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.event_type) body = { ...body, event_type: "MARK" };

  try {
    // 1) Append + flush (commit to the Interactive Table via HPA).
    const vm = await ingestEvent(body);
    const tFlushed = Date.now();

    // 2) Poll the Interactive Table (on the interactive WH — served ONLY by the
    //    IT) until the just-committed row is queryable; the successful read
    //    returns the row itself.
    const sql = `SELECT ${READ_COLS} FROM ${APP_FQN}.RAW_EVENTS WHERE EVENT_ID = '${vm.event_id}' LIMIT 1`;
    const pollStart = Date.now();
    const MAX_READS = 40; // ~ up to a few seconds of tight polling
    let row: Record<string, unknown> | null = null;
    let reads = 0;
    let lastReadMs = 0;
    for (let i = 0; i < MAX_READS; i++) {
      reads++;
      const tRead = Date.now();
      const rows = await executeQuery(sql); // default warehouse = INTERACTIVE_WH
      lastReadMs = Date.now() - tRead;
      if (rows.length > 0) {
        row = rows[0];
        break;
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    const itVisibleMs = Date.now() - pollStart;

    return NextResponse.json(
      {
        event_id: vm.event_id,
        found: row != null,
        row,
        timings: {
          // server-side spans (client adds network + render)
          sdk_ms: vm.sdk_appended_ms,
          flush_ms: vm.flush_committed_ms,
          book_flush_ms: vm.book_flush_committed_ms ?? null,
          vm_total_ms: vm.total_handler_ms,
          // SPCS↔VM tunnel round-trip: the ingest call wall-time minus the work
          // the VM reported doing. This is the part a browser-only clock folds
          // into "network" — surfacing it lets the client attribute it honestly.
          server_transport_ms: Math.max(0, tFlushed - t0 - vm.total_handler_ms),
          it_read_to_visible_ms: itVisibleMs, // commit → first successful IT read
          it_reads: reads, // how many IT queries it took
          last_read_ms: lastReadMs, // latency of the read that returned the row
          server_total_ms: Date.now() - t0, // POST accept → row in hand
          flush_to_read_gap_ms: pollStart - tFlushed,
        },
      },
      {
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
          Pragma: "no-cache",
        },
      },
    );
  } catch (err) {
    return NextResponse.json(
      { error: `ingest-verified failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }
}
