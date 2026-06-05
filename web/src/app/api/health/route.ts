/**
 * GET /api/health — Proxies the VM /health endpoint for HpaStatus tile.
 * 5s timeout; caches result for 2s in-memory.
 */

import { NextResponse } from "next/server";
import { getTunnelHost } from "../../../server/vm-proxy";
import { loadAppConfig } from "../../../server/snowflake-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let cachedResult: { data: unknown; ts: number } | null = null;
const CACHE_TTL_MS = 2000;

export async function GET() {
  // Return cached if fresh
  if (cachedResult && Date.now() - cachedResult.ts < CACHE_TTL_MS) {
    return NextResponse.json(cachedResult.data);
  }

  let host = getTunnelHost();
  if (!host) {
    // Try loading config
    const cfg = await loadAppConfig();
    host = cfg.INGEST_TUNNEL_HOST || process.env.INGEST_TUNNEL_HOST || "";
  }

  if (!host) {
    return NextResponse.json(
      { status: "unreachable", error: "INGEST_TUNNEL_HOST not configured" },
      { status: 503 }
    );
  }

  try {
    const response = await fetch(`https://${host}/health`, {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      const data = { status: "degraded", http_status: response.status };
      cachedResult = { data, ts: Date.now() };
      return NextResponse.json(data);
    }

    const data = await response.json();
    cachedResult = { data, ts: Date.now() };
    return NextResponse.json(data);
  } catch (err) {
    const data = {
      status: "unreachable",
      error: err instanceof Error ? err.message : String(err),
    };
    cachedResult = { data, ts: Date.now() };
    return NextResponse.json(data, { status: 503 });
  }
}
