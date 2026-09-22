"""Docs-watcher test suite — 100% mocked, ZERO real network calls.

Every test monkeypatches `watcher.http_get`, the single choke point for all
outbound HTTP in watcher.py. If any code path tried to touch the real network,
these tests would fail (the stub raises unless the test explicitly configures
a fake response).
"""

import json
import os
import sys
from datetime import timedelta

import pytest
import yaml

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import watcher

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REGISTRY = os.path.join(HERE, "endpoints.yaml")

NOW = 1_787_000_000.0  # fixed "now" for deterministic staleness tests


# --------------------------------------------------------------------------
# Fakes


class FakeResp:
    """Minimal stand-in for requests.Response."""

    def __init__(self, status_code=200, text="", headers=None, elapsed_s=0.05,
                 json_data="__FROM_TEXT__", content=None):
        self.status_code = status_code
        self.text = text
        self.headers = headers or {}
        self.elapsed = timedelta(seconds=elapsed_s)
        self._json_data = json_data
        self._content = content

    @property
    def content(self):
        if self._content is not None:
            return self._content
        return self.text.encode("utf-8")

    def json(self):
        if self._json_data == "__FROM_TEXT__":
            return json.loads(self.text)
        if isinstance(self._json_data, Exception):
            raise self._json_data
        return self._json_data


class HttpStub:
    """URL -> FakeResp (or list of FakeResps, consumed in order) dispatcher."""

    def __init__(self, mapping=None, default=None):
        self.mapping = mapping or {}
        self.default = default or FakeResp(200, "{}")
        self.calls = []

    def __call__(self, url, **kwargs):
        self.calls.append(url)
        entry = self.mapping.get(url, self.default)
        if isinstance(entry, list):
            if not entry:
                raise AssertionError(f"stub exhausted for {url}")
            return entry.pop(0)
        return entry


@pytest.fixture()
def stub(monkeypatch):
    s = HttpStub()
    monkeypatch.setattr(watcher, "http_get", s)
    return s


def make_ep(**over):
    ep = {
        "id": "svc-test",
        "bundle": "crypto",
        "name": "Test Service",
        "base_url": "https://svc.example",
        "docs_url": "https://svc.example/docs",
        "tier": "standard",
        "health_check": {
            "method": "GET",
            "url": "https://svc.example/health",
            "expect_status": 200,
        },
    }
    ep.update(over)
    return ep


DEFAULTS = {"timeout_s": 5, "latency_threshold_s": 10.0, "min_interval_s": 0}


# --------------------------------------------------------------------------
# Registry validation


def test_registry_all_endpoints_have_required_fields():
    registry = watcher.load_registry(REGISTRY)
    problems = watcher.validate_registry(registry)
    assert problems == [], f"registry problems: {problems}"


def test_registry_endpoint_count_and_bundles():
    registry = watcher.load_registry(REGISTRY)
    eps = registry["endpoints"]
    assert len(eps) == 24, f"expected 24 PHASE 1 endpoints, got {len(eps)}"
    bundles = {e["bundle"] for e in eps}
    assert bundles == {"crypto", "enterprise"}, f"unexpected bundles: {bundles}"
    crypto = [e for e in eps if e["bundle"] == "crypto"]
    enterprise = [e for e in eps if e["bundle"] == "enterprise"]
    assert len(crypto) == 14 and len(enterprise) == 10


def test_registry_tier0_subset():
    registry = watcher.load_registry(REGISTRY)
    tier0 = [e["id"] for e in registry["endpoints"] if e.get("tier") == "tier0"]
    assert tier0 == ["mempool-rest", "binance-dataapi", "kraken-rest"]


def test_registry_ids_unique_and_health_urls_http():
    registry = watcher.load_registry(REGISTRY)
    ids = [e["id"] for e in registry["endpoints"]]
    assert len(ids) == len(set(ids)), "duplicate endpoint ids"
    for e in registry["endpoints"]:
        url = e["health_check"]["url"]
        assert url.startswith(("http://", "https://")), f"{e['id']}: non-http health url {url}"


