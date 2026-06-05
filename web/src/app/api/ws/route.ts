/**
 * /api/ws — Next.js HTTP-side handler.
 *
 * The actual WebSocket UPGRADE is handled by the custom server.js wrapper
 * (which monkey-patches http.createServer to attach a ws-broker upgrade
 * listener before delegating to Next.js). This handler exists so that:
 *   (a) Next.js's router recognizes the /api/ws path during build, and
 *   (b) any client that hits /api/ws over plain HTTP/GET (without the
 *       Upgrade header) gets a clear 426 "Upgrade Required" response
 *       instead of a 404.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return new Response("WebSocket endpoint — connect via ws:// protocol", {
    status: 426,
    headers: { "Content-Type": "text/plain", Upgrade: "websocket" },
  });
}
