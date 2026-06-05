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
import time
import uuid
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

# ---------------------------------------------------------------------------
# Config from env
# ---------------------------------------------------------------------------
SF_ACCOUNT = os.environ.get("SNOWFLAKE_ACCOUNT", "<your-snowflake-account>")
SF_USER = os.environ.get("SNOWFLAKE_USER", "CREDIT_INGEST_USR")
SF_ROLE = os.environ.get("SNOWFLAKE_ROLE", "CREDIT_INGEST_RL")
SF_DB = os.environ.get("SNOWFLAKE_DATABASE", "SNOWFLAKE_EXAMPLE")
SF_SCHEMA = os.environ.get("SNOWFLAKE_SCHEMA", "CREDIT_DEMO")
SF_TABLE = os.environ.get("SNOWFLAKE_TABLE", "RAW_EVENTS")
SF_KEY_PATH = os.environ.get("SNOWFLAKE_PRIVATE_KEY_PATH", "/etc/credit/keys/credit_ingest.p8")
API_KEY = os.environ.get("INGEST_API_KEY", "")
PARTITION_COUNT = int(os.environ.get("PARTITION_COUNT", "4"))

# Reference position IDs (POS-0001 through POS-0062)
POSITION_IDS = [f"POS-{i:04d}" for i in range(1, 63)]
COUNTERPARTIES = ["GS", "JPM", "MS", "BAML", "CITI", "DB", "UBS", "CS", "HSBC", "BNP"]
AGENCIES = ["SP", "MOODY", "FITCH"]
RATINGS = ["AAA", "AA+", "AA", "AA-", "A+", "A", "A-", "BBB+", "BBB", "BBB-", "BB+", "BB"]
MARK_SOURCES = ["BLOOMBERG", "REUTERS", "ICE", "INTERNAL", "MARKIT"]

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
otlp_endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318")
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=f"{otlp_endpoint}/v1/traces")))
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


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize StreamingService on startup, fire warmup events, shut down on stop."""
    log.info(
        "Initializing StreamingService → %s.%s.%s (%d partitions)",
        SF_DB, SF_SCHEMA, SF_TABLE, PARTITION_COUNT,
    )
    try:
        service.initialize()
        log.info("StreamingService ready")

        # Pre-warm channels: fire 3 dummy events so first real click doesn't pay cold-start.
        # Uses source_app='warmup' so dashboard tiles can filter these out.
        for i in range(3):
            warmup_row = {
                "EVENT_ID": str(uuid.uuid4()),
                "EVENT_TS": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f"),
                "EVENT_TYPE": "WARMUP",
                "POSITION_ID": "POS-0001",
                "SOURCE_APP": "warmup",
                "INGESTED_TS": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f"),
            }
            try:
                service.stream_row(warmup_row, partition_key="POS-0001")
                log.info("Warmup event %d/3 committed", i + 1)
            except Exception:
                log.warning("Warmup event %d/3 failed (non-fatal)", i + 1, exc_info=True)
    except Exception:
        log.exception("Failed to initialize StreamingService")
    yield
    log.info("Shutting down StreamingService")
    service.shutdown()


app = FastAPI(title="ACME Ingest", lifespan=lifespan)


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class IngestRequest(BaseModel):
    event_type: str = Field(..., pattern="^(TRADE|MARK|CREDIT_EVENT)$")
    position_id: str | None = None
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
    event_id = str(uuid.uuid4())

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

    return row


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.get("/health")
async def health():
    status = service.get_status()
    return {
        "status": "ok" if status["channel_count"] > 0 else "degraded",
        **status,
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
            result = service.stream_row(row, partition_key=partition_key, offset_token=row["EVENT_ID"])
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
            "vm_received_ms": vm_received_ms,
            "sdk_appended_ms": result["sdk_appended_ms"],
            "flush_committed_ms": result["flush_committed_ms"],
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
