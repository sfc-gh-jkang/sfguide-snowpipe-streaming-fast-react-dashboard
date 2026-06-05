"""Production StreamingService for Snowpipe Streaming HPA.

Self-healing channel pool with partition-based routing for per-position ordering.
Pattern from snowpipe-streaming skill v1.0.82 references/python-sdk.md.
"""
from __future__ import annotations

import json
import logging
import threading
from typing import Dict, List, Set

logger = logging.getLogger(__name__)
MAX_RECOVERY_ATTEMPTS = 3


class StreamingService:
    def __init__(
        self,
        account: str,
        user: str,
        private_key_path: str,
        database: str,
        schema: str,
        table: str,
        role: str | None = None,
        partition_count: int = 4,
        instance_id: str = "default",
    ):
        self.account = account
        self.user = user
        self.private_key_path = private_key_path
        self.database = database
        self.schema = schema
        self.table = table
        self.role = role
        self.pipe_name = f"{table}-STREAMING"
        self.partition_count = partition_count
        self.instance_id = instance_id
        self.client = None
        self.channels: List = []
        self._lock = threading.Lock()
        self._recovering: Set[int] = set()
        self._error_log: list[dict] = []  # recent errors for /health

    def _read_private_key(self) -> str:
        """Read PEM key file and return raw content."""
        with open(self.private_key_path, "r") as f:
            return f.read()

    def _build_profile_path(self) -> str:
        """Write a JSON profile to /tmp and return the path."""
        account = self.account.replace("_", "-")
        profile = {
            "account": account,
            "user": self.user,
            "url": f"https://{account}.snowflakecomputing.com:443",
            "private_key": self._read_private_key(),
            "max_client_lag": "100 milliseconds",
        }
        if self.role:
            profile["role"] = self.role
        path = f"/tmp/profile_{self.instance_id}.json"
        with open(path, "w") as f:
            json.dump(profile, f)
        return path

    def initialize(self):
        """Open partition_count channels via StreamingIngestClient."""
        from snowflake.ingest.streaming.streaming_ingest_client import (
            StreamingIngestClient,
        )

        profile_path = self._build_profile_path()

        self.client = StreamingIngestClient(
            client_name=f"client_{self.instance_id}",
            db_name=self.database,
            schema_name=self.schema,
            pipe_name=self.pipe_name,
            profile_json=profile_path,
        )

        self.channels = []
        for i in range(self.partition_count):
            ch_name = f"{self.instance_id}_p{i}"
            ch, _ = self.client.open_channel(ch_name)
            self.channels.append(ch)
            logger.info("Opened channel %s", ch_name)

        logger.info(
            "StreamingService initialized: %d channels → %s.%s.%s",
            len(self.channels),
            self.database,
            self.schema,
            self.table,
        )

    def _hash_to_partition(self, key: str) -> int:
        """Deterministic hash → partition index (preserves per-key ordering)."""
        h = 0
        for c in key:
            h = ((h << 5) - h) + ord(c)
        return abs(h) % self.partition_count

    def _is_recoverable(self, error: Exception) -> bool:
        err = str(error).lower()
        return any(
            k in err
            for k in [
                "token has expired",
                "invalid state",
                "invalidchannelerror",
                "unauthorized",
            ]
        )

    def _recover_channel(self, partition_id: int) -> bool:
        """Lock-protected: close + reopen channel. Only one thread per partition."""
        with self._lock:
            if partition_id in self._recovering:
                return False
            self._recovering.add(partition_id)
        try:
            try:
                self.channels[partition_id].close()
            except Exception:
                pass
            ch_name = f"{self.instance_id}_p{partition_id}"
            ch, _ = self.client.open_channel(ch_name)
            self.channels[partition_id] = ch
            logger.info("Recovered channel %s", ch_name)
            return True
        except Exception as e:
            logger.error("Recovery failed for partition %d: %s", partition_id, e)
            self._error_log.append(
                {"partition": partition_id, "error": str(e), "type": "recovery_failed"}
            )
            return False
        finally:
            with self._lock:
                self._recovering.discard(partition_id)

    def stream_row(
        self, row: Dict, partition_key: str, offset_token: str | None = None
    ) -> dict:
        """Append a single row and wait for HPA commit.

        Returns dict with partition index and flush timing for caller latency breakdown.
        """
        import time as _time

        partition = self._hash_to_partition(partition_key)
        for attempt in range(MAX_RECOVERY_ATTEMPTS):
            try:
                kwargs = {}
                if offset_token:
                    kwargs["offset_token"] = offset_token

                t_append = _time.monotonic()
                self.channels[partition].append_row(row, **kwargs)
                append_ms = round((_time.monotonic() - t_append) * 1000, 2)

                # Force synchronous commit — drops post-ack lag from ~7s to ~1s.
                # Tradeoff: per-event ack latency increases. OK for click-driven demo,
                # NOT for high-throughput producers (use MAX_CLIENT_LAG batching there).
                t_flush = _time.monotonic()
                self.channels[partition].wait_for_flush(timeout_seconds=10)
                flush_ms = round((_time.monotonic() - t_flush) * 1000, 2)

                return {
                    "partition": partition,
                    "sdk_appended_ms": append_ms,
                    "flush_committed_ms": flush_ms,
                }
            except Exception as e:
                self._error_log.append(
                    {
                        "partition": partition,
                        "attempt": attempt,
                        "error": str(e),
                        "type": "stream_row",
                    }
                )
                if self._is_recoverable(e) and attempt < MAX_RECOVERY_ATTEMPTS - 1:
                    logger.warning(
                        "Recoverable error on partition %d (attempt %d): %s",
                        partition,
                        attempt,
                        e,
                    )
                    if self._recover_channel(partition):
                        continue
                raise
        return {"partition": partition, "sdk_appended_ms": 0, "flush_committed_ms": 0}

    def stream_batch(
        self,
        rows: List[Dict],
        partition_key: str,
        offset_token: str | None = None,
    ) -> int:
        """Append multiple rows to the same partition."""
        partition = self._hash_to_partition(partition_key)
        for attempt in range(MAX_RECOVERY_ATTEMPTS):
            try:
                kwargs = {}
                if offset_token:
                    kwargs["end_offset_token"] = offset_token
                self.channels[partition].append_rows(rows, **kwargs)
                return len(rows)
            except Exception as e:
                self._error_log.append(
                    {
                        "partition": partition,
                        "attempt": attempt,
                        "error": str(e),
                        "type": "stream_batch",
                    }
                )
                if self._is_recoverable(e) and attempt < MAX_RECOVERY_ATTEMPTS - 1:
                    logger.warning(
                        "Recoverable error on partition %d (attempt %d): %s",
                        partition,
                        attempt,
                        e,
                    )
                    if self._recover_channel(partition):
                        continue
                raise
        return 0

    def flush_and_wait(self, timeout_seconds: int = 30):
        """Flush all channels and wait for commit."""
        for ch in self.channels:
            ch.initiate_flush()
        self.client.wait_for_flush(timeout_seconds=timeout_seconds)

    def get_status(self) -> dict:
        """Return status dict for health endpoint."""
        recent_errors = self._error_log[-10:] if self._error_log else []
        return {
            "channel_count": len(self.channels),
            "partition_count": self.partition_count,
            "instance_id": self.instance_id,
            "pipe_name": self.pipe_name,
            "target": f"{self.database}.{self.schema}.{self.table}",
            "recent_errors": recent_errors,
            "total_errors": len(self._error_log),
        }

    def shutdown(self):
        """Close all channels and the client."""
        for ch in self.channels:
            try:
                ch.close()
            except Exception:
                pass
        if self.client:
            try:
                self.client.close()
            except Exception:
                pass
        logger.info("StreamingService shut down")
