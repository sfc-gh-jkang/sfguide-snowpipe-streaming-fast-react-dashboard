"""ACME Credit Demo — Snowpipe Streaming HPA ingest worker.

FastAPI app that receives trade/mark/credit events via POST /ingest
and streams them into SNOWFLAKE_EXAMPLE.CREDIT_DEMO.RAW_EVENTS
using the production StreamingService (partitioned, self-healing channels).
"""
from __future__ import annotations

import json
import logging
import os
import random
import threading
import time
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Request
from pydantic import BaseModel, Field

from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource

from streaming_service import StreamingService
import book

# ---------------------------------------------------------------------------
# Config from env
# ---------------------------------------------------------------------------
SF_ACCOUNT = os.environ.get("SNOWFLAKE_ACCOUNT", "<your-snowflake-account>")
SF_USER = os.environ.get("SNOWFLAKE_USER", "CREDIT_INGEST_USR")
SF_ROLE = os.environ.get("SNOWFLAKE_ROLE", "CREDIT_INGEST_RL")
SF_DB = os.environ.get("SNOWFLAKE_DATABASE", "SNOWFLAKE_EXAMPLE")
SF_SCHEMA = os.environ.get("SNOWFLAKE_SCHEMA", "CREDIT_DEMO")
SF_TABLE = os.environ.get("SNOWFLAKE_TABLE", "RAW_EVENTS")
# Strategy-2 pre-agg write-through target (second interactive table). The producer
# maintains a running per-position book and streams the pre-computed book line here
# in parallel with the raw event — see BOOK / _book_row / write-through in ingest().
SF_BOOK_TABLE = os.environ.get("SNOWFLAKE_BOOK_TABLE", "POSITION_BOOK")
SF_KEY_PATH = os.environ.get("SNOWFLAKE_PRIVATE_KEY_PATH", "/etc/credit/keys/credit_ingest.p8")
API_KEY = os.environ.get("INGEST_API_KEY", "")
PARTITION_COUNT = int(os.environ.get("PARTITION_COUNT", "4"))
# Self-healing: cloudflared exposes its live quick-tunnel hostname at
# ${TUNNEL_METRICS_URL}/quicktunnel. When set (quick-tunnel profile), the
# producer registers the current host into APP_CONFIG whenever it rotates, so
# the dashboard self-heals with zero operator action. Unset/unreachable (named
# tunnel or host-mode cloudflared) → registration is skipped.
TUNNEL_METRICS_URL = os.environ.get("TUNNEL_METRICS_URL", "").rstrip("/")
SELF_HEAL_INTERVAL_S = int(os.environ.get("SELF_HEAL_INTERVAL_S", "15"))

# Reference position IDs (POS-0001 through POS-0062)
POSITION_IDS = [f"POS-{i:04d}" for i in range(1, 63)]
COUNTERPARTIES = ["GS", "JPM", "MS", "BAML", "CITI", "DB", "UBS", "CS", "HSBC", "BNP"]
AGENCIES = ["SP", "MOODY", "FITCH"]
RATINGS = ["AAA", "AA+", "AA", "AA-", "A+", "A", "A-", "BBB+", "BBB", "BBB-", "BB+", "BB"]
MARK_SOURCES = ["BLOOMBERG", "REUTERS", "ICE", "INTERNAL", "MARKIT"]

# Denormalized POSITIONS_DIM attributes, keyed by POSITION_ID. Loaded once at
# startup (load_positions) so every streamed event can carry the position's
# static attributes. This is what lets the dashboard serve tiles directly from
# the RAW_EVENTS interactive table with no POSITIONS_DIM join — an Interactive
# Warehouse can only join interactive tables, so we denormalize instead.
# Attribute columns stamped onto each event:
POSITION_ATTR_COLS = (
    "ISSUER", "SECTOR", "TRANCHE", "PAR_AMOUNT",
    "FUND", "WATCHLIST", "BASELINE_MARK", "CURRENT_RATING",
)
POSITIONS: dict[str, dict[str, Any]] = {}

