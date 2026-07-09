/**
 * VM ingest proxy — POSTs events to the VM tunnel (cloudflared) with X-API-Key.
 * Mirrors the /ingest and /ingest/batch contract in vm-ingest/ingest_worker.py.
 */

import { loadAppConfig } from "./snowflake-client";
import type { IngestRequest, IngestResponse } from "../lib/types";

let tunnelHost: string | null = null;
let apiKey: string | null = null;
let configLoadedAt = 0;
// Re-read APP_CONFIG periodically so a rotated cloudflared tunnel host (quick
// tunnels are ephemeral) or a changed API key is picked up WITHOUT a full app
// redeploy — deploy-app.sh MERGEs the new value into APP_CONFIG and this TTL
// refreshes it within a minute. Previously the config was cached for the whole
// process lifetime, so a tunnel rotation silently broke ingest until restart.
const CONFIG_TTL_MS = 60_000;

async function ensureConfig(): Promise<void> {
  const fresh =
    tunnelHost && apiKey && Date.now() - configLoadedAt < CONFIG_TTL_MS;
  if (fresh) return;

  const cfg = await loadAppConfig();
  const host = cfg.INGEST_TUNNEL_HOST || process.env.INGEST_TUNNEL_HOST || "";
  const key = cfg.INGEST_API_KEY || process.env.INGEST_API_KEY || "";
  // Keep the last-good value on a transient empty read; only stamp the refresh
  // time once both are populated so we retry promptly until config is available.
  if (host) tunnelHost = host;
  if (key) apiKey = key;
  if (host && key) configLoadedAt = Date.now();
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
    // 15 s > the VM's own wait_for_flush(timeout_seconds=10), so a slow-but-valid
    // flush surfaces as a clean VM error rather than a client-side abort race.
    signal: AbortSignal.timeout(15000),
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
