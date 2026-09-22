"""Server -> SDK notices (spec §5: docs-watcher alerts reach the SDK on the
heartbeat/notice channel). Seeded with one example notice."""

from __future__ import annotations

import copy
import threading
from datetime import datetime, timezone

NOTICES: list[dict] = [
    {
        "id": "notice-2026-09-22-001",
        "severity": "warning",
        "title": "Upstream change flagged by docs-watcher: Finnhub historical candles",
        "body": (
            "Docs-watcher detected that Finnhub's free tier returns 403 for "
            "/stock/candle (historical candles are a premium feature). "
            "SDK finance.stocks adapter now labels candle data from Finnhub as "
            "ESTIMATE when served from cache and prefers Twelve Data/Alpha Vantage "
            "adapters where available. No SDK upgrade required for this notice."
        ),
        "publishedAt": datetime(2026, 9, 22, 8, 0, 0, tzinfo=timezone.utc).isoformat(),
        "bundleIds": ["finance.stocks"],
    },
]

_lock = threading.Lock()


def list_notices() -> list[dict]:
    with _lock:
        return copy.deepcopy(NOTICES)


def add_notice(notice: dict) -> None:
    with _lock:
        NOTICES.append(copy.deepcopy(notice))