# ---------------------------------------------------------------------------
# Running per-position book (strategy-2 write-through cache)
# ---------------------------------------------------------------------------
# The pre-computed book line for each position lives in book.BOOK. On every
# event we mutate it (book.update_book_state) and stream the resulting
# fully-combined row (book.book_row_for) into POSITION_BOOK. Reads of that
# interactive table are then a cheap latest-per-position scan of pre-aggregated
# rows — the "replaces Redis" hot cache, kept fresh at write time (no refresh lag).
# The pure book logic lives in book.py so it can be unit-tested without the
# FastAPI / OTel / Ingest-SDK stack.

# Two blocking wait_for_flush calls per event (raw + book) run concurrently here
# so per-click latency is ~max(raw, book), not the sum.
_WRITE_POOL = ThreadPoolExecutor(max_workers=8, thread_name_prefix="hpa-write")


def _hydrate_book_from_raw_events() -> set[str]:
    """Rebuild the running book from RAW_EVENTS' current latest-per-position state.

    Run at startup so a producer restart does NOT reset the day's P&L to flat: the
    book is seeded from baselines (book.init_book) and then hydrated here with the
    latest MARK / latest CREDIT_EVENT already committed today. Returns the set of
    POSITION_IDs that have ANY event in the last 24h — the caller seeds baseline
    MARKs into RAW_EVENTS ONLY for the positions NOT in this set, so live marks are
    never clobbered. On failure, returns an empty set (caller falls back to seeding
    every position, i.e. the old behavior).
    """
    recent: set[str] = set()
    try:
        import snowflake.connector

        conn = snowflake.connector.connect(
            account=SF_ACCOUNT, user=SF_USER, private_key_file=SF_KEY_PATH,
            role=SF_ROLE, database=SF_DB, schema=SF_SCHEMA,
        )
        try:
            cur = conn.cursor()
            cur.execute(
                f"""
                SELECT POSITION_ID,
                    MAX_BY(CASE WHEN EVENT_TYPE = 'MARK' THEN NEW_MARK END,
                           CASE WHEN EVENT_TYPE = 'MARK' THEN EVENT_TS END)         AS LATEST_MARK,
                    MAX_BY(CASE WHEN EVENT_TYPE = 'CREDIT_EVENT' THEN TO_RATING END,
                           CASE WHEN EVENT_TYPE = 'CREDIT_EVENT' THEN EVENT_TS END) AS LATEST_RATING
                FROM {SF_DB}.{SF_SCHEMA}.{SF_TABLE}
                WHERE EVENT_TS >= DATEADD('hour', -24, SYSDATE())
                GROUP BY POSITION_ID
                """
            )
            for pos, latest_mark, latest_rating in cur.fetchall():
                recent.add(pos)
                book.apply_hydrated(
                    pos,
                    float(latest_mark) if latest_mark is not None else None,
                    latest_rating,
                )
        finally:
            conn.close()
        log.info("Hydrated running book from RAW_EVENTS: %d positions with recent events", len(recent))
    except Exception:
        log.exception("Failed to hydrate book from RAW_EVENTS — will seed all positions (flat)")
    return recent


