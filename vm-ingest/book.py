"""Running per-position book — the strategy-2 write-through cache.

Pure in-memory logic with NO heavy imports (no FastAPI / OTel / Ingest SDK), so
it can be unit-tested on its own. `ingest_worker` imports these; on every event
it mutates BOOK and streams the resulting pre-computed line into POSITION_BOOK.

Semantics mirror the query-time `bookCte` in web/src/server/queries.ts EXACTLY,
so all three serving strategies agree:
  - CURRENT_MARK  tracks the latest MARK (falls back to the position's baseline)
  - RATING        tracks the latest CREDIT_EVENT (falls back to current rating)
  - TRADE events move NEITHER mark nor rating (they don't in bookCte either)
  - PNL_TODAY     = (CURRENT_MARK - OPENING_MARK) / 100 * PAR_AMOUNT
"""
from __future__ import annotations

import threading
from typing import Any

# BOOK[pos] = current pre-computed book line for each position.
BOOK: dict[str, dict[str, Any]] = {}
BOOK_LOCK = threading.Lock()


def init_book(positions: dict[str, dict[str, Any]]) -> None:
    """Seed BOOK from POSITIONS_DIM baselines (flat P&L, opening = baseline mark)."""
    with BOOK_LOCK:
        BOOK.clear()
        for pos, attrs in positions.items():
            baseline = attrs.get("BASELINE_MARK")
            BOOK[pos] = {
                "POSITION_ID": pos,
                "ISSUER": attrs.get("ISSUER"),
                "SECTOR": attrs.get("SECTOR"),
                "TRANCHE": attrs.get("TRANCHE"),
                "PAR_AMOUNT": attrs.get("PAR_AMOUNT"),
                "FUND": attrs.get("FUND"),
                "WATCHLIST": attrs.get("WATCHLIST"),
                "OPENING_MARK": baseline,
                "CURRENT_MARK": baseline,
                "RATING": attrs.get("CURRENT_RATING"),
            }


def apply_hydrated(pos: str, latest_mark: float | None, latest_rating: str | None) -> None:
    """Override a position's live state from RAW_EVENTS' current latest-per-position.

    Called at startup so a producer restart does NOT reset the day's book to flat:
    the running book is rebuilt from the marks/ratings already committed today.
    """
    with BOOK_LOCK:
        state = BOOK.get(pos)
        if state is None:
            return
        if latest_mark is not None:
            state["CURRENT_MARK"] = latest_mark
        if latest_rating:
            state["RATING"] = latest_rating


def update_book_state(row: dict) -> None:
    """Mutate BOOK[pos] from a raw event (MARK moves mark, CREDIT_EVENT moves rating)."""
    pos = row.get("POSITION_ID")
    if not pos:
        return
    with BOOK_LOCK:
        state = BOOK.get(pos)
        if state is None:
            return
        if row.get("EVENT_TYPE") == "MARK" and row.get("NEW_MARK") is not None:
            state["CURRENT_MARK"] = row["NEW_MARK"]
        elif row.get("EVENT_TYPE") == "CREDIT_EVENT" and row.get("TO_RATING"):
            state["RATING"] = row["TO_RATING"]


def book_row_for(pos: str, event_type: str | None, ts: str) -> dict[str, Any] | None:
    """Return the POSITION_BOOK row for the current state of BOOK[pos].

    PNL_TODAY / MARK_CHANGE_BPS are derived exactly as bookCte does. Returns None
    for unknown positions (no baseline to compute against).
    """
    with BOOK_LOCK:
        state = BOOK.get(pos)
        if state is None:
            return None
        opening = state.get("OPENING_MARK")
        mark = state.get("CURRENT_MARK")
        par = state.get("PAR_AMOUNT")
        mark_change_bps = (
            (mark - opening) * 100 if mark is not None and opening is not None else None
        )
        pnl_today = (
            (mark - opening) / 100.0 * par
            if mark is not None and opening is not None and par is not None
            else None
        )
        return {
            "POSITION_ID": pos,
            "BOOK_TS": ts,
            "LAST_EVENT_TYPE": event_type,
            "ISSUER": state.get("ISSUER"),
            "SECTOR": state.get("SECTOR"),
            "TRANCHE": state.get("TRANCHE"),
            "PAR_AMOUNT": par,
            "FUND": state.get("FUND"),
            "WATCHLIST": state.get("WATCHLIST"),
            "CURRENT_MARK": mark,
            "OPENING_MARK": opening,
            "MARK_CHANGE_BPS": mark_change_bps,
            "PNL_TODAY": pnl_today,
            "RATING": state.get("RATING"),
        }
