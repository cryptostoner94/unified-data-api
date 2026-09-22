"""Shared test fixtures. Everything runs offline; the app under test is
constructed with env-controlled config (LICENSE_KEYS, quotas, SQLite in tmp).
"""

from __future__ import annotations

import hashlib
import json
import os
import sys

import pytest

# Ensure the backend root (with the `app` package) is importable.
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

TEST_RAW_KEYS = {
    "test-key-builder-AAA": {
        "plan": "builder",
        "bundles": ["crypto.cex", "weather.forecast", "feeds.status"],
        "expiresAt": "2099-01-01T00:00:00Z",
        "label": "test builder key",
    },
    "test-key-free-BBB": {
        "plan": "free",
        "bundles": ["crypto.cex", "weather.forecast"],
        "expiresAt": "2099-01-01T00:00:00Z",
        "label": "test free key",
    },
    "test-key-expired-CCC": {
        "plan": "pro",
        "bundles": ["crypto.cex"],
        "expiresAt": "2000-01-01T00:00:00Z",
        "label": "test expired key",
    },
}


def key_hash(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


@pytest.fixture()
def app_env(tmp_path, monkeypatch):
    """Set env (keys, tiny quotas, tmp sqlite) before importing the app."""
    db_path = str(tmp_path / "metering.db")
    monkeypatch.setenv("LICENSE_KEYS", json.dumps(TEST_RAW_KEYS))
    monkeypatch.setenv("SQLITE_PATH", db_path)
    monkeypatch.setenv("QUOTA_FREE", "100")        # tiny for quota tests
    monkeypatch.setenv("QUOTA_BUILDER", "500")
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.setenv("LOG_LEVEL", "DEBUG")
    return db_path


@pytest.fixture()
def client(app_env):
    from fastapi.testclient import TestClient

    import importlib

    # Env vars above must take effect in module-level config (quotas, keys),
    # so reload config first, then the app module that binds to it.
    import app.config as config_module

    importlib.reload(config_module)
    import app.main as main_module

    importlib.reload(main_module)
    app = main_module.create_app()
    with TestClient(app) as c:
        yield c
