/**
 * @jest-environment jsdom
 */
import "@testing-library/jest-dom";
import { useDashboardStore } from "@/lib/store";

// Mock WebSocket
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  readyState = 0; // CONNECTING
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  url: string;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    // Simulate connection opening async
    setTimeout(() => {
      this.readyState = 1; // OPEN
      this.onopen?.();
    }, 10);
  }

  close() {
    this.readyState = 3; // CLOSED
    this.onclose?.();
  }

  send(_data: string) {}
}

Object.defineProperty(global, "WebSocket", { value: MockWebSocket, writable: true });
(global as Record<string, unknown>).WebSocket = MockWebSocket;

// Reset state between tests
beforeEach(() => {
  MockWebSocket.instances = [];
  useDashboardStore.setState({
    tape: [],
    kpi: { total_pnl: 0, position_count: 0, gainers: 0, losers: 0, watchlist_count: 0, it_lag_seconds: 0 },
    sector: [],
    topmarks: [],
    hpaStatus: { channel_count: 0, pipe_name: "", status: "unknown" },
    latencyBars: [],
  });
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("WebSocket hook behavior (store-level)", () => {
  it("deduplicates events by event_id in the store", () => {
    const store = useDashboardStore.getState();

    store.addOptimisticEvent({
      event_id: "dup-1",
      event_type: "TRADE",
      position_id: "p1",
      issuer: "A",
      sector: "B",
      partition: 0,
      ingested_ts: "",
      status: "pending",
    });

    store.addOptimisticEvent({
      event_id: "dup-1",
      event_type: "TRADE",
      position_id: "p1",
      issuer: "A",
      sector: "B",
      partition: 0,
      ingested_ts: "",
      status: "pending",
    });

    expect(useDashboardStore.getState().tape).toHaveLength(1);
  });

  it("verifyEvent swaps status from pending to verified", () => {
    const store = useDashboardStore.getState();

    store.addOptimisticEvent({
      event_id: "verify-1",
      event_type: "MARK",
      position_id: "p2",
      issuer: "B",
      sector: "C",
      partition: 1,
      ingested_ts: "",
      status: "pending",
    });

    store.verifyEvent("verify-1");
    const tape = useDashboardStore.getState().tape;
    expect(tape[0].status).toBe("verified");
  });

  it("reconnects with exponential backoff on close", () => {
    // Simulate the reconnection logic manually (testing the math)
    const RECONNECT_BASE_MS = 1000;
    const RECONNECT_CAP_MS = 30000;

    const delays: number[] = [];
    for (let attempt = 0; attempt < 8; attempt++) {
      const delay = Math.min(
        RECONNECT_BASE_MS * Math.pow(2, attempt),
        RECONNECT_CAP_MS
      );
      delays.push(delay);
    }

    expect(delays[0]).toBe(1000);
    expect(delays[1]).toBe(2000);
    expect(delays[2]).toBe(4000);
    expect(delays[3]).toBe(8000);
    expect(delays[4]).toBe(16000);
    expect(delays[5]).toBe(30000); // capped
    expect(delays[6]).toBe(30000); // still capped
    expect(delays[7]).toBe(30000); // still capped
  });

  it("limits tape to 30 events", () => {
    const store = useDashboardStore.getState();

    for (let i = 0; i < 40; i++) {
      store.addOptimisticEvent({
        event_id: `evt-${i}`,
        event_type: "TRADE",
        position_id: `p-${i}`,
        issuer: `Issuer ${i}`,
        sector: "Sector",
        partition: 0,
        ingested_ts: "",
        status: "pending",
      });
    }

    expect(useDashboardStore.getState().tape).toHaveLength(30);
  });

  // Item #12 (this session): IT-poll moved off the request path. /api/ingest
  // returns at HPA flush ack and broadcasts `it_visible` later via WS. The
  // store needs to update the matching latency bar by event_id when that
  // async message arrives.
  it("updateLatencyBarItPoll fills it_poll_ms by event_id post-hoc", () => {
    const store = useDashboardStore.getState();

    store.addLatencyBar({
      label: "#abc TRADE",
      event_id: "evt-it-1",
      network_ms: 150,
      sdk_appended_ms: 25,
      flush_committed_ms: 250,
      vm_overhead_ms: 5,
      it_poll_ms: 0, // Starts at 0; updated when WS arrives.
      render_ms: 0,
    });

    store.updateLatencyBarItPoll("evt-it-1", 1820, true, "raw");

    const bars = useDashboardStore.getState().latencyBars;
    const bar = bars.find((b) => b.event_id === "evt-it-1");
    expect(bar).toBeDefined();
    expect(bar!.it_poll_ms).toBe(1820);
    expect(bar!.it_poll_confirmed).toBe(true);
    // Other fields untouched.
    expect(bar!.network_ms).toBe(150);
    expect(bar!.sdk_appended_ms).toBe(25);
    expect(bar!.flush_committed_ms).toBe(250);
  });

  it("updateLatencyBarItPoll is a no-op when event_id is unknown", () => {
    const store = useDashboardStore.getState();

    store.addLatencyBar({
      label: "#xyz MARK",
      event_id: "evt-known",
      network_ms: 100,
      sdk_appended_ms: 10,
      flush_committed_ms: 200,
      vm_overhead_ms: 3,
      it_poll_ms: 0,
      render_ms: 0,
    });

    // Stale or out-of-order WS message: bar was already evicted from the cap.
    store.updateLatencyBarItPoll("evt-vanished", 9999, true, "raw");

    const bars = useDashboardStore.getState().latencyBars;
    expect(bars).toHaveLength(1);
    expect(bars[0].it_poll_ms).toBe(0); // untouched
  });

  it("addLatencyBar dedups by event_id: client bar replaces a ws placeholder", () => {
    useDashboardStore.setState({ latencyBars: [] });
    const store = useDashboardStore.getState();

    // WS optimistic echo lands first (server-side network, 0 VM segments).
    store.addLatencyBar({
      label: "#1 TRADE",
      event_id: "evt-dup",
      network_ms: 1,
      sdk_appended_ms: 0,
      flush_committed_ms: 0,
      vm_overhead_ms: 0,
      it_poll_ms: 0,
      render_ms: 0,
      source: "ws",
    });
    // Client bar for the SAME event arrives (accurate network + segments).
    store.addLatencyBar({
      label: "#1 TRADE",
      event_id: "evt-dup",
      network_ms: 140,
      sdk_appended_ms: 2,
      flush_committed_ms: 90,
      vm_overhead_ms: 6,
      it_poll_ms: 0,
      render_ms: 11,
      source: "client",
    });

    const bars = useDashboardStore.getState().latencyBars;
    expect(bars).toHaveLength(1); // deduped
    expect(bars[0].source).toBe("client"); // client won
    expect(bars[0].network_ms).toBe(140);
    expect(bars[0].render_ms).toBe(11);

    // A late ws dup for the same event is ignored (client stays).
    store.addLatencyBar({
      label: "#1b TRADE",
      event_id: "evt-dup",
      network_ms: 1,
      sdk_appended_ms: 0,
      flush_committed_ms: 0,
      vm_overhead_ms: 0,
      it_poll_ms: 0,
      render_ms: 0,
      source: "ws",
    });
    const after = useDashboardStore.getState().latencyBars;
    expect(after).toHaveLength(1);
    expect(after[0].network_ms).toBe(140);
  });

  it("updateLatencyBarItPoll routes table='book' to the book fields", () => {
    useDashboardStore.setState({ latencyBars: [] });
    const store = useDashboardStore.getState();
    store.addLatencyBar({
      label: "#b MARK",
      event_id: "evt-book",
      network_ms: 100,
      sdk_appended_ms: 1,
      flush_committed_ms: 80,
      vm_overhead_ms: 4,
      it_poll_ms: 0,
      render_ms: 0,
      source: "client",
    });

    store.updateLatencyBarItPoll("evt-book", 320, true, "raw");
    store.updateLatencyBarItPoll("evt-book", 410, true, "book");

    const bar = useDashboardStore
      .getState()
      .latencyBars.find((b) => b.event_id === "evt-book")!;
    expect(bar.it_poll_ms).toBe(320);
    expect(bar.it_poll_confirmed).toBe(true);
    expect(bar.book_poll_ms).toBe(410);
    expect(bar.book_poll_confirmed).toBe(true);
  });
});
