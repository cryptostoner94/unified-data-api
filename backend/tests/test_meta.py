"""Health / notice / tiers meta-endpoint tests."""

from __future__ import annotations


def test_health(client):
    r = client.get("/v1/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["version"]
    assert body["time"]


def test_notice_seeded_with_example(client):
    r = client.get("/v1/notice")
    assert r.status_code == 200
    notices = r.json()["notices"]
    assert len(notices) >= 1
    first = notices[0]
    for field in ("id", "severity", "title", "body", "publishedAt"):
        assert first[field], f"notice missing {field}"


def test_tiers_prices_are_tbd_not_invented(client):
    r = client.get("/v1/tiers")
    assert r.status_code == 200
    tiers = r.json()["tiers"]
    ids = {t["id"] for t in tiers}
    assert ids == {"free", "builder", "pro", "enterprise"}
    for t in tiers:
        assert t["priceMonthly"] == "TBD — set by owner", f"price invented for {t['id']}"
        assert isinstance(t["dailyBundleCallQuota"], int)
    free = next(t for t in tiers if t["id"] == "free")
    assert free["dailyBundleCallQuota"] == 100  # test-env override


def test_404_on_unknown_route(client):
    r = client.get("/v1/nope")
    assert r.status_code == 404
