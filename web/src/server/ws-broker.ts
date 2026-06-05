/**
 * WebSocket broker — singleton in-process broadcaster.
 * Manages connected clients and broadcasts WsMessage payloads.
 *
 * Every broadcast is timestamped server-side via `_emit_ts` (ms epoch) so
 * the client can measure wire-delivery latency as `Date.now() - _emit_ts`.
 * That measurement powers the LatencyComparison "WebSocket push" segment
 * (replacing the SSE path that doesn't survive SPCS Snowsight ingress —
 * see CLAUDE.md / global memory rule on SPCS streaming).
 *
 * SHARED STATE WARNING: this module is loaded TWICE in production —
 * once by Next.js's bundled route handlers (e.g. /api/ingest), and once
 * by the custom server.js (via require) for the WebSocket upgrade path.
 * Module-level `const` state would create two independent instances and
 * the broker would silently fail (registers in one, broadcasts from the
 * other = no clients to send to). We pin the clients Map onto
 * `globalThis.__wsBrokerClients` so both copies of this module share the
 * same Map. Both run in the same Node process, so globalThis IS shared.
 */

import type WebSocket from "ws";
import type { WsMessage } from "../lib/types";

interface BrokerGlobal {
  __wsBrokerClients?: Map<string, WebSocket>;
}

const g = globalThis as BrokerGlobal;
g.__wsBrokerClients ??= new Map<string, WebSocket>();
const clients = g.__wsBrokerClients;

export function register(clientId: string, ws: WebSocket): void {
  clients.set(clientId, ws);
  // Lazy-start the snowflake-reader poll loop on first client.
  // We dynamic-require to avoid a circular module load at file-eval time
  // (the reader imports the broker too). By the time register() is called,
  // both modules have been initialized.
  // Skip in test/jest environments — reader.start() would leak a setInterval
  // and force jest to use --forceExit. Tests can call reader.start() directly
  // when needed.
  const isTest =
    process.env.NODE_ENV === "test" ||
    typeof (globalThis as { jest?: unknown }).jest !== "undefined";
  if (clients.size === 1 && !isTest) {
    void (async () => {
      try {
        // Use dynamic import so this resolves through Next.js's module graph
        // (and shares the globalThis.__snowflakeReader singleton).
        const reader = await import("./snowflake-reader");
        if (!reader.isRunning()) reader.start();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[ws-broker] failed to start reader:", err);
      }
    })();
  }
}

export function unregister(clientId: string): void {
  clients.delete(clientId);
}

export function broadcast(payload: WsMessage): void {
  // Stamp the message just before serialization so the timestamp reflects
  // when the wire-write actually happens (closer to the true emit time).
  const stamped = { ...payload, _emit_ts: Date.now() };
  const msg = JSON.stringify(stamped);
  for (const [id, ws] of clients) {
    if (ws.readyState === ws.OPEN) {
      ws.send(msg);
    } else {
      clients.delete(id);
    }
  }
}

export function sendToClient(clientId: string, payload: WsMessage): void {
  const ws = clients.get(clientId);
  if (ws && ws.readyState === ws.OPEN) {
    const stamped = { ...payload, _emit_ts: Date.now() };
    ws.send(JSON.stringify(stamped));
  }
}

export function getClientCount(): number {
  return clients.size;
}
