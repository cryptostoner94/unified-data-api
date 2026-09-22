"""No-raw-key-logging tests: capture ALL log records emitted during
license/heartbeat traffic and assert the raw key never appears anywhere.

The key store only retains SHA-256 hashes; these tests prove the raw key
cannot leak through any log line.
"""

from __future__ import annotations

import logging

RAW_BUILDER = "test-key-builder-AAA"
RAW_FREE = "test-key-free-BBB"


def test_verify_never_logs_raw_key(client, caplog):
    with caplog.at_level(logging.DEBUG, logger="data-api"):
        client.post("/v1/license/verify", json={"licenseKey": RAW_BUILDER})
        client.post("/v1/license/verify", json={"licenseKey": "wrong-key-123"})
    assert RAW_BUILDER not in caplog.text
    assert "wrong-key-123" not in caplog.text


def test_heartbeat_never_logs_raw_key(client, caplog):
    from tests.conftest import key_hash

    with caplog.at_level(logging.DEBUG, logger="data-api"):
        client.post(
            "/v1/heartbeat",
            json={
                "licenseKeyHash": key_hash(RAW_FREE),
                "bundleIds": {"crypto.cex": 1},
                "sdkVersion": "1.0.0",
                "platform": "node",
            },
        )
    assert RAW_BUILDER not in caplog.text
    assert RAW_FREE not in caplog.text


def test_key_store_holds_hashes_only(app_env):
    import app.config as config_module
    import importlib

    importlib.reload(config_module)  # app_env set LICENSE_KEYS first
    store = config_module.load_license_keys()
    assert len(store) == 3  # all three test keys loaded
    # With the test LICENSE_KEYS (set by env in the real fixture flow),
    # hashes are keyed by sha256 hex — no entry value or key should contain
    # any raw test key.
    for key_hash_, entry in store.items():
        assert len(key_hash_) == 64
        for raw in ("test-key-builder-AAA", "test-key-free-BBB", "test-key-expired-CCC"):
            assert raw not in key_hash_
            assert raw not in entry.fingerprint
            assert raw not in entry.label
            assert raw not in str(entry.bundles)


def test_verify_response_never_echoes_raw_key(client):
    r = client.post("/v1/license/verify", json={"licenseKey": RAW_BUILDER})
    body = r.text
    assert RAW_BUILDER not in body
