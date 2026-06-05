/**
 * POST /api/ingest-batch — Stress-test endpoint. Accepts {count: N, type: "TRADE"|"MARK"|"CREDIT_EVENT"|"MIXED"}.
 * Generates N events, calls VM /ingest/batch (single round-trip), returns aggregate stats.
 */
import { NextRequest, NextResponse } from "next/server";
import { ingestBatch } from "../../../server/vm-proxy";
import type { IngestRequest } from "../../../lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TYPES: ("TRADE" | "MARK" | "CREDIT_EVENT")[] = ["TRADE", "MARK", "CREDIT_EVENT"];

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  let body: { count?: number; type?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const count = Math.max(1, Math.min(100, Math.floor(body.count ?? 20)));
  const typeFilter = body.type;

  const events: IngestRequest[] = Array.from({ length: count }, (_, i) => ({
    event_type:
      typeFilter && TYPES.includes(typeFilter as "TRADE")
        ? (typeFilter as IngestRequest["event_type"])
        : TYPES[i % TYPES.length],
  }));

  try {
    const result = await ingestBatch(events);
    return NextResponse.json({
      requested: count,
      ingested: result.ingested,
      vm_elapsed_ms: result.elapsed_ms,
      total_handler_ms: Date.now() - t0,
      avg_per_event_ms: result.elapsed_ms / Math.max(1, result.ingested),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
