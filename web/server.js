/**
 * Custom Next.js standalone server with WebSocket upgrade support.
 *
 * Replaces the auto-generated `.next/standalone/server.js` (see package.json
 * `postbuild` script). Strategy:
 *
 *   1. Postbuild renames the auto-generated `server.js` → `server-nextjs.js`
 *      (the original Next.js standalone bootstrap, with all the inlined
 *      nextConfig + webpack-loading dance Next.js requires).
 *   2. THIS file becomes the new `server.js`. It monkey-patches
 *      `http.createServer` BEFORE loading the original server, so when
 *      Next.js's internal `startServer` calls `http.createServer`, we
 *      capture the resulting server instance.
 *   3. After capture, we attach `wss.handleUpgrade` to that server for the
 *      `/api/ws` path — adding WebSocket support without touching Next.js's
 *      internal config/webpack flow.
 *
 * Why this dance:
 *   - Next.js standalone mode produces a stripped node_modules. Calling
 *     `next({ dev: false })` from a custom server crashes with "Cannot find
 *     module './bundle5'" (webpack chunks aren't traced into standalone).
 *   - Setting `__NEXT_PRIVATE_STANDALONE_CONFIG` doesn't bypass it in
 *     Next 14.2.35 — the only known-working bootstrap is the EXACT
 *     auto-generated server.js, used as-is.
 *   - Hijacking `http.createServer` is the canonical Next.js community
 *     pattern for adding WebSocket support to a standalone build.
 *
 * Why we need WS at all:
 *   SPCS Snowsight ingress reaps long-lived EventSource (SSE) GETs but
 *   forwards WebSocket Upgrade headers correctly. WebSocket is the only
 *   working push channel through SPCS for third-party apps. See global
 *   memory rule on SPCS streaming.
 */

const http = require("http");
const path = require("path");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");
const url = require("url");

// === Step 1: monkey-patch http.createServer to capture the server instance ===
// `startServer` (called by server-nextjs.js) calls http.createServer
// internally. We grab the first server it creates, then attach our WS
// upgrade handler after Next.js finishes its async initialization.
const realCreateServer = http.createServer;
let capturedServer = null;
http.createServer = function patchedCreateServer(...args) {
  const server = realCreateServer.apply(http, args);
  if (!capturedServer) {
    capturedServer = server;
    // Defer WS attachment until after Next.js has started listening. We
    // hook server.listen() to know when the server is bound.
    const realListen = server.listen.bind(server);
    server.listen = function patchedListen(...listenArgs) {
      const result = realListen(...listenArgs);
      // Bind the WS upgrade handler synchronously after listen() returns.
      // The HTTP server is now ready to receive upgrade events.
      attachWebSocketUpgrade(server);
      console.log(
        `[server.js] WebSocket upgrade handler attached at /api/ws (port ${process.env.PORT || 3000})`
      );
      // Bootstrap broker + reader globals so the first WS upgrade finds them.
      bootstrapModules();
      return result;
    };
  }
  return server;
};

// === Step 2: load and run the unmodified Next.js standalone bootstrap ===
// `server-nextjs.js` is the original auto-generated standalone server.js
// (postbuild renames it before copying our custom server.js into place).
// It will call http.createServer (monkey-patched above) and start the
// Next.js handler, exactly as it did before.
require(path.join(__dirname, "server-nextjs.js"));

// === Step 3: WebSocket upgrade handler ===
function attachWebSocketUpgrade(server) {
  const wss = new WebSocketServer({ noServer: true });

  function getBroker() {
    const clients = globalThis.__wsBrokerClients;
    if (!clients) return null;
    return {
      register(id, ws) {
        clients.set(id, ws);
      },
      unregister(id) {
        clients.delete(id);
      },
    };
  }

  function getReader() {
    const state = globalThis.__snowflakeReader;
    if (!state) return null;
    return {
      isRunning() {
        return state.running;
      },
      getLatestSnapshot() {
        return state.latestSnapshot;
      },
    };
  }

  server.on("upgrade", (req, socket, head) => {
    const parsed = url.parse(req.url || "", true);

    if (parsed.pathname !== "/api/ws") {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const clientId = crypto.randomUUID();
      const broker = getBroker();
      const reader = getReader();

      if (!broker) {
        console.warn(
          "[server.js] WS upgrade received before broker globals were populated; closing"
        );
        ws.close(1013, "broker not ready");
        return;
      }

      broker.register(clientId, ws);

      // Send an initial snapshot if the reader has cached data. These ARE
      // the real cached values (not placeholders), so the client immediately
      // shows the correct UI. Each carries _emit_ts so wire latency
      // measurement works on the very first message.
      if (reader) {
        const snapshot = reader.getLatestSnapshot();
        if (snapshot.tape && snapshot.tape.length > 0) {
          ws.send(
            JSON.stringify({
              type: "tape",
              events: snapshot.tape,
              _emit_ts: Date.now(),
            })
          );
        }
        if (snapshot.kpi) {
          ws.send(JSON.stringify({ ...snapshot.kpi, _emit_ts: Date.now() }));
        }
        if (snapshot.sector && snapshot.sector.length > 0) {
          ws.send(
            JSON.stringify({
              type: "sector",
              rows: snapshot.sector,
              _emit_ts: Date.now(),
            })
          );
        }
        if (snapshot.topmarks && snapshot.topmarks.length > 0) {
          ws.send(
            JSON.stringify({
              type: "topmarks",
              rows: snapshot.topmarks,
              _emit_ts: Date.now(),
            })
          );
        }
      }

      // NOTE: do NOT send a placeholder `hpa_status` hello here. Earlier
      // versions sent {channel_count: 0} as a connection-alive ping which
      // overwrote the real HPA status (sourced from /api/health polling
      // every ~5 s). Result: every WS reconnect flickered the channel
      // count from 4 to 0 to 4. Wire latency measurement uses the snapshot
      // messages above (when reader is warm) or the next snowflake-reader
      // broadcast (within ~200 ms).

      ws.on("close", () => broker.unregister(clientId));
      ws.on("error", () => broker.unregister(clientId));
    });
  });
}

/**
 * Force the route-handler bundle to load by hitting /api/_warmup. That
 * route imports ws-broker + snowflake-reader, which populate
 * `globalThis.__wsBrokerClients` and `globalThis.__snowflakeReader` and
 * trigger the IT-poll loop. Without this, the first WS upgrade would arrive
 * before the broker globals exist.
 */
function bootstrapModules() {
  // Small delay to let Next.js finish its async initialization.
  setTimeout(() => {
    const port = parseInt(process.env.PORT, 10) || 3000;
    const req = http.request(
      { host: "127.0.0.1", port, path: "/api/warmup", method: "GET" },
      (res) => {
        res.resume();
        console.log(
          `[server.js] warmup route hit, status=${res.statusCode}`
        );
      }
    );
    req.on("error", (err) =>
      console.warn("[server.js] warmup request failed:", err.message)
    );
    req.end();
  }, 1500);
}

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down...");
  process.exit(0);
});