def test_registry_spec_base_urls_pinned():
    """Spot-check that base URLs match the spec verbatim (no invented endpoints)."""
    registry = watcher.load_registry(REGISTRY)
    by_id = {e["id"]: e for e in registry["endpoints"]}
    assert by_id["mempool-rest"]["base_url"] == "https://mempool.space/api"
    assert by_id["mempool-rest"]["health_check"]["url"] == "https://mempool.space/api/blocks/tip/height"
    assert by_id["binance-dataapi"]["base_url"] == "https://data-api.binance.vision"
    assert by_id["binance-ws"]["base_url"] == "wss://data-stream.binance.vision"
    assert by_id["kraken-rest"]["base_url"] == "https://api.kraken.com/0/public"
    assert by_id["kraken-ws-v2"]["base_url"] == "wss://ws.kraken.com/v2"
    assert by_id["flashbots-relay"]["base_url"] == "https://boost-relay.flashbots.net"
    assert by_id["ultrasound-relay"]["base_url"] == "https://relay.ultrasound.money"
    assert by_id["bloxroute-relay"]["base_url"] == "https://bloxroute.regulated.blxrbdn.com"
    assert by_id["blockchain-info-ws"]["base_url"] == "wss://ws.blockchain.info/inv"
    assert by_id["sec-edgar"]["health_check"]["url"] == "https://www.sec.gov/files/company_tickers.json"
    assert by_id["gleif"]["base_url"] == "https://api.gleif.org/api/v1"
    assert by_id["dexscreener"]["base_url"] == "https://api.dexscreener.com"
    assert by_id["geckoterminal"]["base_url"] == "https://api.geckoterminal.com/api/v2"


def test_registry_validate_rejects_bad_endpoint():
    bad = {"endpoints": [{"id": "x", "bundle": "crypto"}]}  # missing most fields
    problems = watcher.validate_registry(bad)
    assert any("docs_url" in p for p in problems)
    assert any("health_check" in p for p in problems)


# --------------------------------------------------------------------------
# Check 1 — liveness


def test_liveness_ok(stub):
    stub.mapping["https://svc.example/health"] = FakeResp(200, '{"ok": true}', elapsed_s=0.2)
    result, alerts = watcher.check_liveness(make_ep(), DEFAULTS)
    assert result["ok"] and result["status"] == 200
    assert result["latency_ms"] == 200.0
    assert alerts == []


def test_liveness_non_2xx_alerts(stub):
    stub.mapping["https://svc.example/health"] = FakeResp(503, "down")
    result, alerts = watcher.check_liveness(make_ep(), DEFAULTS)
    assert not result["ok"]
    assert len(alerts) == 1 and "[liveness]" in alerts[0] and "503" in alerts[0]


def test_liveness_unexpected_status_alerts(stub):
    stub.mapping["https://svc.example/health"] = FakeResp(201, "created")
    result, alerts = watcher.check_liveness(make_ep(), DEFAULTS)
    assert not result["ok"]
    assert any("expected 200" in a for a in alerts)


def test_liveness_slow_alerts(stub):
    stub.mapping["https://svc.example/health"] = FakeResp(200, "{}", elapsed_s=15.0)
    result, alerts = watcher.check_liveness(make_ep(), DEFAULTS)
    assert not result["ok"]
    assert any("slow response" in a for a in alerts)


def test_liveness_network_failure_alerts(stub, monkeypatch):
    def boom(url, **kw):
        raise ConnectionError("dns exploded")
    monkeypatch.setattr(watcher, "http_get", boom)
    result, alerts = watcher.check_liveness(make_ep(), DEFAULTS)
    assert not result["ok"]
    assert any("request failed" in a for a in alerts)


