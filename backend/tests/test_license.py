"""License verification tests: valid / invalid / unknown keys, fail-closed."""

from __future__ import annotations

from tests.conftest import key_hash

RAW_BUILDER = "test-key-builder-AAA"
RAW_FREE = "test-key-free-BBB"
RAW_EXPIRED = "test-key-expired-CCC"


def test_verify_valid_builder_key(client):
    r = client.post("/v1/license/verify", json={"licenseKey": RAW_BUILDER})
    assert r.status_code == 200
    body = r.json()
    assert body["valid"] is True
    assert body["plan"] == "builder"
    assert body["bundles"] == ["crypto.cex", "weather.forecast", "feeds.status"]
    assert body["expiresAt"] == "2099-01-01T00:00:00Z"


def test_verify_unknown_key_fails_closed(client):
    r = client.post("/v1/license/verify", json={"licenseKey": "no-such-key-XYZ"})
    assert r.status_code == 200
    body = r.json()
    assert body["valid"] is False
    assert body["plan"] is None
    assert body["bundles"] == []
    assert body["notice"]  # explains the failure


def test_verify_expired_key_invalid(client):
    r = client.post("/v1/license/verify", json={"licenseKey": RAW_EXPIRED})
    assert r.status_code == 200
    body = r.json()
    assert body["valid"] is False
    assert body["plan"] == "pro"
    assert "expired" in (body["notice"] or "").lower()


def test_verify_missing_key_rejected(client):
    r = client.post("/v1/license/verify", json={})
    assert r.status_code == 422  # schema validation, fail closed


def test_verify_empty_key_rejected(client):
    r = client.post("/v1/license/verify", json={"licenseKey": ""})
    assert r.status_code == 422


def test_verify_free_plan(client):
    r = client.post("/v1/license/verify", json={"licenseKey": RAW_FREE})
    assert r.status_code == 200
    body = r.json()
    assert body["valid"] is True
    assert body["plan"] == "free"


def test_verify_malformed_json_rejected(client):
    r = client.post("/v1/license/verify", data="not-json", headers={"Content-Type": "application/json"})
    assert r.status_code == 422


def test_malformed_license_keys_env_fails_closed(tmp_path, monkeypatch):
    """Garbage LICENSE_KEYS -> empty store -> every key invalid (fail closed)."""
    import importlib

    monkeypatch.setenv("LICENSE_KEYS", "{not valid json")
    monkeypatch.setenv("SQLITE_PATH", str(tmp_path / "m.db"))
    monkeypatch.delenv("DATABASE_URL", raising=False)

    from fastapi.testclient import TestClient
    import app.config as config_module

    importlib.reload(config_module)
    import app.main as main_module

    importlib.reload(main_module)
    app = main_module.create_app()
    with TestClient(app) as c:
        r = c.post("/v1/license/verify", json={"licenseKey": RAW_BUILDER})
        assert r.status_code == 200
        assert r.json()["valid"] is False
