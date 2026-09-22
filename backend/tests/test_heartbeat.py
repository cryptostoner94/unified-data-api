"""Heartbeat tests: shape validation, unknown bundles, quotas, persistence."""

from __future__ import annotations

from tests.conftest import key_hash

RAW_BUILDER = "test-key-builder-AAA"
RAW_FREE = "test-key-free-BBB"
HASH_BUILDER = key_hash(RAW_BUILDER)
HASH_FREE = key_hash(RAW_FREE)


def hb(key_hash_, bundles, sdk="1.0.0", platform="node"):
    return {
        "licenseKeyHash": key_hash_,
        "bundleIds": bundles,
        "sdkVersion": sdk,
        "platform": platform,
    }


def test_heartbeat_ok(client):
    # 42 + 31 = 73 < test builder quota (500) -> ok, no downgrade.
    r = client.post("/v1/heartbeat", json=hb(HASH_BUILDER, {"crypto.cex": 42, "weather.forecast": 31}))
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["downgrade"] is False


def test_heartbeat_unknown_key_hash_rejected(client):
    r = client.post("/v1/heartbeat", json=hb("0" * 64, {"crypto.cex": 1}))
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is False
    assert body["downgrade"] is False


def test_heartbeat_unknown_bundle_id_rejected(client):
    r = client.post("/v1/heartbeat", json=hb(HASH_BUILDER, {"not.a.bundle": 5}))
    assert r.status_code == 422
    assert "unknown_bundle_ids" in r.text


def test_heartbeat_negative_count_rejected(client):
    r = client.post("/v1/heartbeat", json=hb(HASH_BUILDER, {"crypto.cex": -1}))
    assert r.status_code == 422


def test_heartbeat_non_integer_count_rejected(client):
    r = client.post("/v1/heartbeat", json=hb(HASH_BUILDER, {"crypto.cex": "lots"}))
    assert r.status_code == 422


def test_heartbeat_missing_fields_rejected(client):
    r = client.post("/v1/heartbeat", json={"licenseKeyHash": HASH_BUILDER})
    assert r.status_code == 422


def test_heartbeat_bad_hash_format_rejected(client):
    r = client.post("/v1/heartbeat", json=hb("not-hex", {"crypto.cex": 1}))
    assert r.status_code == 422


def test_heartbeat_zero_counts_ok(client):
    r = client.post("/v1/heartbeat", json=hb(HASH_BUILDER, {"crypto.cex": 0}))
    assert r.status_code == 200
    assert r.json()["ok"] is True


def test_heartbeat_implausible_count_rejected(client):
    # Server-side guard against absurd counts (fail closed).
    r = client.post("/v1/heartbeat", json=hb(HASH_BUILDER, {"crypto.cex": 10_000_000_000}))
    assert r.status_code == 422


def test_heartbeat_quota_enforcement_downgrade(client):
    # Free plan quota is 100/day in the test env. Push past it.
    r = client.post("/v1/heartbeat", json=hb(HASH_FREE, {"crypto.cex": 90}))
    assert r.status_code == 200
    assert r.json()["downgrade"] is False

    r = client.post("/v1/heartbeat", json=hb(HASH_FREE, {"crypto.cex": 20}))
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["downgrade"] is True
    assert body["notice"] is not None


def test_heartbeat_persists_aggregates(client, app_env):
    import sqlite3

    r = client.post("/v1/heartbeat", json=hb(HASH_BUILDER, {"feeds.status": 17}))
    assert r.json()["ok"] is True

    conn = sqlite3.connect(app_env)
    row = conn.execute(
        "SELECT calls FROM usage_daily WHERE key_hash = ? AND bundle = 'feeds.status'",
        (HASH_BUILDER,),
    ).fetchone()
    conn.close()
    assert row is not None
    assert row[0] >= 17


def test_heartbeat_expired_license_rejected(client):
    expired_hash = key_hash("test-key-expired-CCC")
    r = client.post("/v1/heartbeat", json=hb(expired_hash, {"crypto.cex": 1}))
    assert r.status_code == 200
    assert r.json()["ok"] is False


def test_heartbeat_unlicensed_bundle_warning(client):
    # crypto.mev is a real bundle but NOT in this key's licensed bundles.
    r = client.post("/v1/heartbeat", json=hb(HASH_BUILDER, {"crypto.cex": 1, "crypto.mev": 2}))
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["downgrade"] is False
    assert body["notice"] is not None
    assert "crypto.mev" in body["notice"]
