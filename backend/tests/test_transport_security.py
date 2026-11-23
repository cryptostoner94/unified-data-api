"""Transport security: credential-bearing routes require TLS.

The public listener receives the raw license key on /v1/license/verify and the
key hash (the metering credential) on /v1/heartbeat. A deployment that is not
explicitly opted into plaintext must reject both, and must not publish the
OpenAPI schema of the licensing service.
"""

from __future__ import annotations

import importlib
import json

import pytest

from tests.conftest import TEST_RAW_KEYS, key_hash

RAW_BUILDER = "test-key-builder-AAA"


def _build_client(monkeypatch, tmp_path, *, allow_insecure: bool):
    from fastapi.testclient import TestClient

    monkeypatch.setenv("LICENSE_KEYS", json.dumps(TEST_RAW_KEYS))
    monkeypatch.setenv("SQLITE_PATH", str(tmp_path / "metering.db"))
    monkeypatch.delenv("DATABASE_URL", raising=False)
    if allow_insecure:
        monkeypatch.setenv("ALLOW_INSECURE_TRANSPORT", "1")
    else:
        monkeypatch.delenv("ALLOW_INSECURE_TRANSPORT", raising=False)

    import app.config as config_module
    import app.main as main_module

    importlib.reload(config_module)
    importlib.reload(main_module)
    return TestClient(main_module.create_app())


@pytest.fixture()
def hardened_client(tmp_path, monkeypatch):
    with _build_client(monkeypatch, tmp_path, allow_insecure=False) as c:
        yield c


@pytest.fixture()
def dev_client(tmp_path, monkeypatch):
    with _build_client(monkeypatch, tmp_path, allow_insecure=True) as c:
        yield c


HEARTBEAT_BODY = {
    "licenseKeyHash": key_hash(RAW_BUILDER),
    "bundleIds": {"crypto.cex": 1},
    "sdkVersion": "1.0.0",
    "platform": "node",
}


def test_license_verify_rejected_over_plaintext(hardened_client):
    r = hardened_client.post("/v1/license/verify", json={"licenseKey": RAW_BUILDER})
    assert r.status_code == 403
    assert r.json()["detail"]["error"] == "https_required"


def test_heartbeat_rejected_over_plaintext(hardened_client):
    r = hardened_client.post("/v1/heartbeat", json=HEARTBEAT_BODY)
    assert r.status_code == 403
    assert r.json()["detail"]["error"] == "https_required"


def test_raw_key_is_not_processed_over_plaintext(hardened_client, caplog):
    import logging

    with caplog.at_level(logging.DEBUG, logger="data-api"):
        hardened_client.post("/v1/license/verify", json={"licenseKey": RAW_BUILDER})
    assert "license.verify" not in caplog.text
    assert RAW_BUILDER not in caplog.text


def test_license_verify_accepted_over_tls(hardened_client):
    r = hardened_client.post(
        "https://testserver/v1/license/verify",
        json={"licenseKey": RAW_BUILDER},
    )
    assert r.status_code == 200
    assert r.json()["valid"] is True


def test_heartbeat_accepted_over_tls(hardened_client):
    r = hardened_client.post("https://testserver/v1/heartbeat", json=HEARTBEAT_BODY)
    assert r.status_code == 200
    assert r.json()["ok"] is True


def test_forwarded_proto_header_from_non_loopback_peer_is_not_trusted(hardened_client):
    r = hardened_client.post(
        "/v1/license/verify",
        json={"licenseKey": RAW_BUILDER},
        headers={"X-Forwarded-Proto": "https"},
    )
    assert r.status_code == 403


def test_openapi_routes_absent_without_dev_optin(hardened_client):
    assert hardened_client.get("/docs").status_code == 404
    assert hardened_client.get("/openapi.json").status_code == 404


def test_health_route_stays_open_over_plaintext(hardened_client):
    r = hardened_client.get("/v1/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_plaintext_allowed_with_dev_optin(dev_client):
    r = dev_client.post("/v1/license/verify", json={"licenseKey": RAW_BUILDER})
    assert r.status_code == 200
    assert r.json()["valid"] is True
    assert dev_client.get("/docs").status_code == 200
