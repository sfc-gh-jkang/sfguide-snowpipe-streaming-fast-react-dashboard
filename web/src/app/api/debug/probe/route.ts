/**
 * POST /api/debug/probe — Latency probe for verification.
 * Fires N synthetic clicks, measures end-to-end, returns p50/p95/p99 latencies.
 */

import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let count = 100;
  try {
    const body = await req.json();
    count = body.count || 100;
  } catch {
    // Use default count
  }

  const baseUrl = req.nextUrl.origin;
  const latencies: number[] = [];

  for (let i = 0; i < count; i++) {
    const t0 = Date.now();
    try {
      const resp = await fetch(`${baseUrl}/api/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_type: "TRADE",
          position_id: `PROBE-${i}`,
        }),
      });
      await resp.json();
      latencies.push(Date.now() - t0);
    } catch {
      latencies.push(-1);
    }
  }

  // Filter successful probes
  const successful = latencies.filter((l) => l >= 0).sort((a, b) => a - b);
  const n = successful.length;

  if (n === 0) {
    return NextResponse.json({ error: "All probes failed", count }, { status: 500 });
  }

  const p50 = successful[Math.floor(n * 0.5)];
  const p95 = successful[Math.floor(n * 0.95)];
  const p99 = successful[Math.floor(n * 0.99)];
  const mean = Math.round(successful.reduce((a, b) => a + b, 0) / n);

  return NextResponse.json({
    count,
    successful: n,
    failed: count - n,
    p50_ms: p50,
    p95_ms: p95,
    p99_ms: p99,
    mean_ms: mean,
    min_ms: successful[0],
    max_ms: successful[n - 1],
  });
}