def load_positions() -> int:
    """Load POSITIONS_DIM into the in-memory POSITIONS map via a keypair session.

    The HPA SDK can only append rows, not SELECT, so we use a short-lived
    snowflake.connector session (same RSA key as the streamer) to read the
    dimension once at startup. On failure we log and continue with an empty map;
    events then stream without denormalized attributes (tiles degrade to NULLs)
    rather than crashing the producer.
    """
    global POSITIONS, POSITION_IDS
    try:
        import snowflake.connector

        conn = snowflake.connector.connect(
            account=SF_ACCOUNT,
            user=SF_USER,
            private_key_file=SF_KEY_PATH,
            role=SF_ROLE,
            database=SF_DB,
            schema=SF_SCHEMA,
        )
        try:
            cur = conn.cursor()
            cur.execute(
                f"SELECT POSITION_ID, ISSUER, SECTOR, TRANCHE, PAR_AMOUNT, "
                f"FUND, WATCHLIST, BASELINE_MARK, CURRENT_RATING "
                f"FROM {SF_DB}.{SF_SCHEMA}.POSITIONS_DIM"
            )
            loaded: dict[str, dict[str, Any]] = {}
            for r in cur.fetchall():
                loaded[r[0]] = {
                    "ISSUER": r[1],
                    "SECTOR": r[2],
                    "TRANCHE": r[3],
                    "PAR_AMOUNT": float(r[4]) if r[4] is not None else None,
                    "FUND": r[5],
                    "WATCHLIST": bool(r[6]) if r[6] is not None else None,
                    "BASELINE_MARK": float(r[7]) if r[7] is not None else None,
                    "CURRENT_RATING": r[8],
                }
            POSITIONS = loaded
        finally:
            conn.close()
        # Keep POSITION_IDS in sync with what actually exists in the dimension.
        if POSITIONS:
            POSITION_IDS = sorted(POSITIONS.keys())
        log.info("Loaded %d positions from POSITIONS_DIM for denormalization", len(POSITIONS))
    except Exception:
        log.exception("Failed to load POSITIONS_DIM — events will stream without denormalized attrs")
    return len(POSITIONS)

log = logging.getLogger("credit-ingest")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

# ---------------------------------------------------------------------------
# OTel setup
# ---------------------------------------------------------------------------
resource = Resource.create({
    "service.name": os.environ.get("OTEL_SERVICE_NAME", "credit-ingest"),
    "deployment.environment.name": "gcp-vm",
})
provider = TracerProvider(resource=resource)
# Only wire the OTLP exporter when an endpoint is EXPLICITLY configured. The old
# default (http://localhost:4318) shipped every span to a dead endpoint on the
# VM (no collector runs there), so BatchSpanProcessor silently dropped them —
# telemetry theater. Set OTEL_EXPORTER_OTLP_ENDPOINT to a real collector to
# enable export; otherwise spans stay in-process (no false "we have tracing").
otlp_endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT")
if otlp_endpoint:
    provider.add_span_processor(
        BatchSpanProcessor(OTLPSpanExporter(endpoint=f"{otlp_endpoint}/v1/traces"))
    )
    log.info("OTel spans exporting to %s/v1/traces", otlp_endpoint)
else:
    log.info("OTel export disabled (set OTEL_EXPORTER_OTLP_ENDPOINT to enable)")
trace.set_tracer_provider(provider)
tracer = trace.get_tracer("credit-ingest")

# ---------------------------------------------------------------------------
# StreamingService instance (initialized in lifespan)
# ---------------------------------------------------------------------------
service = StreamingService(
    account=SF_ACCOUNT,
    user=SF_USER,
    private_key_path=SF_KEY_PATH,
    database=SF_DB,
    schema=SF_SCHEMA,
    table=SF_TABLE,
    role=SF_ROLE,
    partition_count=PARTITION_COUNT,
    instance_id="credit-vm",
)

# Second service → POSITION_BOOK (strategy-2 pre-agg write-through). Its own client
# + channels (auto-pipe POSITION_BOOK-STREAMING), so raw and book writes go over
# independent HPA channels and can be flushed in parallel.
book_service = StreamingService(
    account=SF_ACCOUNT,
    user=SF_USER,
    private_key_path=SF_KEY_PATH,
    database=SF_DB,
    schema=SF_SCHEMA,
    table=SF_BOOK_TABLE,
    role=SF_ROLE,
    partition_count=PARTITION_COUNT,
    instance_id="credit-book",
)


