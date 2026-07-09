import { computeLiveLatency } from "../../src/lib/liveStats";
import type { LatencyBar } from "../../src/lib/types";

// Minimal bar factory — only the fields computeLiveLatency reads matter.
function bar(over: Partial<LatencyBar>): LatencyBar {
  return {
    label: "x",
    network_ms: 0,
    sdk_appended_ms: 0,
    flush_committed_ms: 0,
    vm_overhead_ms: 0,
    it_poll_ms: 0,
    render_ms: 0,
    ...over,
  };
}

describe("computeLiveLatency", () => {
  it("returns all-null / zero for no bars", () => {
    const r = computeLiveLatency([]);
    expect(r).toEqual({
      endToEndP50: null,
      endToEndP90: null,
      endToEndP95: null,
      endToEndP99: null,
      endToEndLast: null,
      visibilityP50: null,
      serverTransportP50: null,
      seg: { network: null, transport: null, appendVm: null, flush: null, visibility: null },
      count: 0,
      confirmedPct: null,
    });
  });

  it("excludes un-probed bars (it_poll_ms === 0)", () => {
    const r = computeLiveLatency([bar({ it_poll_ms: 0, flush_committed_ms: 300 })]);
    expect(r.count).toBe(0);
    expect(r.endToEndP50).toBeNull();
  });

  it("excludes probes that gave up (it_poll_confirmed === false)", () => {
    const r = computeLiveLatency([
      bar({ source: "ws", it_poll_ms: 4000, it_poll_confirmed: false }),
    ]);
    expect(r.count).toBe(0);
    expect(r.confirmedPct).toBe(0); // probed but none confirmed
  });

  it("sums the full pipeline for a ws bar INCLUDING server_transport", () => {
    // 5 + 20 + 1 + 300 + 4 + 2500 = 2830
    const r = computeLiveLatency([
      bar({
        source: "ws",
        network_ms: 5,
        server_transport_ms: 20,
        sdk_appended_ms: 1,
        flush_committed_ms: 300,
        vm_overhead_ms: 4,
        it_poll_ms: 2500,
        it_poll_confirmed: true,
      }),
    ]);
    expect(r.count).toBe(1);
    expect(r.endToEndP50).toBe(2830);
    expect(r.visibilityP50).toBe(2500);
    expect(r.serverTransportP50).toBe(20);
    expect(r.confirmedPct).toBe(100);
  });

  it("does NOT add server_transport for a client bar (already inside its network_ms)", () => {
    // client network already includes transport → e2e = 150 + 1 + 300 + 4 + 2500 = 2955
    // server_transport_ms is present but must be ignored for client source.
    const r = computeLiveLatency([
      bar({
        source: "client",
        network_ms: 150,
        server_transport_ms: 20, // present but must NOT be added
        sdk_appended_ms: 1,
        flush_committed_ms: 300,
        vm_overhead_ms: 4,
        it_poll_ms: 2500,
        it_poll_confirmed: true,
      }),
    ]);
    expect(r.endToEndP50).toBe(2955);
    expect(r.serverTransportP50).toBe(0); // transport not counted for client bars
  });

  it("computes medians across a mix and confirmedPct over probed bars", () => {
    const mk = (itPoll: number, confirmed: boolean) =>
      bar({ source: "ws", flush_committed_ms: 300, it_poll_ms: itPoll, it_poll_confirmed: confirmed });
    const r = computeLiveLatency([mk(2000, true), mk(3000, true), mk(9999, false)]);
    expect(r.count).toBe(2); // only confirmed
    expect(r.visibilityP50).toBe(3000); // median of [2000,3000] → upper-mid
    expect(r.confirmedPct).toBeCloseTo((2 / 3) * 100);
  });

  it("reports p50/p90/p95/p99 percentiles + per-segment medians", () => {
    // 10 ws bars, it_poll 100..1000; e2e = transport(20)+sdk(0)+flush(300)+vm(0)+it_poll
    const bars = Array.from({ length: 10 }, (_, i) =>
      bar({
        source: "ws",
        server_transport_ms: 20,
        flush_committed_ms: 300,
        it_poll_ms: (i + 1) * 100,
        it_poll_confirmed: true,
      }),
    );
    const r = computeLiveLatency(bars);
    expect(r.count).toBe(10);
    // e2e values: 420,520,...,1320. Nearest-rank clamps: p50→index5=920, p90→idx9=1320.
    expect(r.endToEndP50).toBe(920);
    expect(r.endToEndP90).toBe(1320);
    expect(r.endToEndP95).toBe(1320);
    expect(r.endToEndP99).toBe(1320);
    // segment medians
    expect(r.seg.transport).toBe(20);
    expect(r.seg.flush).toBe(300);
    expect(r.seg.visibility).toBe(600); // median of 100..1000
  });
});
