"use client";

import React from "react";
import { useDashboardStore } from "@/lib/store";
import { SkeletonCard } from "./SkeletonCard";

interface TileProps {
  label: string;
  value: string;
  delta?: string;
}

const Tile = React.memo(function Tile({ label, value, delta }: TileProps) {
  return (
    <div className="kpi-tile" data-testid={`kpi-tile-${label}`}>
      <div className="kpi-tile-label">{label}</div>
      <div className="kpi-tile-value">{value}</div>
      {delta && (
        <div className="kpi-tile-delta text-slate-400">{delta}</div>
      )}
    </div>
  );
});

export function KpiTiles() {
  const kpi = useDashboardStore((s) => s.kpi);
  const isInitialLoad = useDashboardStore((s) => s.isInitialLoad);

  if (isInitialLoad && kpi.position_count === 0) {
    return (
      <div className="grid grid-cols-4 gap-3">
        <SkeletonCard height="72px" />
        <SkeletonCard height="72px" />
        <SkeletonCard height="72px" />
        <SkeletonCard height="72px" />
      </div>
    );
  }

  return (
    <div className="grid grid-cols-4 gap-3">
      <Tile
        label="Today's P&L"
        value={`$${kpi.total_pnl.toLocaleString("en-US", { maximumFractionDigits: 0 })}`}
        delta={`${kpi.gainers}G ${kpi.losers}L`}
      />
      <Tile label="Positions" value={kpi.position_count.toString()} />
      <Tile label="Watchlist" value={kpi.watchlist_count.toString()} />
      <Tile
        label="IT Lag"
        value={`${kpi.it_lag_seconds}s`}
        delta="Interactive Table refresh"
      />
    </div>
  );
}