def test_liveness_routes_through_http_get(stub):
    # proves the single-choke-point design: with http_get mocked, a run of the
    # liveness check must hit our stub (and nothing else).
    stub.mapping["https://svc.example/health"] = FakeResp(200, "{}")
    watcher.check_liveness(make_ep(), DEFAULTS)
    assert stub.calls == ["https://svc.example/health"]


# --------------------------------------------------------------------------
# Check 2 — docs change


def test_docs_first_sighting_baselines_without_alert(stub):
    stub.mapping["https://svc.example/docs"] = FakeResp(200, "<html>docs v1</html>")
    state = {"endpoints": {}}
    result, alerts = watcher.check_docs(make_ep(), state, DEFAULTS)
    assert result["ok"] and not result["changed"]
    assert alerts == []
    assert len(state["endpoints"]["svc-test"]["docs_hash"]) == 64


def test_docs_hash_change_alerts(stub):
    ep = make_ep()
    state = {"endpoints": {"svc-test": {"docs_hash": "0" * 64}}}
    stub.mapping["https://svc.example/docs"] = FakeResp(200, "<html>docs v2 — totally rewritten</html>")
    result, alerts = watcher.check_docs(ep, state, DEFAULTS)
    assert result["changed"]
    assert any("[docs]" in a and "changed" in a for a in alerts)
    assert state["endpoints"]["svc-test"]["docs_hash"] != "0" * 64


def test_docs_change_flags_deprecation_keywords(stub):
    ep = make_ep()
    state = {"endpoints": {"svc-test": {"docs_hash": "0" * 64}}}
    stub.mapping["https://svc.example/docs"] = FakeResp(
        200, "<html>v1 is DEPRECATED and will sunset; migrate now</html>")
    result, alerts = watcher.check_docs(ep, state, DEFAULTS)
    assert result["changed"]
    assert set(result["keyword_hits"]) >= {"deprecat", "sunset", "migrat"}
    assert any("deprecat" in a for a in alerts)


def test_docs_stable_hash_no_alert(stub):
    body = "<html>docs v1</html>"
    digest = watcher._docs_fingerprint(body)
    state = {"endpoints": {"svc-test": {"docs_hash": digest}}}
    stub.mapping["https://svc.example/docs"] = FakeResp(200, body)
    result, alerts = watcher.check_docs(make_ep(), state, DEFAULTS)
    assert result["ok"] and not result["changed"]
    assert alerts == []


# --------------------------------------------------------------------------
# Check 3 — schema drift


def _ep_with_shape():
    return make_ep(expected_shape={
        "type": "object",
        "fields": {
            "error": {"type": "array"},
            "result": {"type": "object"},
        },
    })


def test_schema_valid_ok(stub):
    stub.mapping["https://svc.example/health"] = FakeResp(
        200, json_data={"error": [], "result": {"unixtime": 1}})
    result, alerts = watcher.check_schema(_ep_with_shape(), DEFAULTS)
    assert result["ok"] and result["errors"] == [] and alerts == []


def test_schema_drift_missing_field(stub):
    stub.mapping["https://svc.example/health"] = FakeResp(
        200, json_data={"error": []})  # 'result' removed upstream
    result, alerts = watcher.check_schema(_ep_with_shape(), DEFAULTS)
    assert not result["ok"]
    assert any("missing field" in e for e in result["errors"])
    assert any("[schema]" in a and "drift" in a for a in alerts)


def test_schema_drift_wrong_type(stub):
    stub.mapping["https://svc.example/health"] = FakeResp(
        200, json_data={"error": "none", "result": {}})  # error became a string
    result, alerts = watcher.check_schema(_ep_with_shape(), DEFAULTS)
    assert not result["ok"]
    assert any("expected type" in e for e in result["errors"])
    assert len(alerts) == 1


def test_schema_non_json_alerts(stub):
    stub.mapping["https://svc.example/health"] = FakeResp(200, "<html>not json</html>")
    result, alerts = watcher.check_schema(_ep_with_shape(), DEFAULTS)
    assert not result["ok"]
    assert any("not JSON" in a for a in alerts)


