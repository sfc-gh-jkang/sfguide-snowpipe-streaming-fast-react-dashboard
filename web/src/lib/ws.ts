"use client";

import { useEffect, useRef, useCallback } from "react";
import type { WsMessage } from "./types";
import { useDashboardStore } from "./store";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_CAP_MS = 30000;

/**
 * WebSocket client hook.
 * Connects to /api/ws, dispatches typed messages to Zustand store,
 * auto-reconnects with exponential backoff (1s → 30s cap),
 * dedupes on event_id for optimistic/verified messages.
 */
export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seenIdsRef = useRef<Set<string>>(new Set());

  const {
    addOptimisticEvent,
    verifyEvent,
    setTape,
    setKpi,
    setSector,
    setTopMarks,
    setHpaStatus,
    addLatencyBar,
    updateLatencyBarByEventId,
    updateLatencyBarItPoll,
  } = useDashboardStore();

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/api/ws`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      reconnectAttemptRef.current = 0;
      useDashboardStore.getState().setWsState("open");
    };

    ws.onmessage = (ev) => {
      const recvTs = Date.now();
      let msg: WsMessage & { _emit_ts?: number; _scan_detect_ms?: number };
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }

      // Bump the WS message counter (surfaced in the diagnostic strip as
      // `Nw=N` so we can confirm WS push delivery is working in production
      // without trusting the wire-latency banner alone).
      useDashboardStore.getState().incrementWsMessageCount();

      // Server-emit timestamp from ws-broker.broadcast(). Measure wire-delivery
      // latency on every message arriving over the WS connection. Powers the
      // LatencyComparison "push delivery" segment.
      if (typeof msg._emit_ts === "number") {
        const deliveryMs = recvTs - msg._emit_ts;
        if (deliveryMs >= 0 && deliveryMs < 30_000) {
          useDashboardStore.getState().addWsDeliveryTiming(deliveryMs);
        }
      }

      // Server-measured scan-detect latency, attached only to tape messages
      // by snowflake-reader.ts (max INGESTED_TS in batch → broker emit).
      // Replaces the prior hardcoded SCAN_AVG_MS=100 fudge factor.
      if (typeof msg._scan_detect_ms === "number") {
        const sd = msg._scan_detect_ms;
        if (sd >= 0 && sd <= 5000) {
          useDashboardStore.getState().addScanDetectTiming(sd);
        }
      }

      switch (msg.type) {
        case "optimistic": {
          const eid = msg.event.event_id;
          if (seenIdsRef.current.has(eid)) return;
          seenIdsRef.current.add(eid);
          // Cap the dedupe set at 200 entries
          if (seenIdsRef.current.size > 200) {
            const it = seenIdsRef.current.values();
            seenIdsRef.current.delete(it.next().value!);
          }
          addOptimisticEvent({ ...msg.event, status: "pending" });
          addLatencyBar({
            label: `#${Date.now()} ${msg.event.event_type.slice(0, 5)}`,
            event_id: eid,
            network_ms: msg.latency.network_ms,
            sdk_appended_ms: msg.latency.sdk_appended_ms,
            flush_committed_ms: msg.latency.flush_committed_ms,
            vm_overhead_ms: 0,
            it_poll_ms: 0,
            render_ms: 0,
            partition: msg.event.partition,
            source: "ws",
          });
          break;
        }
        case "verified": {
          // Verified fires at HPA flush ack; IT visibility arrives separately via
          // `it_visible`. Flip status AND backfill the real VM segments onto the
          // bar — critical for WS-path (MarketSimulator) bars that were created
          // with 0s at optimistic time. flush = max(raw, book) concurrency.
          seenIdsRef.current.add(msg.event_id);
          verifyEvent(msg.event_id);
          const L = msg.latency;
          const flush = Math.max(
            L.flush_committed_ms,
            L.book_flush_committed_ms ?? 0
          );
          const vmOverhead =
            L.total_handler_ms != null
              ? Math.max(0, L.total_handler_ms - L.sdk_appended_ms - flush)
              : 0;
          // SPCS handler + SPCS↔VM network/tunnel (cross-cloud) not attributed to
          // the VM. Computed from SERVER-side values, so it's correct regardless
          // of which bar it lands on; liveStats only ADDS it for ws bars (client
          // bars already fold this transport into their measured network_ms).
          const serverTransport =
            L.total_handler_ms != null
              ? Math.max(0, L.total_ms - L.network_ms - L.total_handler_ms)
              : 0;
          // Do NOT overwrite network_ms/render_ms: a client bar already has the
          // accurate values, and a ws bar's server-side network is all we have.
          updateLatencyBarByEventId(msg.event_id, {
            sdk_appended_ms: L.sdk_appended_ms,
            flush_committed_ms: flush,
            vm_overhead_ms: vmOverhead,
            server_transport_ms: serverTransport,
            // Backfill the REAL partition (optimistic bar had 0 before the VM responded).
            ...(msg.partition != null ? { partition: msg.partition } : {}),
          });
          break;
        }
        case "it_visible": {
          // Async update: real IT-poll lag arrived after /api/ingest returned.
          // `confirmed` false = probe gave up (it_poll_ms is a floor, not real).
          // `table` routes to the raw (RAW_EVENTS) or book (POSITION_BOOK) fields.
          updateLatencyBarItPoll(
            msg.event_id,
            msg.it_poll_ms,
            msg.confirmed,
            msg.table
          );
          break;
        }
        case "tape":
          setTape(msg.events);
          break;
        case "kpi":
          setKpi({
            total_pnl: msg.total_pnl,
            position_count: msg.position_count,
            gainers: msg.gainers,
            losers: msg.losers,
            watchlist_count: msg.watchlist_count,
            it_lag_seconds: msg.it_lag_seconds,
          });
          break;
        case "sector":
          setSector(msg.rows);
          break;
        case "topmarks":
          setTopMarks(msg.rows);
          break;
        case "hpa_status":
          setHpaStatus({
            channel_count: msg.channel_count,
            pipe_name: msg.pipe_name,
            status: msg.status,
          });
          break;
      }
    };

    ws.onclose = () => {
      wsRef.current = null;
      useDashboardStore.getState().setWsState("closed");
      scheduleReconnect();
    };

    ws.onerror = () => {
      useDashboardStore.getState().setWsState("error");
      ws.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scheduleReconnect = useCallback(() => {
    const attempt = reconnectAttemptRef.current;
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, attempt),
      RECONNECT_CAP_MS
    );
    reconnectAttemptRef.current = attempt + 1;
    reconnectTimerRef.current = setTimeout(() => {
      connect();
    }, delay);
  }, [connect]);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) wsRef.current.close();
    };
  }, [connect]);

  return wsRef;
}
