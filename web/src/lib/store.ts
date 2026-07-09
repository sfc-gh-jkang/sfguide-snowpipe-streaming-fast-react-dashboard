import { create } from "zustand";
import type {
  Event,
  KpiState,
  SectorRow,
  TopMarkRow,
  HpaState,
  LatencyBar,
  ObservabilityState,
  BurstResult,
  DayMetrics,
} from "./types";

interface DashboardStore {
  tape: Event[];
  kpi: KpiState;
  sector: SectorRow[];
  topmarks: TopMarkRow[];
  hpaStatus: HpaState;
  latencyBars: LatencyBar[];
  observability: ObservabilityState;
  burstResult: BurstResult | null;
  warehouseMode: "interactive" | "standard";
  dayMetrics: DayMetrics | null;
  isInitialLoad: boolean;
  channelMode: "polling";
  timeTravelOffset: number;
  optimisticEnabled: boolean;
  /** Chart.js render timings (ms), capped at 50 entries per chart, FIFO. */
  chartRenderTimings: Record<string, number[]>;
  /**
   * Full-dashboard repaint timings (ms), capped at 50 entries.
   * Measured from `setTape/setKpi/setSector/setTopMarks/setDayMetrics` batch
   * call in fetchSnapshot → RAF×2 (browser paint completes for ALL subscribed
   * components: KpiTiles, LiveTape, SectorDonut, TopMarks, DayMetrics, etc.).
   * This is the apples-to-apples render number to compare with Streamlit's
   * full-script-rerun cost.
   */
  fullPageRenderTimings: number[];

  /**
   * WebSocket push-delivery wire latency: (client_now - server_emit_ts) per
   * message. Excludes the server-side scan + query work; this is pure
   * stream-delivery overhead measured on the live /api/ws connection.
   */
  wsDeliveryTimings: number[];

  addOptimisticEvent: (event: Event) => void;
  verifyEvent: (eventId: string) => void;
  setTape: (events: Event[]) => void;
  setKpi: (kpi: KpiState) => void;
  setSector: (rows: SectorRow[]) => void;
  setTopMarks: (rows: TopMarkRow[]) => void;
  setHpaStatus: (status: HpaState) => void;
  setObservability: (obs: ObservabilityState) => void;
  addLatencyBar: (bar: LatencyBar) => void;
  updateLatencyBar: (label: string, updates: Partial<LatencyBar>) => void;
  /** Merge partial updates into the bar matching eventId (no-op if absent). */
  updateLatencyBarByEventId: (eventId: string, updates: Partial<LatencyBar>) => void;
  /**
   * Update a latency bar's it_poll_ms by event_id (for the async it_visible
   * WS message that arrives after /api/ingest returns). Falls back to a no-op
   * if no bar with that event_id is found. `table` routes to raw vs book fields.
   */
  updateLatencyBarItPoll: (
    eventId: string,
    itPollMs: number,
    confirmed: boolean,
    table: "raw" | "book",
  ) => void;
  setBurstResult: (result: BurstResult | null) => void;
  setWarehouseMode: (mode: "interactive" | "standard") => void;
  setDayMetrics: (metrics: DayMetrics | null) => void;
  setInitialLoadDone: () => void;
  setChannelMode: (mode: "polling") => void;
  setTimeTravelOffset: (offset: number) => void;
  setOptimisticEnabled: (enabled: boolean) => void;
  addChartRenderTiming: (name: string, ms: number) => void;
  addFullPageRenderTiming: (ms: number) => void;
  /** Append a WebSocket push-delivery timing (ms), capped at 50 most recent. */
  addWsDeliveryTiming: (ms: number) => void;

  /**
   * Server-measured scan-detect timings (ms). Distance between the freshest
   * row's IT INGESTED_TS and the broker emit time. Stamped only on tape
   * messages where the server can compute it. Capped at 50.
   */
  scanDetectTimings: number[];
  addScanDetectTiming: (ms: number) => void;