def test_schema_skipped_when_no_shape_declared(stub):
    result, alerts = watcher.check_schema(make_ep(), DEFAULTS)
    assert result["skipped"] and result["ok"] and alerts == []
    assert stub.calls == []  # no HTTP at all when skipped


def test_validate_shape_nested_and_union_types():
    shape = {"type": "object", "fields": {
        "slot": {"type": ["string", "integer"]},
        "tags": {"type": "array", "item": {"type": "string"}},
    }}
    assert watcher.validate_shape({"slot": "12", "tags": ["a"]}, shape) == []
    assert watcher.validate_shape({"slot": 12, "tags": []}, shape) == []
    errs = watcher.validate_shape({"slot": 1.5, "tags": [1]}, shape)
    assert len(errs) == 2


# --------------------------------------------------------------------------
# Check 4 — deprecation headers


def test_deprecation_header_recorded_and_alerts():
    resp = FakeResp(200, "{}", headers={"Deprecation": "true",
                                       "Sunset": "Sat, 01 Jan 2028 00:00:00 GMT"})
    result, alerts = watcher.check_deprecation(make_ep(), [resp])
    assert result["headers"] == {"deprecation": "true",
                                 "sunset": "Sat, 01 Jan 2028 00:00:00 GMT"}
    assert len(alerts) == 1 and "[deprecation]" in alerts[0]


def test_no_deprecation_headers_no_alert():
    result, alerts = watcher.check_deprecation(make_ep(), [FakeResp(200, "{}")])
    assert result["headers"] == {} and result["ok"] and alerts == []


def test_deprecation_header_case_insensitive():
    resp = FakeResp(200, "{}", headers={"SUNSET": "soon"})
    result, alerts = watcher.check_deprecation(make_ep(), [resp])
    assert result["headers"] == {"sunset": "soon"}
    assert alerts


# --------------------------------------------------------------------------
# Check 5 — staleness (§7.4)


def _feed_ep(**over):
    ep = make_ep(**over)
    ep["feed"] = {"url": "https://svc.example/feed",
                  "timestamp_path": "items.0.ts",
                  "expected_cadence_s": 60}
    return ep


def test_staleness_fresh_ok(stub):
    stub.mapping["https://svc.example/feed"] = FakeResp(
        200, json_data={"items": [{"ts": NOW - 30}]})
    state = {"endpoints": {}}
    result, alerts = watcher.check_staleness(_feed_ep(), state, DEFAULTS, NOW)
    assert result["ok"] and alerts == []
    assert state["endpoints"]["svc-test"]["last_feed_ts"] == NOW - 30


def test_staleness_alert_when_quiet(stub):
    stub.mapping["https://svc.example/feed"] = FakeResp(
        200, json_data={"items": [{"ts": NOW - 600}]})  # 10 min old, cadence 60s
    result, alerts = watcher.check_staleness(_feed_ep(), {"endpoints": {}}, DEFAULTS, NOW)
    assert not result["ok"]
    assert any("[staleness]" in a and "3x" in a for a in alerts)


def test_staleness_skipped_without_feed(stub):
    result, alerts = watcher.check_staleness(make_ep(), {"endpoints": {}}, DEFAULTS, NOW)
    assert result["skipped"] and alerts == []
    assert stub.calls == []


def test_staleness_iso_and_ms_timestamps(stub):
    stub.mapping["https://svc.example/feed"] = FakeResp(
        200, json_data={"items": [{"ts": int((NOW - 10) * 1000)}]})
    result, _ = watcher.check_staleness(_feed_ep(), {"endpoints": {}}, DEFAULTS, NOW)
    assert result["ok"]
    stub.mapping["https://svc.example/feed"] = FakeResp(
        200, json_data={"items": [{"ts": "2026-09-22T00:00:00Z"}]})
    ep = _feed_ep()
    ep["feed"]["expected_cadence_s"] = 10 ** 9  # huge cadence: never stale
    result, alerts = watcher.check_staleness(ep, {"endpoints": {}}, DEFAULTS, NOW)
    assert result["ok"] and alerts == []


