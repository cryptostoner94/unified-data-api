"""Persistence layer for heartbeat usage aggregates.

Default: local SQLite (dev). Optional: Postgres via DATABASE_URL (requires
psycopg at runtime). No outbound network calls are made by this module;
SQLite is a local file, and Postgres is only reached when the operator
configures DATABASE_URL.

Schema:
    usage_daily(key_hash TEXT, bundle TEXT, day TEXT, calls INTEGER,
                PRIMARY KEY (key_hash, bundle, day))
"""

from __future__ import annotations

import logging
import os
import sqlite3
import threading
from datetime import date

log = logging.getLogger(__name__)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS usage_daily (
    key_hash TEXT NOT NULL,
    bundle TEXT NOT NULL,
    day TEXT NOT NULL,
    calls INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (key_hash, bundle, day)
);
"""


class UsageStore:
    """Thread-safe usage aggregate store. Fail-closed: DB errors are raised
    (callers treat exceptions as DENY / ok=false), never silently swallowed."""

    def __init__(self, database_url: str = "", sqlite_path: str = "data/metering.db"):
        self._database_url = database_url.strip()
        self._lock = threading.Lock()
        if self._database_url:
            self._kind = "postgres"
            self._conn = self._connect_postgres(self._database_url)
        else:
            self._kind = "sqlite"
            os.makedirs(os.path.dirname(os.path.abspath(sqlite_path)) or ".", exist_ok=True)
            # check_same_thread=False + lock: safe for uvicorn threaded workers.
            self._conn = sqlite3.connect(sqlite_path, check_same_thread=False)
        self._init_schema()

    @staticmethod
    def _connect_postgres(url: str):
        try:
            import psycopg  # type: ignore
        except ImportError as exc:
            raise RuntimeError(
                "DATABASE_URL is set but the 'psycopg' package is not installed. "
                "Install it (pip install psycopg[binary]) or unset DATABASE_URL "
                "to use the SQLite default."
            ) from exc
        log.info("Connecting usage store to Postgres.")
        return psycopg.connect(url)

    def _init_schema(self) -> None:
        with self._lock:
            cur = self._conn.cursor()
            cur.execute(_SCHEMA)
            self._conn.commit()
            cur.close()

    def add_counts(self, key_hash: str, counts: dict[str, int], day: date) -> None:
        """Add heartbeat bundle counts to today's aggregates (UPSERT)."""
        day_s = day.isoformat()
        with self._lock:
            cur = self._conn.cursor()
            try:
                for bundle, n in counts.items():
                    if self._kind == "postgres":
                        cur.execute(
                            """INSERT INTO usage_daily (key_hash, bundle, day, calls)
                               VALUES (%s, %s, %s, %s)
                               ON CONFLICT (key_hash, bundle, day)
                               DO UPDATE SET calls = usage_daily.calls + EXCLUDED.calls""",
                            (key_hash, bundle, day_s, n),
                        )
                    else:
                        cur.execute(
                            """INSERT INTO usage_daily (key_hash, bundle, day, calls)
                               VALUES (?, ?, ?, ?)
                               ON CONFLICT (key_hash, bundle, day)
                               DO UPDATE SET calls = usage_daily.calls + excluded.calls""",
                            (key_hash, bundle, day_s, n),
                        )
                self._conn.commit()
            finally:
                cur.close()

    def daily_total(self, key_hash: str, day: date) -> int:
        """Total bundle calls for one key hash on one UTC day."""
        day_s = day.isoformat()
        with self._lock:
            cur = self._conn.cursor()
            try:
                if self._kind == "postgres":
                    cur.execute(
                        "SELECT COALESCE(SUM(calls), 0) FROM usage_daily WHERE key_hash = %s AND day = %s",
                        (key_hash, day_s),
                    )
                else:
                    cur.execute(
                        "SELECT COALESCE(SUM(calls), 0) FROM usage_daily WHERE key_hash = ? AND day = ?",
                        (key_hash, day_s),
                    )
                row = cur.fetchone()
                return int(row[0] or 0)
            finally:
                cur.close()

    def close(self) -> None:
        try:
            self._conn.close()
        except Exception:  # noqa: BLE001 - best-effort shutdown
            log.exception("Error closing usage store connection.")
