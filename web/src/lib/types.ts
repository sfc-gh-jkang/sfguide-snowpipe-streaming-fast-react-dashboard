// =============================================================================
// WebSocket Message Types — Cross-Lane Contract
// Lane B implements the server-side broadcasts matching these shapes.
// =============================================================================

// --- Shared primitives ---

export interface LatencyBreakdown {
  network_ms: number;
  sdk_appended_ms: number;
  flush_committed_ms: number;
  it_poll_ms: number;
  total_ms: number;
}

export interface Event {
  event_id: string;
  event_type: "TRADE" | "MARK" | "CREDIT_EVENT";
  position_id: string;
  issuer: string;
  sector: string;
  side?: string;
  qty?: number;
  price?: number;
  prev_mark?: number;
  new_mark?: number;
  from_rating?: string;
  to_rating?: string;
  counterparty?: string;
  partition: number;
  ingested_ts: string;
  latency_ms?: number;
  /** "pending" = optimistic (grey), "verified" = confirmed in IT */
  status: "pending" | "verified";
}

// --- WebSocket Messages (server → client) ---

export interface WsOptimisticMsg {
  type: "optimistic";
  event: Event;
  latency: Omit<LatencyBreakdown, "it_poll_ms" | "total_ms">;
}

export interface WsVerifiedMsg {
  type: "verified";
  event_id: string;
  /** Real HPA partition (from the VM response) — backfills the bar's partition,
   *  which was 0 at optimistic-broadcast time (VM hadn't responded yet). */
  partition?: number;
  latency: LatencyBreakdown & {
    /** Parallel POSITION_BOOK flush (concurrent with raw); null if skipped. */
    book_flush_committed_ms?: number | null;
    /** Full VM handler wall-clock, for deriving vm_overhead on WS-path bars. */
    total_handler_ms?: number;
  };
}

export interface WsTapeMsg {
  type: "tape";
  events: Event[];
  /**
   * Server-measured scan-detect latency in ms = (broker_emit_ts − max_ingested_ts_in_batch).
   * Captures the lag between an IT row landing and the polling reader noticing
   * + emitting the broadcast. ONLY set on tape messages (where we have access
   * to the row's INGESTED_TS); undefined on KPI/sector/topmarks where there
   * is no clear "row appearance" timestamp on the server side.
   */
  _scan_detect_ms?: number;
}

export interface WsKpiMsg {
  type: "kpi";
  total_pnl: number;
  position_count: number;
  gainers: number;
  losers: number;
  watchlist_count: number;
  it_lag_seconds: number;
}

export interface WsSectorMsg {
  type: "sector";
  rows: SectorRow[];
}

export interface WsTopMarksMsg {
  type: "topmarks";
  rows: TopMarkRow[];
}

export interface WsHpaStatusMsg {
  type: "hpa_status";
  channel_count: number;
  pipe_name: string;
  status: "healthy" | "degraded" | "unreachable";
}

/**
 * Sent AFTER the visibility probe resolves. Decoupled from the ingest response
 * so /api/ingest can return at wait_for_flush ack (~250 ms) instead of blocking
 * on visibility. The latency bar's it_poll_ms is updated post-hoc when this
 * arrives. `confirmed` distinguishes a real commit→queryable measurement
 * (found=true) from a give-up-after-budget elapsed value (found=false) — the
 * latter MUST NOT be treated as a confirmed visibility latency.
 */
export interface WsItVisibleMsg {
  type: "it_visible";
  event_id: string;
  it_poll_ms: number;
  confirmed: boolean;
  /** Which interactive table this probe targeted. */
  table: "raw" | "book";
}

export type WsMessage =
  | WsOptimisticMsg
  | WsVerifiedMsg
  | WsTapeMsg
  | WsKpiMsg
  | WsSectorMsg
  | WsTopMarksMsg
  | WsHpaStatusMsg
  | WsItVisibleMsg;

// --- Data model rows ---

export interface SectorRow {
  sector: string;
  total_par: number;
}

export interface TopMarkRow {
  issuer: string;
  sector: string;
  current_mark: number;
  mark_change_bps: number;
  pnl_today: number;
}

export interface WatchlistRow {
  position_id: string;
  issuer: string;
  rating: string;
  sector: string;
  par_amount: number;
  current_mark: number;
  pnl_today: number;
}

export interface HourlyTradeRow {
  hour: string;
  trade_count: number;
}

export interface IngestStats {
  event_count: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
}

export interface ObservabilityState {
  watchlist: WatchlistRow[];
  hourly_trades: HourlyTradeRow[];
  ingest_stats: IngestStats | null;
  throughput_evt_per_min: number;
  total_events_24h: number;
  it_lag_seconds: number;
}

// --- Latency timeline bar (rendered in Chart.js) ---