def test_to_epoch_units():
    assert watcher.to_epoch(1_787_000_000) == 1_787_000_000.0          # seconds
    assert watcher.to_epoch(1_787_000_000_000) == 1_787_000_000.0      # ms
    assert watcher.to_epoch("1787000000") == 1_787_000_000.0           # digit string
    assert watcher.to_epoch("2026-09-22T08:00:00+00:00") > 1_780_000_000
    with pytest.raises(ValueError):
        watcher.to_epoch(True)


def test_extract_path_wildcard_and_negative_index():
    data = {"result": {"XXBTZUSD": [[100, "1"], [200, "2"]]}}
    assert watcher.extract_path(data, "result.*.-1.0") == 200
    with pytest.raises(KeyError):
        watcher.extract_path(data, "result.nope.0")


# --------------------------------------------------------------------------
# Politeness: User-Agent, rate limiting, Retry-After


def test_default_headers_descriptive_user_agent(monkeypatch):
    monkeypatch.delenv("WATCHER_CONTACT", raising=False)
    ua = watcher.default_headers()["User-Agent"]
    assert "unified-data-docs-watcher" in ua and "contact" in ua.lower()
    monkeypatch.setenv("WATCHER_CONTACT", "ops@example.com")
    assert "ops@example.com" in watcher.default_headers()["User-Agent"]


def test_retry_after_honored(monkeypatch):
    sleeps = []
    monkeypatch.setattr(watcher, "_sleep", sleeps.append)
    monkeypatch.setattr(watcher, "_polite_wait", lambda *a, **k: None)

    first = FakeResp(429, "slow down", headers={"Retry-After": "2"})
    second = FakeResp(200, '{"ok": true}')
    calls = {"n": 0}

    def fake_get(url, **kw):
        calls["n"] += 1
        return first if calls["n"] == 1 else second

    fake_session = type("FakeSession", (), {})()
    fake_session.get = fake_get
    monkeypatch.setattr(watcher, "_session", fake_session, raising=False)
    # call the real http_get (not the stub) — no network, session is faked
    out = watcher.http_get("https://svc.example/x", timeout=5, min_interval_s=0)
    assert out.status_code == 200
    assert calls["n"] == 2
    assert sleeps == [2.0]


def test_per_host_rate_limiting(monkeypatch):
    waits = []
    monkeypatch.setattr(watcher, "_sleep", waits.append)
    monkeypatch.setattr(watcher, "_last_request_at", {})
    watcher._polite_wait("https://h.example/a", 5.0)
    assert waits == []  # first request: no wait
    watcher._polite_wait("https://h.example/b", 5.0)
    assert len(waits) == 1 and waits[0] > 4.0  # second request within window: waits
    watcher._polite_wait("https://other.example/a", 5.0)
    assert len(waits) == 1  # different host: no wait


# --------------------------------------------------------------------------
# Full runs: reports, alerts.log, state.json, exit codes


def _mini_registry(path):
    doc = {
        "version": 1,
        "defaults": {"timeout_s": 5, "latency_threshold_s": 10.0, "min_interval_s": 0},
        "endpoints": [
            {
                "id": "svc-a", "bundle": "crypto", "name": "A",
                "base_url": "https://a.example", "docs_url": "https://a.example/docs",
                "tier": "tier0",
                "health_check": {"method": "GET", "url": "https://a.example/health",
                                "expect_status": 200},
                "expected_shape": {"type": "object", "fields": {"ok": {"type": "boolean"}}},
                "feed": {"url": "https://a.example/feed", "timestamp_path": "items.0.ts",
                         "expected_cadence_s": 60},
            },
            {
                "id": "svc-b", "bundle": "enterprise", "name": "B",
                "base_url": "https://b.example", "docs_url": "https://b.example/docs",
                "tier": "standard",
                "health_check": {"method": "GET", "url": "https://b.example/docs",
                                "expect_status": 200},
            },
        ],
    }
    with open(path, "w") as fh:
        yaml.safe_dump(doc, fh)
    return path


