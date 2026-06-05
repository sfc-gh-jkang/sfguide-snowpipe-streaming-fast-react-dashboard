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
  latency: LatencyBreakdown;
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
 * Sent AFTER the row is queryable in the Interactive Table.
 * Decoupled from the ingest response so /api/ingest can return at
 * wait_for_flush ack (~250 ms) instead of blocking on visibility (~1.8 s).
 * The latency bar's it_poll_ms is updated post-hoc when this arrives.
 */
export interface WsItVisibleMsg {
  type: "it_visible";
  event_id: string;
  it_poll_ms: number;
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
  flush_committed_ms: number;
  /** Filled in by WsItVisibleMsg AFTER /api/ingest returns. Starts at 0. */
  it_poll_ms: number;
  render_ms: number;
}

// --- API Request/Response types ---

export interface IngestRequest {
  event_type: "TRADE" | "MARK" | "CREDIT_EVENT";
  position_id?: string;
}

export interface IngestResponse {
  event_id: string;
  event_type: string;
  position_id: string;
  partition: number;
  sdk_appended_ms: number;
  flush_committed_ms: number;
  total_handler_ms: number;
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