export interface LatencyBar {
  /** Stable label used as a fallback identifier for updates. */
  label: string;
  /** Server-assigned event_id used to correlate the async it_visible WS update. */
  event_id?: string;
  network_ms: number;
  sdk_appended_ms: number;
  /**
   * HPA flush-commit latency. Surfaced as MAX(raw_flush, book_flush) because the
   * RAW_EVENTS and POSITION_BOOK write-throughs run concurrently and BOTH must
   * commit for the "both tables fresh" state — max reflects the wall-clock of the
   * long pole, not the sum.
   */
  flush_committed_ms: number;
  /**
   * VM handler time not attributed to append/flush: request parse, in-memory book
   * recompute, book-concurrency excess, and response build. Makes
   * network+sdk+flush+vm_overhead sum to the real click→POST-done round-trip.
   */
  vm_overhead_ms: number;
  /** Filled in by WsItVisibleMsg AFTER /api/ingest returns. Starts at 0. */
  it_poll_ms: number;
  /**
   * true once the row was confirmed queryable in the IT. false = the probe gave
   * up after its budget (it_poll_ms is then a floor, not a confirmed latency).
   * undefined until the it_visible message lands.
   */
  it_poll_confirmed?: boolean;
  /** POSITION_BOOK commit→queryable latency (parallel pre-agg table). */
  book_poll_ms?: number;
  book_poll_confirmed?: boolean;
  /**
   * SPCS server handler + SPCS↔VM network/tunnel time (cross-cloud AWS→GCP via
   * cloudflared) NOT attributed to the VM = total_ms − network_ms(parse) −
   * total_handler_ms. Only meaningful on ws-source bars, where `network_ms` is
   * just the server request-parse (~0 ms); on client-source bars the real
   * browser→VM round-trip already includes this transport inside `network_ms`,
   * so it must NOT be added again there.
   */
  server_transport_ms?: number;
  render_ms: number;
  /** HPA channel partition the event routed to (for hot-partition/skew checks). */
  partition?: number;
  /**
   * "client" = measured by the browser that fired the event (accurate network +
   * render). "ws" = reconstructed from the WebSocket broadcast (server-side
   * network only, no render). Only client bars feed the precise per-segment
   * medians; ws bars still render in the timeline for the continuous stream.
   */
  source?: "client" | "ws";
}

// --- API Request/Response types ---

export interface IngestRequest {
  event_type: "TRADE" | "MARK" | "CREDIT_EVENT";
  position_id?: string;
  /**
   * Optional caller-provided EVENT_ID. The VM uses it as the row's EVENT_ID so
   * the optimistic WS bar, the `verified` backfill, and the `it_visible`
   * visibility probe all share ONE id (otherwise the ws bar never receives its
   * it_poll_ms and the live latency stays empty).
   */
  event_id?: string;
}

export interface IngestResponse {
  event_id: string;
  event_type: string;
  position_id: string;
  partition: number;
  /**
   * VM-stamped EVENT_TS (UTC "YYYY-MM-DD HH:MM:SS.ffffff"). Used by the server to
   * probe POSITION_BOOK visibility (BOOK_TS >= this) since the book table has no
   * EVENT_ID column.
   */
  event_ts?: string;
  /** VM request parse/enqueue time (ms) — the front of the VM handler. */
  vm_received_ms?: number;
  sdk_appended_ms: number;
  flush_committed_ms: number;
  /**
   * Flush time for the parallel POSITION_BOOK write-through (strategy-2 pre-agg
   * cache). null when the book write was skipped/failed (best-effort — the raw
   * RAW_EVENTS write is the system of record and always commits).
   */
  book_flush_committed_ms?: number | null;
  total_handler_ms: number;
  /**
   * SPCS-measured wall-clock from request received to this response (parse +
   * SPCS↔VM tunnel + VM handler), captured at HPA flush ack. The browser that
   * fired can compute its ingress hop as (client round-trip − server_total_ms).
   */
  server_total_ms?: number;
  /**
   * NOTE: it_poll_ms is intentionally NOT in the synchronous response.
   * The server returns at HPA flush ack (~250 ms) and emits the IT visibility
   * lag asynchronously via WsItVisibleMsg. This matches Streamlit's parent
   * fork (which also returns at flush ack, no visibility verification) so the
   * click-pipeline comparison is apples-to-apples.
   */
}

// --- Agent Chat SSE types ---

export interface AgentStreamEvent {
  type: "delta" | "status" | "metadata" | "error" | "done";
  text?: string;
  message?: string;
  metadata?: Record<string, unknown>;
}

// --- Store state ---

export interface KpiState {
  total_pnl: number;
  position_count: number;
  gainers: number;
  losers: number;
  watchlist_count: number;
  it_lag_seconds: number;
}

export interface HpaState {
  channel_count: number;
  pipe_name: string;
  status: "healthy" | "degraded" | "unreachable" | "unknown";
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

// --- Day metrics (cumulative today) ---

export interface DayMetrics {
  events_today: number;
  evt_per_sec_30s: number;
  peak_burst_per_sec: number;
  total_notional_today: number;
}

// --- Burst / Stress test result ---

export interface BurstResult {
  count: number;
  latencies_ms: number[];
  p50: number;
  p95: number;
  p99: number;
  max: number;
}