def _healthy_mapping(now):
    return {
        "https://a.example/health": FakeResp(200, json_data={"ok": True}),
        "https://a.example/docs": FakeResp(200, "<html>A docs</html>"),
        "https://a.example/feed": FakeResp(200, json_data={"items": [{"ts": now}]}),
        "https://b.example/docs": FakeResp(200, "<html>B docs</html>"),
    }


def test_full_run_clean_exit_0_writes_report_and_state(tmp_path, stub, monkeypatch):
    monkeypatch.setattr(watcher.time, "time", lambda: NOW)
    reg = _mini_registry(str(tmp_path / "endpoints.yaml"))
    stub.mapping.update(_healthy_mapping(NOW))
    reports = str(tmp_path / "reports")
    report, code = watcher.run(reg, str(tmp_path / "state.json"), reports, now=NOW)
    assert code == 0
    assert report["summary"] == {"endpoints": 2, "ok": 2, "alert": 0, "alerts": 0}
    files = os.listdir(reports)
    assert any(f.startswith("watcher-") and f.endswith(".json") for f in files)
    assert not os.path.exists(os.path.join(reports, "alerts.log"))
    state = json.load(open(tmp_path / "state.json"))
    assert state["endpoints"]["svc-a"]["docs_hash"]
    assert state["endpoints"]["svc-a"]["last_feed_ts"] == NOW


def test_full_run_alerts_exit_2_and_alerts_log(tmp_path, stub, monkeypatch):
    monkeypatch.setattr(watcher.time, "time", lambda: NOW)
    reg = _mini_registry(str(tmp_path / "endpoints.yaml"))
    mapping = _healthy_mapping(NOW)
    mapping["https://a.example/health"] = FakeResp(503, "boom")  # liveness fails
    mapping["https://a.example/feed"] = FakeResp(
        200, json_data={"items": [{"ts": NOW - 10_000}]})  # stale feed
    stub.mapping.update(mapping)
    reports = str(tmp_path / "reports")
    report, code = watcher.run(reg, str(tmp_path / "state.json"), reports, now=NOW)
    assert code == 2
    assert report["summary"]["alerts"] >= 2
    log = open(os.path.join(reports, "alerts.log")).read()
    assert "[ALERT] [liveness] svc-a" in log
    assert "[ALERT] [staleness] svc-a" in log


def test_second_run_no_docs_alert_when_unchanged(tmp_path, stub, monkeypatch):
    monkeypatch.setattr(watcher.time, "time", lambda: NOW)
    reg = _mini_registry(str(tmp_path / "endpoints.yaml"))
    stub.mapping.update(_healthy_mapping(NOW))
    state_p = str(tmp_path / "state.json")
    reports = str(tmp_path / "reports")
    watcher.run(reg, state_p, reports, now=NOW)  # baselines docs hashes
    report2, code2 = watcher.run(reg, state_p, reports, now=NOW + 60)
    assert code2 == 0
    assert not any("[docs]" in a for a in report2["alerts"])


def test_docs_change_detected_between_runs(tmp_path, stub, monkeypatch):
    monkeypatch.setattr(watcher.time, "time", lambda: NOW)
    reg = _mini_registry(str(tmp_path / "endpoints.yaml"))
    stub.mapping.update(_healthy_mapping(NOW))
    state_p = str(tmp_path / "state.json")
    reports = str(tmp_path / "reports")
    watcher.run(reg, state_p, reports, now=NOW)
    stub.mapping["https://a.example/docs"] = FakeResp(200, "<html>A docs v2</html>")
    report2, code2 = watcher.run(reg, state_p, reports, now=NOW + 60)
    assert code2 == 2
    assert any("[docs] svc-a" in a for a in report2["alerts"])


