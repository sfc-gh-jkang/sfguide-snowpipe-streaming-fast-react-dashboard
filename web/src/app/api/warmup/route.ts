/**
 * GET /api/_warmup — internal route hit by server.js on boot to force-load
 * ws-broker + snowflake-reader so their `globalThis` singletons populate
 * BEFORE the first WebSocket upgrade arrives.
 *
 * Without this, the first WS upgrade in a freshly started container reaches
 * server.js's upgrade handler before any route has loaded ws-broker, so
 * `globalThis.__wsBrokerClients` is undefined and the connection closes
 * with code 1013 ("broker not ready").
 *
 * The route itself does nothing — the side effect of importing the modules
 * is what we need.
 */

import { NextResponse } from "next/server";
import * as broker from "../../../server/ws-broker";
import { isRunning, start } from "../../../server/snowflake-reader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  // Touch the broker module so globalThis.__wsBrokerClients is populated.
  const clientCount = broker.getClientCount();

  // Touch the reader module + auto-start it if no client has triggered
  // start() yet (e.g., container just booted, no WS yet).
  if (!isRunning()) {
    try {
      start();
    } catch (err) {
      return NextResponse.json(
        {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          clientCount,
          readerRunning: false,
        },
        { status: 500 }
      );
    }
  }

  return NextResponse.json({
    ok: true,
    clientCount,
    readerRunning: isRunning(),
  });
}