  /**
   * Honest "click → Interactive-Table-confirmed on screen" latency, published by
   * the InteractiveLatency widget so any component (e.g. the /demo Fast card) can
   * show the SAME measured number instead of inventing one. p50/best over the
   * widget's rolling sample window; last = the most recent single fire. All in ms,
   * null until the first successful fire.
   */
  itServedP50Ms: number | null;
  itServedBestMs: number | null;
  itServedLastMs: number | null;
  setItServed: (p50: number | null, best: number | null, last: number | null) => void;

  /** Live WebSocket connection state — surfaced in the diagnostic strip. */
  wsState: "connecting" | "open" | "closed" | "error";
  setWsState: (s: "connecting" | "open" | "closed" | "error") => void;
  /** Total WS messages received this session. */
  wsMessageCount: number;
  incrementWsMessageCount: () => void;
}

const MAX_TAPE = 30;
const MAX_LATENCY_BARS = 20;

export const useDashboardStore = create<DashboardStore>((set) => ({
  tape: [],
  kpi: {
    total_pnl: 0,
    position_count: 0,
    gainers: 0,
    losers: 0,
    watchlist_count: 0,
    it_lag_seconds: 0,
  },
  sector: [],
  topmarks: [],
  hpaStatus: {
    channel_count: 0,
    pipe_name: "",
    status: "unknown",
  },
  latencyBars: [],
  observability: {
    watchlist: [],
    hourly_trades: [],
    ingest_stats: null,
    throughput_evt_per_min: 0,
    total_events_24h: 0,
    it_lag_seconds: 0,
  },
  burstResult: null,
  warehouseMode: "interactive",
  dayMetrics: null,
  isInitialLoad: true,
  channelMode: "polling",
  timeTravelOffset: 0,
  // Optimistic preview ON by default — clicking prepends a grey "pending"
  // row to the tape immediately (~10 ms perceived feedback) instead of
  // waiting ~1.5 s for IT visibility. The grey row swaps to "verified"
  // when the next snapshot poll / WebSocket push confirms IT has the row.
  // This hides the unavoidable IT visibility lag from the user without
  // changing actual data freshness — Streamlit cannot do this because its
  // rerun model has no separate optimistic state concept.
  optimisticEnabled: true,
  chartRenderTimings: {},
  fullPageRenderTimings: [],
  wsDeliveryTimings: [],
  scanDetectTimings: [],
  itServedP50Ms: null,
  itServedBestMs: null,
  itServedLastMs: null,
  wsState: "connecting",
  wsMessageCount: 0,

  addOptimisticEvent: (event) =>
    set((state) => {
      // Dedupe: don't add if event_id already exists
      if (state.tape.some((e) => e.event_id === event.event_id)) {
        return state;
      }
      const newTape = [event, ...state.tape].slice(0, MAX_TAPE);
      return { tape: newTape };
    }),

  verifyEvent: (eventId) =>
    set((state) => {
      const newTape = state.tape.map((e) =>
        e.event_id === eventId ? { ...e, status: "verified" as const } : e
      );
      return { tape: newTape };
    }),

  // Server-side data is the single source of truth — replace the tape on every
  // snapshot poll. When optimisticEnabled is true, merge: mark pending rows as
  // verified when matched by event_id, keep unmatched pending rows at the top.
  setTape: (events) =>
    set((state) => {
      if (!state.optimisticEnabled) {
        return { tape: events.slice(0, MAX_TAPE) };
      }
      // Merge: verified server rows take precedence; pending rows that match get verified
      const serverIds = new Set(events.map((e) => e.event_id));
      const pendingUnmatched = state.tape.filter(
        (e) => e.status === "pending" && !serverIds.has(e.event_id)
      );
      const merged = [
        ...pendingUnmatched,
        ...events.map((e) => {
          const wasPending = state.tape.find(
            (t) => t.event_id === e.event_id && t.status === "pending"
          );
          return wasPending ? { ...e, status: "verified" as const } : e;
        }),
      ].slice(0, MAX_TAPE);
      return { tape: merged };
    }),

  setKpi: (kpi) => set({ kpi }),

  setSector: (rows) => set({ sector: rows }),

  setTopMarks: (rows) => set({ topmarks: rows }),

  setHpaStatus: (status) => set({ hpaStatus: status }),

  setObservability: (obs) => set({ observability: obs }),

  addLatencyBar: (bar) =>
    set((state) => {
      // Dedup by event_id: an event fired by this browser produces both a
      // client-measured bar (accurate network+render) and a WS-optimistic echo.
      // A "client" bar always wins over a "ws" bar; same-source dups are ignored.
      if (bar.event_id) {
        const idx = state.latencyBars.findIndex((b) => b.event_id === bar.event_id);
        if (idx !== -1) {
          const existing = state.latencyBars[idx];
          if (bar.source === "client" && existing.source !== "client") {
            const next = state.latencyBars.slice();
            next[idx] = bar; // client replaces the ws placeholder
            return { latencyBars: next };
          }
          return state; // ignore duplicate
        }
      }
      return {
        latencyBars: [...state.latencyBars, bar].slice(-MAX_LATENCY_BARS),
      };
    }),

  updateLatencyBar: (label, updates) =>
    set((state) => ({
      latencyBars: state.latencyBars.map((b) =>
        b.label === label ? { ...b, ...updates } : b
      ),
    })),

  updateLatencyBarByEventId: (eventId, updates) =>
    set((state) => ({
      latencyBars: state.latencyBars.map((b) =>
        b.event_id === eventId ? { ...b, ...updates } : b
      ),
    })),

  updateLatencyBarItPoll: (eventId, itPollMs, confirmed, table) =>
    set((state) => ({
      latencyBars: state.latencyBars.map((b) =>
        b.event_id === eventId
          ? table === "book"
            ? { ...b, book_poll_ms: itPollMs, book_poll_confirmed: confirmed }
            : { ...b, it_poll_ms: itPollMs, it_poll_confirmed: confirmed }
          : b
      ),
    })),

  setBurstResult: (result) => set({ burstResult: result }),

  setWarehouseMode: (mode) => set({ warehouseMode: mode }),

  setDayMetrics: (metrics) => set({ dayMetrics: metrics }),

  setInitialLoadDone: () => set({ isInitialLoad: false }),

  setChannelMode: (mode) => set({ channelMode: mode }),

  setTimeTravelOffset: (offset) => set({ timeTravelOffset: offset }),

  setOptimisticEnabled: (enabled) => set({ optimisticEnabled: enabled }),

  addChartRenderTiming: (name, ms) =>
    set((state) => {
      // Just append; median is robust to the cold-mount outlier without
      // explicit filtering. Cap at 50 entries FIFO.
      const prev = state.chartRenderTimings[name] ?? [];
      const next = [...prev, ms].slice(-50);
      return {
        chartRenderTimings: { ...state.chartRenderTimings, [name]: next },
      };
    }),

  addFullPageRenderTiming: (ms) =>
    set((state) => {
      // Append every sample — first poll is a real "data → repaint" measurement
      // (Streamlit's first rerun is also a cold start, so apples-to-apples).
      // Cap at 50 entries FIFO.
      const next = [...state.fullPageRenderTimings, ms].slice(-50);
      return { fullPageRenderTimings: next };
    }),

  addWsDeliveryTiming: (ms) =>
    set((state) => {
      const next = [...state.wsDeliveryTimings, ms].slice(-50);
      return { wsDeliveryTimings: next };
    }),

  addScanDetectTiming: (ms) =>
    set((state) => {
      const next = [...state.scanDetectTimings, ms].slice(-50);
      return { scanDetectTimings: next };
    }),

  setItServed: (p50, best, last) =>
    set({ itServedP50Ms: p50, itServedBestMs: best, itServedLastMs: last }),

  setWsState: (s) => set({ wsState: s }),
  incrementWsMessageCount: () =>
    set((state) => ({ wsMessageCount: state.wsMessageCount + 1 })),
}));
