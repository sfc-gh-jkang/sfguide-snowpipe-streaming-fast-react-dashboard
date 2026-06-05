/**
 * POST /api/ingest — Proxy ingest events to VM tunnel.
 * Broadcasts optimistic + verified messages via WebSocket broker.
 *
 * IT-poll architectural fix (item #12, this session):
 *   The server-side IT visibility check (~1.5-1.8 s) used to be awaited
 *   BEFORE returning, inflating the apparent click-pipeline cost vs
 *   Streamlit's parent fork (which doesn't verify visibility on click).
 *   That made the "click pipeline" segment look ~4x slower than the
 *   apples-to-apples baseline. Fixed by:
 *     1. Returning at HPA flush ack (~250 ms).
 *     2. Spawning checkVisibleQuick() as fire-and-forget AFTER the response.
 *     3. Broadcasting `it_visible` via WS so the latency bar updates post-hoc.
 *   Net effect: matches Streamlit's click pipeline exactly. End-to-end story
 *   (click → fresh data) is now strictly honest — React and Streamlit are
 *   roughly tied on raw speed (~3 s); React's wins are click-acknowledgment
 *   paint (10 ms vs 2.5 s) and auto-freshness, not raw latency.
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

async function checkVisibleQuick(eventId: string): Promise<number> {
  const start = Date.now();
  const MAX_POLLS = 5;
  for (let i = 0; i < MAX_POLLS; i++) {
    try {
      const rows = await executeQuery(
        `SELECT 1 FROM ${APP_FQN}.RAW_EVENTS
         WHERE EVENT_ID = '${eventId}'
         LIMIT 1`
      );
      if (rows.length > 0) return Date.now() - start;
    } catch {
      /* retry */
    }
    if (i < MAX_POLLS - 1) await new Promise((r) => setTimeout(r, 50));
  }
  return Date.now() - start;
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
    const vmResponse = await ingestEvent(body);

    // Broadcast `verified` immediately at HPA flush ack — the row is committed
    // server-side. it_poll_ms=0 here; the actual visibility lag is broadcast
    // separately via `it_visible` once checkVisibleQuick resolves below.
    const verifiedMsg: WsVerifiedMsg = {
      type: "verified",
      event_id: vmResponse.event_id,
      latency: {
        network_ms: networkMs,
        sdk_appended_ms: vmResponse.sdk_appended_ms,
        flush_committed_ms: vmResponse.flush_committed_ms,
        it_poll_ms: 0,
        total_ms: Date.now() - t0,
      },
    };
    broker.broadcast(verifiedMsg);

    // Fire-and-forget visibility probe. Runs AFTER we return so the response
    // matches Streamlit's parent fork (which doesn't verify visibility either).
    // Result is broadcast via WS; the client's latency bar gets updated
    // post-hoc with the real IT-poll lag.
    void checkVisibleQuick(vmResponse.event_id).then((itPollMs) => {
      const itVisibleMsg: WsItVisibleMsg = {
        type: "it_visible",
        event_id: vmResponse.event_id,
        it_poll_ms: itPollMs,
      };
      broker.broadcast(itVisibleMsg);
    });

    return NextResponse.json({
      event_id: vmResponse.event_id,
      event_type: body.event_type,
      position_id: vmResponse.position_id,
      partition: vmResponse.partition,
      sdk_appended_ms: vmResponse.sdk_appended_ms,
      flush_committed_ms: vmResponse.flush_committed_ms,
      total_handler_ms: vmResponse.total_handler_ms,
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Ingest failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 }
    );
  }
}