def _write_through(raw_row: dict, partition_key: str) -> dict:
    """Stream the raw event AND the recomputed book line in parallel.

    Updates the in-memory running book from the raw event, then streams
    raw→RAW_EVENTS and book→POSITION_BOOK concurrently (two blocking
    wait_for_flush calls run in the write pool), so per-click latency is
    ~max(raw, book) rather than the sum. Returns the raw stream result with the
    book flush time added as `book_flush_committed_ms`. The book write is
    best-effort: a failure there is logged but never fails the request (the raw
    event — the system of record — still committed).
    """
    book.update_book_state(raw_row)
    book_row = book.book_row_for(partition_key, raw_row.get("EVENT_TYPE"), raw_row["EVENT_TS"])

    raw_fut = _WRITE_POOL.submit(
        service.stream_row, raw_row, partition_key=partition_key, offset_token=raw_row["EVENT_ID"]
    )
    book_fut = None
    if book_row is not None and book_service.channels:
        book_fut = _WRITE_POOL.submit(
            book_service.stream_row,
            book_row,
            partition_key=partition_key,
            offset_token=raw_row["EVENT_ID"],
        )

    result = raw_fut.result()  # raises on raw failure (system of record)
    if book_fut is not None:
        try:
            book_res = book_fut.result()
            result["book_flush_committed_ms"] = book_res.get("flush_committed_ms", 0)
        except Exception:
            log.warning("POSITION_BOOK write-through failed (non-fatal)", exc_info=True)
            result["book_flush_committed_ms"] = None
    else:
        result["book_flush_committed_ms"] = None
    return result


# ---------------------------------------------------------------------------
# Self-healing daemon: keep APP_CONFIG pointed at the live tunnel host, and
# re-open streaming channels if a failed startup init left them empty.
# ---------------------------------------------------------------------------
def _current_tunnel_host() -> str | None:
    """Live quick-tunnel hostname from cloudflared's /quicktunnel metrics
    endpoint. None if TUNNEL_METRICS_URL is unset/unreachable (named tunnel or
    host-mode cloudflared) — caller then skips registration."""
    if not TUNNEL_METRICS_URL:
        return None
    try:
        with urllib.request.urlopen(f"{TUNNEL_METRICS_URL}/quicktunnel", timeout=5) as r:
            host = (json.loads(r.read().decode()).get("hostname") or "").strip()
        return host or None
    except Exception:
        return None


def _register_tunnel_host(host: str) -> None:
    """Publish the tunnel host into APP_CONFIG + the egress rule via the
    least-privilege owner's-rights proc (short-lived keypair session)."""
    import snowflake.connector

    conn = snowflake.connector.connect(
        account=SF_ACCOUNT, user=SF_USER, private_key_file=SF_KEY_PATH,
        role=SF_ROLE, database=SF_DB, schema=SF_SCHEMA,
    )
    try:
        conn.cursor().execute(
            f"CALL {SF_DB}.{SF_SCHEMA}.SP_SET_INGEST_HOST(%s)", (host,)
        )
    finally:
        conn.close()


