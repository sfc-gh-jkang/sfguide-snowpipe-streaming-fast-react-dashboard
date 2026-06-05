/**
 * @jest-environment jsdom
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { LiveTape } from "@/components/LiveTape";
import { useDashboardStore } from "@/lib/store";
import type { Event } from "@/lib/types";

// Reset store between tests
beforeEach(() => {
  useDashboardStore.setState({
    tape: [],
    kpi: { total_pnl: 0, position_count: 0, gainers: 0, losers: 0, watchlist_count: 0, it_lag_seconds: 0 },
    sector: [],
    topmarks: [],
    hpaStatus: { channel_count: 0, pipe_name: "", status: "unknown" },
    latencyBars: [],
    // Lane B added isInitialLoad — default true would render skeletons, not the
    // empty-state text. Treat tests as "loaded but empty" by default.
    isInitialLoad: false,
  });
});

const makeEvent = (overrides: Partial<Event> = {}): Event => ({
  event_id: "evt-001",
  event_type: "TRADE",
  position_id: "pos-abc",
  issuer: "Cascade Corp",
  sector: "Industrials",
  partition: 2,
  ingested_ts: "2026-05-18T12:00:00Z",
  status: "pending",
  ...overrides,
});

describe("LiveTape", () => {
  it("shows empty state when no events", () => {
    render(<LiveTape />);
    expect(screen.getByText(/no events yet/i)).toBeInTheDocument();
  });

  it("renders an optimistic (pending) row then swaps to verified", () => {
    const event = makeEvent({ event_id: "evt-swap-test", status: "pending" });

    // Add optimistic event
    useDashboardStore.getState().addOptimisticEvent(event);
    const { rerender } = render(<LiveTape />);

    // Should show pending row
    const row = screen.getByTestId("tape-row-evt-swap-test");
    expect(row).toHaveAttribute("data-status", "pending");

    // Verify it
    useDashboardStore.getState().verifyEvent("evt-swap-test");
    rerender(<LiveTape />);

    // Should now be verified — exactly one row, status swapped
    const verifiedRow = screen.getByTestId("tape-row-evt-swap-test");
    expect(verifiedRow).toHaveAttribute("data-status", "verified");

    // Should still be only one row (deduped)
    const allRows = screen.getAllByTestId(/^tape-row-/);
    expect(allRows).toHaveLength(1);
  });

  it("deduplicates events by event_id", () => {
    const store = useDashboardStore.getState();
    const event = makeEvent({ event_id: "evt-dup" });

    store.addOptimisticEvent(event);
    store.addOptimisticEvent(event); // duplicate

    render(<LiveTape />);
    const rows = screen.getAllByTestId(/^tape-row-/);
    expect(rows).toHaveLength(1);
  });
});
