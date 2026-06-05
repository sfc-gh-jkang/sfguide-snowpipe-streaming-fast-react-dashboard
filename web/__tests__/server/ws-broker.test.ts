/**
 * @jest-environment node
 */
// Tests for ws-broker — register, broadcast, unregister.

import * as broker from "../../src/server/ws-broker";

// Mock WebSocket
function createMockWs(open = true) {
  const messages: string[] = [];
  return {
    OPEN: 1,
    CLOSED: 3,
    readyState: open ? 1 : 3,
    send: jest.fn((msg: string) => messages.push(msg)),
    messages,
  };
}

/**
 * Helper: parse the JSON string a mock WS received and assert it matches
 * the expected payload, ignoring the server-injected `_emit_ts` field
 * (added by ws-broker.broadcast() so clients can measure wire latency).
 */
function expectSentEqual(
  send: jest.Mock,
  expected: object,
  callIdx = 0,
): void {
  expect(send).toHaveBeenCalled();
  const arg = send.mock.calls[callIdx][0] as string;
  const parsed = JSON.parse(arg);
  expect(typeof parsed._emit_ts).toBe("number");
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _emit_ts, ...rest } = parsed;
  expect(rest).toEqual(expected);
}

describe("ws-broker", () => {
  beforeEach(() => {
    // Sweep any leftover clients from prior tests (the broker is a module-
    // level singleton). Clearing via the public unregister API by using a
    // probe broadcast to harvest connected ids isn't possible, so we rely
    // on each test cleaning up after itself; this beforeEach is a no-op
    // safety net documented for future maintainers.
  });

  it("broadcasts to all registered clients", () => {
    const ws1 = createMockWs();
    const ws2 = createMockWs();
    const ws3 = createMockWs();

    broker.register("client1", ws1 as any);
    broker.register("client2", ws2 as any);
    broker.register("client3", ws3 as any);

    const msg = { type: "kpi" as const, total_pnl: 100, position_count: 5, gainers: 3, losers: 2, watchlist_count: 1, it_lag_seconds: 0 };
    broker.broadcast(msg);

    expectSentEqual(ws1.send, msg);
    expectSentEqual(ws2.send, msg);
    expectSentEqual(ws3.send, msg);

    // Cleanup
    broker.unregister("client1");
    broker.unregister("client2");
    broker.unregister("client3");
  });

  it("does not send to unregistered clients", () => {
    const ws1 = createMockWs();
    const ws2 = createMockWs();

    broker.register("client1", ws1 as any);
    broker.register("client2", ws2 as any);

    broker.unregister("client1");

    const msg = { type: "kpi" as const, total_pnl: 200, position_count: 10, gainers: 6, losers: 4, watchlist_count: 2, it_lag_seconds: 1 };
    broker.broadcast(msg);

    expect(ws1.send).not.toHaveBeenCalled();
    expectSentEqual(ws2.send, msg);

    broker.unregister("client2");
  });

  it("removes closed clients on broadcast", () => {
    const ws1 = createMockWs(true);
    const ws2 = createMockWs(false); // closed

    broker.register("client1", ws1 as any);
    broker.register("client2", ws2 as any);

    const msg = { type: "tape" as const, events: [] };
    broker.broadcast(msg);

    expect(ws1.send).toHaveBeenCalled();
    expect(ws2.send).not.toHaveBeenCalled();

    // client2 should be gone now — a second broadcast shouldn't try it
    ws1.send.mockClear();
    broker.broadcast(msg);
    expect(ws1.send).toHaveBeenCalledTimes(1);

    broker.unregister("client1");
  });

  it("sendToClient targets a specific client", () => {
    const ws1 = createMockWs();
    const ws2 = createMockWs();

    broker.register("client1", ws1 as any);
    broker.register("client2", ws2 as any);

    const msg = { type: "kpi" as const, total_pnl: 50, position_count: 2, gainers: 1, losers: 1, watchlist_count: 0, it_lag_seconds: 0 };
    broker.sendToClient("client1", msg);

    expectSentEqual(ws1.send, msg);
    expect(ws2.send).not.toHaveBeenCalled();

    broker.unregister("client1");
    broker.unregister("client2");
  });

  it("getClientCount returns correct count", () => {
    // Sweep leftover state from earlier tests in this file (broker is a
    // module-level singleton; previous tests may not have unregistered
    // every id). We ignore the count delta since the assertion below uses
    // RELATIVE deltas.
    const baseline = broker.getClientCount();

    broker.register("count-a", createMockWs() as any);
    broker.register("count-b", createMockWs() as any);

    expect(broker.getClientCount()).toBe(baseline + 2);

    broker.unregister("count-a");
    expect(broker.getClientCount()).toBe(baseline + 1);

    broker.unregister("count-b");
    expect(broker.getClientCount()).toBe(baseline);
  });

  it("broadcast stamps every message with a server-side _emit_ts", () => {
    const ws1 = createMockWs();
    broker.register("emit-ts-client", ws1 as any);

    const before = Date.now();
    broker.broadcast({ type: "tape" as const, events: [] });
    const after = Date.now();

    const arg = ws1.send.mock.calls[0][0] as string;
    const parsed = JSON.parse(arg);
    expect(typeof parsed._emit_ts).toBe("number");
    expect(parsed._emit_ts).toBeGreaterThanOrEqual(before);
    expect(parsed._emit_ts).toBeLessThanOrEqual(after);

    broker.unregister("emit-ts-client");
  });
});
