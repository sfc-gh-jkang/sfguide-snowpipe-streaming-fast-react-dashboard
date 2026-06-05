/**
 * @jest-environment node
 */
// Tests for vm-proxy — mock fetch, verify X-API-Key header, response shape.

// Mock snowflake-client before import
jest.mock("../../src/server/snowflake-client", () => ({
  loadAppConfig: jest.fn().mockResolvedValue({
    INGEST_TUNNEL_HOST: "test-tunnel.example.com",
    INGEST_API_KEY: "test-api-key-123",
  }),
}));

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

import { ingestEvent } from "../../src/server/vm-proxy";

describe("vm-proxy", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("sends X-API-Key header in requests", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        event_id: "evt-1",
        event_type: "TRADE",
        position_id: "POS-001",
        partition: 0,
        sdk_appended_ms: 12.5,
        flush_committed_ms: 45.2,
        total_handler_ms: 58.1,
      }),
    });

    await ingestEvent({ event_type: "TRADE", position_id: "POS-001" });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://test-tunnel.example.com/ingest");
    expect(opts.headers["X-API-Key"]).toBe("test-api-key-123");
    expect(opts.method).toBe("POST");
  });

  it("returns response matching IngestResponse shape", async () => {
    const vmResponse = {
      event_id: "evt-2",
      event_type: "MARK",
      position_id: "POS-002",
      partition: 1,
      sdk_appended_ms: 8.3,
      flush_committed_ms: 32.7,
      total_handler_ms: 41.5,
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => vmResponse,
    });

    const result = await ingestEvent({ event_type: "MARK", position_id: "POS-002" });

    expect(result).toEqual(vmResponse);
    expect(result.event_id).toBeDefined();
    expect(result.partition).toEqual(expect.any(Number));
    expect(result.sdk_appended_ms).toEqual(expect.any(Number));
    expect(result.flush_committed_ms).toEqual(expect.any(Number));
    expect(result.total_handler_ms).toEqual(expect.any(Number));
  });

  it("throws on non-OK HTTP response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => "StreamingService not initialized",
    });

    await expect(
      ingestEvent({ event_type: "TRADE", position_id: "POS-003" })
    ).rejects.toThrow("VM ingest failed (503)");
  });

  it("sends correct JSON body", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        event_id: "evt-3",
        event_type: "CREDIT_EVENT",
        position_id: "POS-004",
        partition: 2,
        sdk_appended_ms: 5.0,
        flush_committed_ms: 20.0,
        total_handler_ms: 25.5,
      }),
    });

    const req = { event_type: "CREDIT_EVENT" as const, position_id: "POS-004" };
    await ingestEvent(req);

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(opts.body)).toEqual(req);
  });
});
