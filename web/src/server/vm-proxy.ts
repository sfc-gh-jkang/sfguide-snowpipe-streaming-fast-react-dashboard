/**
 * VM ingest proxy — POSTs events to the VM tunnel (cloudflared) with X-API-Key.
 * Matches the contract from vm-ingest/ingest_worker.py:189-231.
 */

import { loadAppConfig } from "./snowflake-client";
import type { IngestRequest, IngestResponse } from "../lib/types";

let tunnelHost: string | null = null;
let apiKey: string | null = null;

async function ensureConfig(): Promise<void> {
  if (tunnelHost && apiKey) return;

  const cfg = await loadAppConfig();
  tunnelHost =
    cfg.INGEST_TUNNEL_HOST ||
    process.env.INGEST_TUNNEL_HOST ||
    "";
  apiKey =
    cfg.INGEST_API_KEY ||
    process.env.INGEST_API_KEY ||
    "";
}

export async function ingestEvent(req: IngestRequest): Promise<IngestResponse> {
  await ensureConfig();

  if (!tunnelHost) {
    throw new Error("INGEST_TUNNEL_HOST not configured");
  }
  if (!apiKey) {
    throw new Error("INGEST_API_KEY not configured");
  }

  const url = `https://${tunnelHost}/ingest`;
  const response = await fetch(url, {
    method: "POST",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify(req),
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`VM ingest failed (${response.status}): ${text}`);
  }

  const result = await response.json();
  return result as IngestResponse;
}

export interface IngestBatchResponse {
  ingested: number;
  elapsed_ms: number;
}

export async function ingestBatch(
  events: IngestRequest[]
): Promise<IngestBatchResponse> {
  await ensureConfig();

  if (!tunnelHost) {
    throw new Error("INGEST_TUNNEL_HOST not configured");
  }
  if (!apiKey) {
    throw new Error("INGEST_API_KEY not configured");
  }

  const url = `https://${tunnelHost}/ingest/batch`;
  const response = await fetch(url, {
    method: "POST",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify(events),
    signal: AbortSignal.timeout(60000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`VM batch ingest failed (${response.status}): ${text}`);
  }

  return (await response.json()) as IngestBatchResponse;
}

export function getTunnelHost(): string | null {
  return tunnelHost;
}
