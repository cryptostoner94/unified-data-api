#!/usr/bin/env python3
"""Unified public-data API — docs-watcher.

Scheduled job (daily full run; hourly for Tier-0 crypto via --tier0) that monitors
every upstream public endpoint in the PHASE 1 catalog (§2.1 crypto, §2.2 enterprise)
for:

  1. liveness        — GET the health-check URL; alert on non-2xx or slow response
  2. docs change     — SHA-256 of the docs page vs stored hash; flag changes and
                       scan the new content for deprecation-related keywords
  3. schema drift    — validate a live sample response against the registry's
                       minimal declared shape (field presence/type)
  4. deprecation     — record Deprecation / Sunset response headers when present
  5. staleness       — for feed-type sources, track the newest-item timestamp per
                       poll; alert when a feed exceeds 3x its expected cadence

Polite by design: descriptive User-Agent, per-host rate limiting, honors
Retry-After, cheap read-only checks only. No secrets are used or needed.

Output:
  reports/watcher-YYYYMMDD.json  (JSON report)
  reports/alerts.log             (appended alert lines)
  state.json                     (persisted hashes/timestamps between runs)
  stdout                         (human-readable summary)

Exit codes: 0 = clean, 2 = one or more alerts.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from urllib.parse import urlparse

import requests
import yaml

VERSION = "1.0.0"
WATCHER_NAME = "unified-data-docs-watcher"

DEFAULT_TIMEOUT_S = 20
DEFAULT_LATENCY_THRESHOLD_S = 10.0
DEFAULT_MIN_INTERVAL_S = 1.0
MAX_RETRY_AFTER_S = 60

def _load_dotenv() -> None:
    """Load ../.env (sibling of the repo root) for vars not already set.

    Keeps manual runs identical to the systemd timer run (which uses
    EnvironmentFile). Tiny parser: skips blanks/comments, splits on the first
    "=", tolerates the shell-unsafe LICENSE_KEYS placeholder line — the watcher
    only needs the *_API_KEY entries.
    """
    here = os.path.dirname(os.path.abspath(__file__))
    for cand in (os.path.join(here, "..", ".env"), os.path.join(here, ".env")):
        path = os.path.normpath(cand)
        if not os.path.isfile(path):
            continue
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    key, _, val = line.partition("=")
                    key = key.strip()
                    if not key or not key.replace("_", "").isalnum() or key in os.environ:
                        continue
                    val = val.strip()
                    if len(val) >= 2 and val[0] == val[-1] and val[0] in ("'", '"'):
                        val = val[1:-1]
                    os.environ[key] = val
        except OSError:
            pass


_load_dotenv()


DEPRECATION_KEYWORDS = [
    "deprecat", "sunset", "end-of-life", "end of life", "breaking change",
    "removed", "retired", "no longer", "migrat", "legacy",
]

# --------------------------------------------------------------------------
# HTTP plumbing — ALL network traffic goes through http_get(), which tests
# monkeypatch. Nothing else in this module may touch the network.


def _contact() -> str:
    return os.environ.get(
        "WATCHER_CONTACT",
        "contact@example.com [PLACEHOLDER - set WATCHER_CONTACT env var]",
    )


def default_headers() -> dict:
    return {
        "User-Agent": (
            f"{WATCHER_NAME}/{VERSION} "
            f"(scheduled upstream-monitoring for the unified public-data API catalog; "
            f"contact: {_contact()})"
        ),
        "Accept": "*/*",
    }


_session: requests.Session | None = None
_last_request_at: dict[str, float] = {}


def _sleep(seconds: float) -> None:
    """Indirection so tests can observe backoff without real sleeping."""
    time.sleep(seconds)


def _polite_wait(url: str, min_interval_s: float) -> None:
    host = urlparse(url).netloc.lower()
    now = time.monotonic()
    last = _last_request_at.get(host, 0.0)
    wait = min_interval_s - (now - last)
    if wait > 0:
        _sleep(wait)
    _last_request_at[host] = time.monotonic()


def _retry_after_seconds(resp) -> float | None:
    raw = None
    try:
        raw = resp.headers.get("Retry-After")
    except Exception:
        raw = None
    if raw is None:
        return None
    try:
        return max(0.0, min(float(str(raw).strip()), MAX_RETRY_AFTER_S))
    except (ValueError, TypeError):
        return None


def _apply_api_key(url: str, ep: dict) -> tuple[str, dict]:
    """Append API key from env to URL (api_key_param) and/or headers
    (api_key_header) when the endpoint declares api_key_env."""
    key_env = ep.get("api_key_env")
    headers: dict = {}
    if key_env:
        key = os.environ.get(key_env, "")
        if not key:
            raise RuntimeError(f"endpoint {ep['id']}: {key_env} is not set")
        param = ep.get("api_key_param")
        if param:
            sep = "&" if "?" in url else "?"
            url = f"{url}{sep}{param}={key}"
        header = ep.get("api_key_header")
        if header:
            headers[header] = key
    return url, headers


def http_get(url: str, timeout: float = DEFAULT_TIMEOUT_S,
             min_interval_s: float = DEFAULT_MIN_INTERVAL_S,
             headers: dict | None = None):
    """Single choke point for all outbound HTTP. Returns a requests.Response."""
    global _session
    if _session is None:
        _session = requests.Session()
        _session.headers.update(default_headers())
    _polite_wait(url, min_interval_s)
    resp = _session.get(url, timeout=timeout, allow_redirects=True,
                        headers=headers or None)
    if resp.status_code in (429, 503):
        wait = _retry_after_seconds(resp)
        if wait is not None:
            _sleep(wait)
            _polite_wait(url, min_interval_s)
            resp = _session.get(url, timeout=timeout, allow_redirects=True,
                                headers=headers or None)
    return resp


def _elapsed_s(resp) -> float:
    elapsed = getattr(resp, "elapsed", 0)
    if hasattr(elapsed, "total_seconds"):
        return float(elapsed.total_seconds())
    try:
        return float(elapsed)
    except (TypeError, ValueError):
        return 0.0


def _lower_headers(resp) -> dict:
    try:
        items = resp.headers.items()
    except Exception:
        return {}
    return {str(k).lower(): v for k, v in items}


# --------------------------------------------------------------------------
# The five checks


def check_liveness(ep: dict, defaults: dict) -> tuple[dict, list[str]]:
    """Check 1: GET the health-check URL; alert on non-2xx or slow response."""
    hc = ep["health_check"]
    url = hc["url"]
    # expect_status=None (or absent) means "any 2xx"; an explicit value
    # (even non-2xx, e.g. 401 for keyed APIs) must match exactly.
    expect = hc.get("expect_status")
    url, _key_headers = _apply_api_key(url, ep)
    threshold = hc.get("latency_threshold_s",
                       defaults.get("latency_threshold_s", DEFAULT_LATENCY_THRESHOLD_S))
    timeout = defaults.get("timeout_s", DEFAULT_TIMEOUT_S)
    alerts: list[str] = []
    result: dict = {"url": url, "ok": False}
    try:
        resp = http_get(url, timeout=timeout,
                        min_interval_s=ep.get("rate_limit_s",
                                            defaults.get("min_interval_s", DEFAULT_MIN_INTERVAL_S)),
                        headers=_key_headers)
        result["_resp"] = resp  # internal: feeds check 4; stripped before reporting
        status = resp.status_code
        latency = _elapsed_s(resp)
        result.update({"status": status, "latency_ms": round(latency * 1000, 1)})
        if expect is None:
            ok_status = 200 <= status < 300
            want = "2xx"
        else:
            ok_status = status == expect
            want = str(expect)
        if not ok_status:
            alerts.append(
                f"[liveness] {ep['id']}: HTTP {status} from {url} (expected {want})")
        elif latency > threshold:
            alerts.append(
                f"[liveness] {ep['id']}: slow response {latency:.1f}s > {threshold}s at {url}")
        else:
            result["ok"] = True
    except Exception as exc:  # network/DNS/timeout/parse failures
        result["error"] = f"{type(exc).__name__}: {exc}"
        alerts.append(f"[liveness] {ep['id']}: request failed for {url}: {exc}")
    return result, alerts


def _deprecation_headers(resp) -> dict:
    """Check 4 helper: pull Deprecation/Sunset headers (case-insensitive)."""
    headers = _lower_headers(resp)
    found = {}
    for name in ("deprecation", "sunset"):
        if name in headers:
            found[name] = headers[name]
    return found


def check_deprecation(ep: dict, responses: list) -> tuple[dict, list[str]]:
    """Check 4: record Deprecation/Sunset headers seen on any fetched response."""
    alerts: list[str] = []
    seen: dict = {}
    for resp in responses:
        for name, value in _deprecation_headers(resp).items():
            seen.setdefault(name, value)
    result = {"headers": seen, "ok": True}
    if seen:
        detail = ", ".join(f"{k}: {v}" for k, v in seen.items())
        alerts.append(f"[deprecation] {ep['id']}: provider sent {detail}")
        result["ok"] = False
    return result, alerts


def _content_bytes(resp) -> bytes:
    content = getattr(resp, "content", None)
    if isinstance(content, bytes):
        return content
    text = getattr(resp, "text", "") or ""
    return text.encode("utf-8", "replace")


_USPTO_REQID_RE = re.compile(r"\[[0-9a-f]{16}-[0-9a-f]{4,16}\]")


def _docs_fingerprint(html: str) -> str:
    """Stable fingerprint of a docs page for change detection.

    Uses visible prose (scripts/styles/tags stripped) rather than raw markup,
    so per-fetch Cloudflare artifacts (challenge scripts, data-cfemail
    obfuscation tokens) don't trigger false "changed" alerts. Plain-text
    request IDs (e.g. USPTO's `[000001a003b8b318-...]` notice suffix) are
    neutralized. Trade-off: pure hyperlink-URL changes without prose changes
    won't flip the hash — acceptable for a docs watchdog.
    """
    visible = _visible_text(html)
    visible = _USPTO_REQID_RE.sub("[request-id]", visible)
    return hashlib.sha256(visible.encode("utf-8", "replace")).hexdigest()


_SCRIPT_STYLE_RE = re.compile(r"(?is)<(script|style)[^>]*>.*?</\1>")
_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")


def _visible_text(html: str) -> str:
    """Strip scripts, styles and tags: keyword scans must see prose, not JS/CSS.

    Without this, tokens like `legacyPageName` (analytics JS) or `migration`
    (CSS class names) trigger false deprecation alerts.
    """
    text = _SCRIPT_STYLE_RE.sub(" ", html)
    text = _TAG_RE.sub(" ", text)
    return _WS_RE.sub(" ", text).strip()


def _keyword_hits(visible: str) -> list:
    """Deprecation keywords matched on word boundaries (case-insensitive)."""
    low = visible.lower()
    hits = []
    # Left word-boundary only: keywords are stems ("migrat" must match
    # "migrate"/"migration"), but must not match mid-word ("unremoved").
    for kw in DEPRECATION_KEYWORDS:
        if re.search(r"(?<![a-z0-9])" + re.escape(kw), low):
            hits.append(kw)
    return sorted(hits)


def check_docs(ep: dict, state: dict, defaults: dict):
    """Check 2: SHA-256 of docs page vs stored hash; keyword-scan on change."""
    url = ep["docs_url"]
    timeout = defaults.get("timeout_s", DEFAULT_TIMEOUT_S)
    alerts: list[str] = []
    result: dict = {"url": url, "ok": True, "changed": False}
    try:
        resp = http_get(url, timeout=timeout,
                        min_interval_s=ep.get("rate_limit_s",
                                            defaults.get("min_interval_s", DEFAULT_MIN_INTERVAL_S)))
        html = getattr(resp, "text", "") or ""
        visible = _visible_text(html)
        digest = _docs_fingerprint(html)
        result["sha256"] = digest
        result["deprecation_headers"] = _deprecation_headers(resp)
        ep_state = state.setdefault("endpoints", {}).setdefault(ep["id"], {})
        prev = ep_state.get("docs_hash")
        if prev is None:
            ep_state["docs_hash"] = digest  # first sighting: baseline, no alert
        elif prev != digest:
            result["changed"] = True
            hits = _keyword_hits(visible)
            result["keyword_hits"] = hits
            excerpt = visible[:500]
            result["excerpt_before"] = ep_state.get("docs_excerpt", "")
            result["excerpt_after"] = excerpt
            ep_state["docs_excerpt"] = excerpt
            ep_state["docs_hash"] = digest
            ep_state["docs_last_changed"] = _now_iso()
            snippet = excerpt[:140].replace("\n", " ")
            if hits:
                alerts.append(
                    f"[docs] {ep['id']}: docs changed at {url} "
                    f"(keywords: {', '.join(hits)}) :: {snippet}")
            else:
                alerts.append(
                    f"[docs] {ep['id']}: docs content changed at {url} "
                    f"(hash mismatch) :: {snippet}")
        result["_resp"] = resp  # internal: feeds check 4; stripped before reporting
    except Exception as exc:
        result["ok"] = False
        result["error"] = f"{type(exc).__name__}: {exc}"
        alerts.append(f"[docs] {ep['id']}: failed to fetch {url}: {exc}")
    return result, alerts


# --- schema drift ----------------------------------------------------------

_TYPE_NAMES = ("string", "integer", "number", "boolean", "array", "object", "null", "any")


def _matches_type(value, spec) -> bool:
    types = spec if isinstance(spec, (list, tuple)) else [spec]
    for t in types:
        if t == "any":
            return True
        if t == "string" and isinstance(value, str):
            return True
        if t == "integer" and isinstance(value, int) and not isinstance(value, bool):
            return True
        if t == "number" and isinstance(value, (int, float)) and not isinstance(value, bool):
            return True
        if t == "boolean" and isinstance(value, bool):
            return True
        if t == "array" and isinstance(value, list):
            return True
        if t == "object" and isinstance(value, dict):
            return True
        if t == "null" and value is None:
            return True
    return False


def validate_shape(data, shape: dict, path: str = "$") -> list[str]:
    """Validate decoded JSON against the registry's minimal declared shape."""
    errors: list[str] = []
    expected = shape.get("type", "any")
    if not _matches_type(data, expected):
        got = type(data).__name__
        return [f"{path}: expected type {expected}, got {got}"]
    if isinstance(data, dict):
        for name, fspec in (shape.get("fields") or {}).items():
            fspec = {"type": fspec} if isinstance(fspec, str) else fspec
            if name not in data:
                errors.append(f"{path}.{name}: missing field")
            else:
                errors.extend(validate_shape(data[name], fspec, f"{path}.{name}"))
    if isinstance(data, list) and "item" in shape and data:
        errors.extend(validate_shape(data[0], shape["item"], f"{path}[0]"))
    return errors


def check_schema(ep: dict, defaults: dict, sample_resp=None):
    """Check 3: validate a live sample response against the declared shape."""
    shape = ep.get("expected_shape")
    result: dict = {"ok": True, "skipped": shape is None, "errors": []}
    alerts: list[str] = []
    if shape is None:
        return result, alerts
    url = ep.get("sample_url") or ep["health_check"]["url"]
    url, _key_headers = _apply_api_key(url, ep)
    result["url"] = url
    try:
        resp = sample_resp if sample_resp is not None else http_get(
            url, timeout=defaults.get("timeout_s", DEFAULT_TIMEOUT_S),
            min_interval_s=ep.get("rate_limit_s",
                                defaults.get("min_interval_s", DEFAULT_MIN_INTERVAL_S)),
            headers=_key_headers)
        try:
            data = resp.json()
        except Exception as exc:
            result["ok"] = False
            result["errors"] = [f"response is not JSON: {exc}"]
            alerts.append(f"[schema] {ep['id']}: sample at {url} is not JSON: {exc}")
            return result, alerts
        errors = validate_shape(data, shape)
        result["errors"] = errors
        if errors:
            result["ok"] = False
            alerts.append(
                f"[schema] {ep['id']}: drift detected at {url}: " + "; ".join(errors))
    except Exception as exc:
        result["ok"] = False
        result["error"] = f"{type(exc).__name__}: {exc}"
        alerts.append(f"[schema] {ep['id']}: failed to fetch sample {url}: {exc}")
    return result, alerts


# --- staleness -------------------------------------------------------------


def extract_path(data, path: str):
    """Dotted path into decoded JSON. Numeric segments index arrays
    ('-1' = last element); '*' = first value of a dict / first item of a list."""
    cur = data
    for seg in path.split("."):
        if seg == "*":
            if isinstance(cur, dict) and cur:
                cur = next(iter(cur.values()))
            elif isinstance(cur, list) and cur:
                cur = cur[0]
            else:
                raise KeyError("'*' on empty/non-container")
        elif isinstance(cur, list) and re.fullmatch(r"-?\d+", seg):
            cur = cur[int(seg)]
        elif isinstance(cur, dict) and seg in cur:
            cur = cur[seg]
        else:
            raise KeyError(seg)
    return cur


def to_epoch(value) -> float:
    """Coerce a timestamp-ish value (unix s/ms/us, digit string, ISO-8601) to epoch seconds."""
    if isinstance(value, bool):
        raise ValueError(f"not a timestamp: {value!r}")
    if isinstance(value, (int, float)):
        f = float(value)
        if f > 1e15:
            return f / 1e6
        if f > 1e12:
            return f / 1e3
        return f
    if isinstance(value, str):
        s = value.strip()
        if re.fullmatch(r"-?\d+(\.\d+)?", s):
            return to_epoch(float(s))
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp()
    raise ValueError(f"not a timestamp: {value!r}")


def check_staleness(ep: dict, state: dict, defaults: dict, now: float):
    """Check 5 (§7.4): alert when a feed exceeds 3x its expected cadence
    without a new item."""
    feed = ep.get("feed")
    result: dict = {"ok": True, "skipped": feed is None}
    alerts: list[str] = []
    if feed is None:
        return result, alerts
    url = feed["url"]
    cadence = feed["expected_cadence_s"]
    result.update({"url": url, "expected_cadence_s": cadence})
    try:
        url, _key_headers = _apply_api_key(url, ep)
        resp = http_get(url, timeout=defaults.get("timeout_s", DEFAULT_TIMEOUT_S),
                        min_interval_s=ep.get("rate_limit_s",
                                            defaults.get("min_interval_s", DEFAULT_MIN_INTERVAL_S)),
                        headers=_key_headers)
        data = resp.json()
        if "slot_path" in feed:
            # Ethereum beacon slot -> epoch (genesis 1606824023, 12s slots)
            slot = int(extract_path(data, feed["slot_path"]))
            newest = 1606824023 + slot * 12
            result["newest_slot"] = slot
        else:
            newest = to_epoch(extract_path(data, feed["timestamp_path"]))
        age = now - newest
        result.update({"newest_ts": newest,
                       "newest_iso": datetime.fromtimestamp(newest, tz=timezone.utc).isoformat(),
                       "age_s": round(age, 1)})
        ep_state = state.setdefault("endpoints", {}).setdefault(ep["id"], {})
        ep_state["last_feed_ts"] = newest
        if age > 3 * cadence:
            result["ok"] = False
            alerts.append(
                f"[staleness] {ep['id']}: newest feed item is {age/60:.1f} min old "
                f"(> 3x cadence of {cadence}s) at {url}")
    except Exception as exc:
        result["ok"] = False
        result["error"] = f"{type(exc).__name__}: {exc}"
        alerts.append(f"[staleness] {ep['id']}: could not determine feed freshness at {url}: {exc}")
    return result, alerts


# --------------------------------------------------------------------------
# Orchestration


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_registry(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def load_state(path: str) -> dict:
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as fh:
            try:
                data = json.load(fh)
                if isinstance(data, dict):
                    data.setdefault("endpoints", {})
                    return data
            except json.JSONDecodeError:
                pass
    return {"version": 1, "endpoints": {}}


def save_state(path: str, state: dict) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(state, fh, indent=2, sort_keys=True)
    os.replace(tmp, path)


def validate_registry(registry: dict) -> list[str]:
    """Structural validation of the registry; returns a list of problems."""
    problems: list[str] = []
    endpoints = registry.get("endpoints") or []
    seen: set[str] = set()
    for i, ep in enumerate(endpoints):
        where = f"endpoints[{i}]"
        for key in ("id", "bundle", "base_url", "docs_url", "tier"):
            if not ep.get(key):
                problems.append(f"{where}: missing required '{key}'")
        eid = ep.get("id")
        if eid:
            if eid in seen:
                problems.append(f"{where}: duplicate id '{eid}'")
            seen.add(eid)
        hc = ep.get("health_check") or {}
        for key in ("method", "url"):
            if hc.get(key) is None:
                problems.append(f"{where} ({eid}): health_check missing '{key}'")
        url = hc.get("url", "")
        if url and not url.startswith(("http://", "https://")):
            problems.append(f"{where} ({eid}): health_check url must be http(s), got {url!r}")
        for key in ("base_url", "docs_url"):
            if ep.get(key) and not str(ep[key]).startswith(("http://", "https://", "wss://")):
                problems.append(f"{where} ({eid}): {key} looks invalid: {ep[key]!r}")
        feed = ep.get("feed") or {}
        for key in ("url", "expected_cadence_s"):
            if "feed" in ep and not feed.get(key):
                problems.append(f"{where} ({eid}): feed missing '{key}'")
        if "feed" in ep and not feed.get("timestamp_path") and not feed.get("slot_path"):
            problems.append(f"{where} ({eid}): feed needs 'timestamp_path' or 'slot_path'")
    return problems


def check_endpoint(ep: dict, state: dict, defaults: dict, now: float) -> dict:
    """Run all five checks for one endpoint; return the per-endpoint report."""
    ep_state = state.setdefault("endpoints", {}).setdefault(ep["id"], {})
    ep_state["last_check"] = _now_iso()
    out: dict = {
        "id": ep["id"], "bundle": ep.get("bundle"), "tier": ep.get("tier"),
        "checks": {}, "alerts": [], "status": "ok",
    }
    responses = []

    liveness, la = check_liveness(ep, defaults)
    live_resp = liveness.pop("_resp", None)
    if live_resp is not None:
        responses.append(live_resp)
    out["checks"]["liveness"] = liveness
    out["alerts"].extend(la)

    docs, da = check_docs(ep, state, defaults)
    docs_resp = docs.pop("_resp", None)
    if docs_resp is not None:
        responses.append(docs_resp)
    out["checks"]["docs"] = docs
    out["alerts"].extend(da)

    schema, sa = check_schema(ep, defaults)
    out["checks"]["schema"] = schema
    out["alerts"].extend(sa)

    deprecation, dpa = check_deprecation(ep, responses)
    out["checks"]["deprecation"] = deprecation
    out["alerts"].extend(dpa)

    staleness, sta = check_staleness(ep, state, defaults, now)
    out["checks"]["staleness"] = staleness
    out["alerts"].extend(sta)

    if out["alerts"]:
        out["status"] = "alert"
    ep_state["last_status"] = out["status"]
    return out


def _report_path(reports_dir: str, run_dt: datetime) -> str:
    base = f"watcher-{run_dt.strftime('%Y%m%d')}.json"
    path = os.path.join(reports_dir, base)
    if os.path.exists(path):  # second run same day: keep history, don't clobber
        path = os.path.join(reports_dir, f"watcher-{run_dt.strftime('%Y%m%d-%H%M%S')}.json")
    return path


def run(registry_path: str, state_path: str, reports_dir: str,
        tier0: bool = False, now: float | None = None) -> tuple[dict, int]:
    """Execute a full watcher run. Returns (report, exit_code)."""
    now = time.time() if now is None else now
    run_dt = datetime.fromtimestamp(now, tz=timezone.utc)
    os.makedirs(reports_dir, exist_ok=True)

    registry = load_registry(registry_path)
    problems = validate_registry(registry)
    if problems:
        raise ValueError("registry invalid:\n" + "\n".join(problems))
    defaults = registry.get("defaults") or {}
    endpoints = registry.get("endpoints") or []
    if tier0:
        endpoints = [e for e in endpoints if e.get("tier") == "tier0"]

    state = load_state(state_path)
    endpoint_reports = []
    all_alerts: list[str] = []
    for ep in endpoints:
        rep = check_endpoint(ep, state, defaults, now)
        endpoint_reports.append(rep)
        all_alerts.extend(rep["alerts"])

    ok_count = sum(1 for r in endpoint_reports if r["status"] == "ok")
    report = {
        "watcher": WATCHER_NAME,
        "version": VERSION,
        "run_at": run_dt.isoformat(),
        "tier0_only": tier0,
        "summary": {
            "endpoints": len(endpoint_reports),
            "ok": ok_count,
            "alert": len(endpoint_reports) - ok_count,
            "alerts": len(all_alerts),
        },
        "alerts": all_alerts,
        "endpoints": endpoint_reports,
    }

    report_path = _report_path(reports_dir, run_dt)
    with open(report_path, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2)
    if all_alerts:
        with open(os.path.join(reports_dir, "alerts.log"), "a", encoding="utf-8") as fh:
            for a in all_alerts:
                fh.write(f"{run_dt.isoformat()} [ALERT] {a}\n")
    save_state(state_path, state)
    return report, (2 if all_alerts else 0)


def print_summary(report: dict) -> None:
    s = report["summary"]
    scope = "TIER-0 (hourly crypto subset)" if report["tier0_only"] else "FULL (daily)"
    print(f"=== docs-watcher {scope} — {report['run_at']} ===")
    print(f"endpoints: {s['endpoints']}  ok: {s['ok']}  alert: {s['alert']}  alerts: {s['alerts']}")
    for ep in report["endpoints"]:
        mark = "ok   " if ep["status"] == "ok" else "ALERT"
        print(f"  [{mark}] {ep['id']} ({ep['bundle']})")
        for a in ep["alerts"]:
            print(f"           {a}")
    if report["alerts"]:
        print(f"\n{len(report['alerts'])} alert(s) — see reports/alerts.log (exit 2)")
    else:
        print("\nclean — no alerts (exit 0)")


def main(argv: list[str] | None = None) -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description="Upstream docs-watcher for the unified public-data API.")
    ap.add_argument("--registry", default=os.path.join(here, "endpoints.yaml"))
    ap.add_argument("--state", default=os.path.join(here, "state.json"))
    ap.add_argument("--reports", default=os.path.join(here, "reports"))
    ap.add_argument("--tier0", action="store_true",
                    help="hourly run: only the Tier-0 crypto subset")
    ap.add_argument("--validate-only", action="store_true",
                    help="validate the registry and exit (no network)")
    args = ap.parse_args(argv)

    if args.validate_only:
        problems = validate_registry(load_registry(args.registry))
        if problems:
            print("registry INVALID:")
            for p in problems:
                print(f"  - {p}")
            return 2
        print("registry valid")
        return 0

    report, code = run(args.registry, args.state, args.reports, tier0=args.tier0)
    print_summary(report)
    return code


if __name__ == "__main__":
    sys.exit(main())