def test_tier0_flag_filters_to_tier0_only(tmp_path, stub, monkeypatch):
    monkeypatch.setattr(watcher.time, "time", lambda: NOW)
    reg = _mini_registry(str(tmp_path / "endpoints.yaml"))
    stub.mapping.update(_healthy_mapping(NOW))
    report, code = watcher.run(reg, str(tmp_path / "s.json"), str(tmp_path / "r"),
                               tier0=True, now=NOW)
    assert code == 0
    assert [e["id"] for e in report["endpoints"]] == ["svc-a"]
    assert report["tier0_only"] is True


def test_keyword_scan_ignores_script_and_style_content():
    """'legacyPageName' in analytics JS must not flag deprecation."""
    html = """
    <html><head><script>var digitalData={"page":{"legacyPageName":"x"}};</script>
    <style>.uscb-tag__migration{color:red}</style></head>
    <body><p>Current API documentation.</p></body></html>
    """
    assert watcher._keyword_hits(watcher._visible_text(html)) == []


def test_keyword_scan_matches_real_deprecation_prose():
    html = """
    <html><body><p>This legacy endpoint is no longer supported.
    Please migrate to v2 before the sunset date.</p></body></html>
    """
    hits = watcher._keyword_hits(watcher._visible_text(html))
    assert hits == ["legacy", "migrat", "no longer", "sunset"]


def test_keyword_scan_word_boundaries():
    """'removed' must not match inside 'unremoved'; case-insensitive."""
    html = "<html><body><p>Data DEPRECATED as of 2026.</p></body></html>"
    assert watcher._keyword_hits(watcher._visible_text(html)) == ["deprecat"]
    html2 = "<html><body><p>The unremoved entries remain.</p></body></html>"
    assert watcher._keyword_hits(watcher._visible_text(html2)) == []


def test_fingerprint_ignores_cfemail_and_scripts():
    a = ('<html><head><script>window.__CF$cv$params={s:"abc123"}</script></head>'
         '<body><p>Contact <span class="__cf_email__" data-cfemail="0e6d6b60">[email]</span></p></body></html>')
    b = ('<html><head><script>window.__CF$cv$params={s:"def456"}</script></head>'
         '<body><p>Contact <span class="__cf_email__" data-cfemail="4b282e25">[email]</span></p></body></html>')
    assert watcher._docs_fingerprint(a) == watcher._docs_fingerprint(b)


def test_fingerprint_ignores_uspto_request_id():
    a = "register for an API key. [000001a003b8b318-6916e53]"
    b = "register for an API key. [000001a003b8b318-6916e5f]"
    assert watcher._docs_fingerprint(a) == watcher._docs_fingerprint(b)


def test_fingerprint_detects_prose_change():
    assert watcher._docs_fingerprint("<html><body><p>v1 docs</p></body></html>") != \
        watcher._docs_fingerprint("<html><body><p>v2 docs</p></body></html>")


def test_docs_change_records_excerpts(stub):
    ep = make_ep()
    state = {"endpoints": {"svc-test": {"docs_hash": "0" * 64,
                                       "docs_excerpt": "old docs text"}}}
    stub.mapping["https://svc.example/docs"] = FakeResp(
        200, "<html><body><p>new docs text here</p></body></html>")
    result, alerts = watcher.check_docs(ep, state, DEFAULTS)
    assert result["changed"]
    assert result["excerpt_before"] == "old docs text"
    assert "new docs text here" in result["excerpt_after"]
    assert any("new docs text here" in a for a in alerts)


def test_main_validate_only(tmp_path, capsys):
    reg = _mini_registry(str(tmp_path / "endpoints.yaml"))
    assert watcher.main(["--validate-only", "--registry", reg]) == 0
    assert "registry valid" in capsys.readouterr().out


def test_main_invalid_registry_exits_2(tmp_path):
    bad = tmp_path / "bad.yaml"
    bad.write_text("endpoints:\n  - {id: x}\n")
    assert watcher.main(["--validate-only", "--registry", str(bad)]) == 2