def _self_heal_loop() -> None:
    """Daemon: (1) register a rotated quick-tunnel URL into APP_CONFIG so the
    dashboard self-heals with no operator action; (2) re-open channels if a
    startup init left them empty (channel_count == 0)."""
    last_host: str | None = None
    while True:
        try:
            host = _current_tunnel_host()
            if host and host != last_host:
                _register_tunnel_host(host)
                last_host = host
                log.info("Self-heal: registered tunnel host %s", host)
        except Exception:
            log.warning("Self-heal: tunnel registration failed (will retry)", exc_info=True)
        try:
            if service.get_status().get("channel_count", 0) == 0:
                log.warning("Self-heal: RAW_EVENTS channels down — re-initializing")
                service.initialize()
            if book_service.get_status().get("channel_count", 0) == 0:
                log.warning("Self-heal: POSITION_BOOK channels down — re-initializing")
                book_service.initialize()
        except Exception:
            log.warning("Self-heal: channel re-init failed (will retry)", exc_info=True)
        time.sleep(SELF_HEAL_INTERVAL_S)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize StreamingService on startup, fire warmup events, shut down on stop."""
    log.info(
        "Initializing StreamingService → %s.%s.%s (%d partitions)",
        SF_DB, SF_SCHEMA, SF_TABLE, PARTITION_COUNT,
    )
    try:
        service.initialize()
        book_service.initialize()
        log.info("StreamingService ready (RAW_EVENTS + POSITION_BOOK channels open)")

        # Load the dimension so streamed events can carry denormalized attributes.
        load_positions()
        # Seed the in-memory running book from baselines, then HYDRATE it from the
        # marks/ratings already committed in RAW_EVENTS today. This is the restart
        # fix: without hydration, a producer restart would reset every position to
        # flat P&L. `recent` = positions that already have an event in the last 24h.
        book.init_book(POSITIONS)
        recent = _hydrate_book_from_raw_events()

        # Ensure the full 62-position book is visible in BOTH interactive tables:
        #   • POSITION_BOOK — stream the (hydrated) book row for EVERY position, so
        #     strategy 2 reflects the real current state immediately after restart.
        #   • RAW_EVENTS — only seed a baseline MARK for positions with NO recent
        #     event (`pos not in recent`); seeding a position that already has live
        #     marks would clobber them (the seed's EVENT_TS=now becomes the latest).
        # Baseline seeds use SOURCE_APP='seed' so the live tape filters them out.
        seeded_raw = 0
        booked = 0
        seed_positions = POSITION_IDS or ["POS-0001"]
        for pos in seed_positions:
            now = datetime.now(timezone.utc)
            ts = now.strftime("%Y-%m-%d %H:%M:%S.%f")
            try:
                # Always publish the current book row to POSITION_BOOK.
                if book_service.channels:
                    brow = book.book_row_for(pos, "SEED", ts)
                    if brow is not None:
                        book_service.stream_row(brow, partition_key=pos, offset_token=str(uuid.uuid4()))
                        booked += 1
                # Only seed RAW_EVENTS for positions with no live event (avoid clobber).
                if pos not in recent:
                    attrs = POSITIONS.get(pos, {})
                    baseline = attrs.get("BASELINE_MARK")
                    seed_row = {
                        "EVENT_ID": str(uuid.uuid4()),
                        "EVENT_TS": ts,
                        "EVENT_TYPE": "MARK",
                        "POSITION_ID": pos,
                        "PREV_MARK": baseline,
                        "NEW_MARK": baseline,
                        "MARK_SOURCE": "SEED",
                        "SOURCE_APP": "seed",
                        "INGESTED_TS": ts,
                    }
                    _stamp_position_attrs(seed_row)
                    service.stream_row(seed_row, partition_key=pos, offset_token=seed_row["EVENT_ID"])
                    seeded_raw += 1
            except Exception:
                log.warning("Startup seed for %s failed (non-fatal)", pos, exc_info=True)
        log.info(
            "Startup seed complete: %d RAW_EVENTS baselines (missing positions), %d POSITION_BOOK rows, %d positions already live",
            seeded_raw, booked, len(recent),
        )
    except Exception:
        log.exception("Failed to initialize StreamingService")
    # Start the self-healing daemon unconditionally — even if init failed above,
    # its channel watchdog will retry initialize(), and it registers the live
    # tunnel host so the dashboard self-heals a rotated quick-tunnel URL.
    threading.Thread(target=_self_heal_loop, name="self-heal", daemon=True).start()
    log.info("Self-heal daemon started (tunnel-host registration + channel watchdog, every %ds)", SELF_HEAL_INTERVAL_S)
    yield
    log.info("Shutting down StreamingService")
    service.shutdown()
    book_service.shutdown()


app = FastAPI(title="ACME Ingest", lifespan=lifespan)


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class IngestRequest(BaseModel):
    event_type: str = Field(..., pattern="^(TRADE|MARK|CREDIT_EVENT)$")
    position_id: str | None = None
    # Optional caller-provided EVENT_ID. When present it becomes the row's
    # EVENT_ID so the client that fired the event can correlate its optimistic
    # bar with the async visibility backfill. Falls back to a fresh uuid.
    event_id: str | None = None
    side: str | None = None
    qty: float | None = None
    price: float | None = None
    counterparty: str | None = None
    prev_mark: float | None = None
    new_mark: float | None = None
    mark_source: str | None = None
    from_rating: str | None = None
    to_rating: str | None = None
    agency: str | None = None
    payload: dict | None = None


def _fill_defaults(req: IngestRequest) -> dict:
    """Generate realistic random fields for any omitted optional values."""
    pos = req.position_id or random.choice(POSITION_IDS)
    now = datetime.now(timezone.utc)
    event_id = req.event_id or str(uuid.uuid4())

    row: dict[str, Any] = {
        "EVENT_ID": event_id,
        "EVENT_TS": now.strftime("%Y-%m-%d %H:%M:%S.%f"),
        "EVENT_TYPE": req.event_type,
        "POSITION_ID": pos,
        "SOURCE_APP": "vm-hpa",
        "INGESTED_TS": now.strftime("%Y-%m-%d %H:%M:%S.%f"),
    }

    if req.event_type == "TRADE":
        row["SIDE"] = req.side or random.choice(["BUY", "SELL"])
        row["QTY"] = req.qty if req.qty is not None else round(random.uniform(100, 50000), 2)
        row["PRICE"] = req.price if req.price is not None else round(random.uniform(80, 120), 4)
        row["COUNTERPARTY"] = req.counterparty or random.choice(COUNTERPARTIES)
    elif req.event_type == "MARK":
        prev = req.prev_mark if req.prev_mark is not None else round(random.uniform(90, 110), 4)
        delta = round(random.uniform(-2, 2), 4)
        row["PREV_MARK"] = prev
        row["NEW_MARK"] = req.new_mark if req.new_mark is not None else round(prev + delta, 4)
        row["MARK_SOURCE"] = req.mark_source or random.choice(MARK_SOURCES)
    elif req.event_type == "CREDIT_EVENT":
        idx = random.randint(0, len(RATINGS) - 2)
        row["FROM_RATING"] = req.from_rating or RATINGS[idx]
        row["TO_RATING"] = req.to_rating or RATINGS[idx + 1]
        row["AGENCY"] = req.agency or random.choice(AGENCIES)

    if req.payload:
        row["PAYLOAD"] = json.dumps(req.payload)

    _stamp_position_attrs(row)
    return row


def _stamp_position_attrs(row: dict) -> None:
    """Denormalize the position's static attributes onto the event row.

    Looks up POSITION_ID in the in-memory POSITIONS map (loaded from
    POSITIONS_DIM at startup) and copies ISSUER/SECTOR/TRANCHE/PAR_AMOUNT/
    FUND/WATCHLIST/BASELINE_MARK/CURRENT_RATING onto the row. Without this the
    dashboard tiles (which read RAW_EVENTS directly, no dimension join) would
    show NULL issuer/sector/PnL. If the position is unknown, leaves them unset.
    """
    attrs = POSITIONS.get(row.get("POSITION_ID"))
    if not attrs:
        return
    for col in POSITION_ATTR_COLS:
        row[col] = attrs.get(col)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.get("/health")
async def health():
    status = service.get_status()
    book_status = book_service.get_status()
    # Healthy only if BOTH the raw and the POSITION_BOOK write-through channels are up.
    both_up = status["channel_count"] > 0 and book_status["channel_count"] > 0
    return {
        "status": "ok" if both_up else "degraded",
        **status,
        "book_channel_count": book_status["channel_count"],
        "book_target": book_status["target"],
    }


@app.post("/ingest")
async def ingest(req: IngestRequest, request: Request, x_api_key: str | None = Header(None)):
    if API_KEY and x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid or missing X-API-Key header")

    if not service.channels:
        raise HTTPException(status_code=503, detail="StreamingService not initialized")

    with tracer.start_as_current_span("ingest_event") as span:
        t0 = time.monotonic()
        row = _fill_defaults(req)
        partition_key = row["POSITION_ID"]
        vm_received_ms = round((time.monotonic() - t0) * 1000, 2)

        span.set_attribute("event.type", row["EVENT_TYPE"])
        span.set_attribute("event.position_id", partition_key)
        span.set_attribute("event.id", row["EVENT_ID"])
        span.set_attribute("partition.key", partition_key)
        span.set_attribute("partition.index", service._hash_to_partition(partition_key))

        try:
            result = _write_through(row, partition_key=partition_key)
        except Exception as exc:
            span.set_attribute("error", True)
            span.set_attribute("error.message", str(exc))
            log.exception("stream_row failed")
            raise HTTPException(status_code=500, detail=f"Ingest failed: {exc}") from exc

        total_handler_ms = round((time.monotonic() - t0) * 1000, 2)
        span.set_attribute("ingest.latency_ms", total_handler_ms)
        span.set_attribute("ingest.flush_ms", result.get("flush_committed_ms", 0))

        return {
            "event_id": row["EVENT_ID"],
            "offset_token": row["EVENT_ID"],
            "partition": result["partition"],
            "position_id": partition_key,
            "event_type": row["EVENT_TYPE"],
            # EVENT_TS (== BOOK_TS written to POSITION_BOOK) lets the server probe
            # POSITION_BOOK visibility (BOOK_TS >= this) since it has no EVENT_ID.
            "event_ts": row["EVENT_TS"],
            "vm_received_ms": vm_received_ms,
            "sdk_appended_ms": result["sdk_appended_ms"],
            "flush_committed_ms": result["flush_committed_ms"],
            "book_flush_committed_ms": result.get("book_flush_committed_ms"),
            "total_handler_ms": total_handler_ms,
        }


@app.post("/ingest/batch")
async def ingest_batch(request: Request, x_api_key: str | None = Header(None)):
    """Accept a JSON array of events for bulk ingest."""
    if API_KEY and x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid or missing X-API-Key header")
    if not service.channels:
        raise HTTPException(status_code=503, detail="StreamingService not initialized")

    body = await request.json()
    if not isinstance(body, list):
        raise HTTPException(status_code=400, detail="Body must be a JSON array of events")

    with tracer.start_as_current_span("ingest_batch") as span:
        t0 = time.monotonic()
        rows = []
        for item in body:
            req = IngestRequest(**item)
            rows.append(_fill_defaults(req))

        span.set_attribute("batch.size", len(rows))

        # Group by position_id for per-position ordering within each partition
        by_partition: dict[str, list[dict]] = {}
        for r in rows:
            by_partition.setdefault(r["POSITION_ID"], []).append(r)

        ingested = 0
        for pos_id, pos_rows in by_partition.items():
            last_id = pos_rows[-1]["EVENT_ID"]
            try:
                ingested += service.stream_batch(
                    pos_rows, partition_key=pos_id, offset_token=last_id
                )
                # Keep POSITION_BOOK consistent: apply every row in order to the
                # running book, then stream ONE final book row per position (the
                # post-burst state). Best-effort — never fails the batch.
                if book_service.channels:
                    for r in pos_rows:
                        book.update_book_state(r)
                    book_row = book.book_row_for(pos_id, pos_rows[-1]["EVENT_TYPE"], pos_rows[-1]["EVENT_TS"])
                    if book_row is not None:
                        try:
                            book_service.stream_batch([book_row], partition_key=pos_id, offset_token=last_id)
                        except Exception:
                            log.warning("POSITION_BOOK batch write-through failed for %s (non-fatal)", pos_id, exc_info=True)
            except Exception as exc:
                span.set_attribute("error", True)
                log.exception("stream_batch failed for position %s", pos_id)
                raise HTTPException(
                    status_code=500, detail=f"Batch ingest failed: {exc}"
                ) from exc

        elapsed_ms = round((time.monotonic() - t0) * 1000, 2)
        return {"ingested": ingested, "elapsed_ms": elapsed_ms}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080)
