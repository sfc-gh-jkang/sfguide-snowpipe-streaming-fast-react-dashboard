"""Unit tests for the running per-position book (strategy-2 write-through logic).

These cover the exact invariants that keep serving strategy 2 (POSITION_BOOK)
in agreement with the query-time strategies (bookCte / MAX_BY) on RAW_EVENTS:
  - PnL formula parity, MARK moves the mark, CREDIT_EVENT moves the rating,
  - TRADE moves neither, restart hydration rebuilds live state from RAW_EVENTS,
  - unknown positions are ignored, book_row_for is a pure snapshot.

book.py is import-light (no FastAPI/OTel/Ingest SDK) so these run anywhere.
"""
import book


POSITIONS = {
    "POS-0001": {
        "ISSUER": "Apollo Health", "SECTOR": "Healthcare", "TRANCHE": "2L Term Loan",
        "PAR_AMOUNT": 1_000_000.0, "FUND": "ACME Special Sits", "WATCHLIST": False,
        "BASELINE_MARK": 100.0, "CURRENT_RATING": "CCC+",
    },
    "POS-0002": {
        "ISSUER": "Vista Medical", "SECTOR": "Healthcare", "TRANCHE": "1L Term Loan",
        "PAR_AMOUNT": 2_000_000.0, "FUND": "ACME Direct Lending II", "WATCHLIST": True,
        "BASELINE_MARK": 98.0, "CURRENT_RATING": "BB-",
    },
}


def setup_function(_):
    book.init_book(POSITIONS)


def test_init_book_is_flat_at_baseline():
    row = book.book_row_for("POS-0001", "SEED", "2026-07-08 00:00:00.0")
    assert row["CURRENT_MARK"] == 100.0
    assert row["OPENING_MARK"] == 100.0
    assert row["PNL_TODAY"] == 0.0
    assert row["MARK_CHANGE_BPS"] == 0.0
    assert row["RATING"] == "CCC+"
    # Denormalized attrs carried through.
    assert row["ISSUER"] == "Apollo Health"
    assert row["PAR_AMOUNT"] == 1_000_000.0


def test_mark_moves_mark_and_pnl_matches_bookcte_formula():
    book.update_book_state({"POSITION_ID": "POS-0001", "EVENT_TYPE": "MARK", "NEW_MARK": 101.5})
    row = book.book_row_for("POS-0001", "MARK", "2026-07-08 00:01:00.0")
    assert row["CURRENT_MARK"] == 101.5
    # PNL_TODAY = (mark - opening)/100 * par  == (101.5-100)/100 * 1e6 = 15,000
    assert row["PNL_TODAY"] == 15_000.0
    # MARK_CHANGE_BPS = (mark - opening) * 100 = 150
    assert row["MARK_CHANGE_BPS"] == 150.0


def test_negative_mark_gives_negative_pnl():
    book.update_book_state({"POSITION_ID": "POS-0002", "EVENT_TYPE": "MARK", "NEW_MARK": 96.0})
    row = book.book_row_for("POS-0002", "MARK", "t")
    # (96-98)/100 * 2e6 = -40,000
    assert row["PNL_TODAY"] == -40_000.0


def test_credit_event_moves_rating_not_mark():
    book.update_book_state({"POSITION_ID": "POS-0001", "EVENT_TYPE": "CREDIT_EVENT", "TO_RATING": "D"})
    row = book.book_row_for("POS-0001", "CREDIT_EVENT", "t")
    assert row["RATING"] == "D"
    assert row["CURRENT_MARK"] == 100.0  # unchanged
    assert row["PNL_TODAY"] == 0.0


def test_trade_moves_neither_mark_nor_rating():
    book.update_book_state(
        {"POSITION_ID": "POS-0001", "EVENT_TYPE": "TRADE", "SIDE": "BUY", "QTY": 100, "PRICE": 99.0}
    )
    row = book.book_row_for("POS-0001", "TRADE", "t")
    assert row["CURRENT_MARK"] == 100.0
    assert row["RATING"] == "CCC+"
    assert row["PNL_TODAY"] == 0.0


def test_latest_mark_wins_on_successive_marks():
    book.update_book_state({"POSITION_ID": "POS-0001", "EVENT_TYPE": "MARK", "NEW_MARK": 105.0})
    book.update_book_state({"POSITION_ID": "POS-0001", "EVENT_TYPE": "MARK", "NEW_MARK": 102.0})
    row = book.book_row_for("POS-0001", "MARK", "t")
    assert row["CURRENT_MARK"] == 102.0  # most recent, not the max


def test_hydrate_rebuilds_live_state_after_restart():
    # Simulate a restart: init flat, then hydrate from RAW_EVENTS' latest state.
    book.init_book(POSITIONS)
    book.apply_hydrated("POS-0001", latest_mark=103.25, latest_rating="B-")
    row = book.book_row_for("POS-0001", "SEED", "t")
    assert row["CURRENT_MARK"] == 103.25
    assert row["RATING"] == "B-"
    # (103.25-100)/100 * 1e6 = 32,500  -> book is NOT reset to flat on restart
    assert row["PNL_TODAY"] == 32_500.0


def test_hydrate_none_values_leave_baseline():
    book.init_book(POSITIONS)
    book.apply_hydrated("POS-0002", latest_mark=None, latest_rating=None)
    row = book.book_row_for("POS-0002", "SEED", "t")
    assert row["CURRENT_MARK"] == 98.0  # baseline preserved
    assert row["RATING"] == "BB-"


def test_unknown_position_is_ignored():
    assert book.book_row_for("POS-9999", "MARK", "t") is None
    # These must not raise for an unknown position.
    book.update_book_state({"POSITION_ID": "POS-9999", "EVENT_TYPE": "MARK", "NEW_MARK": 50.0})
    book.apply_hydrated("POS-9999", 50.0, "AAA")


def test_book_row_for_is_a_pure_snapshot():
    # Reading the row must not mutate state; two reads are identical.
    a = book.book_row_for("POS-0001", "SEED", "t1")
    b = book.book_row_for("POS-0001", "SEED", "t2")
    assert a["CURRENT_MARK"] == b["CURRENT_MARK"] == 100.0
    assert a["BOOK_TS"] == "t1" and b["BOOK_TS"] == "t2"
