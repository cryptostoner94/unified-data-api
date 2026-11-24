"""The SDK path constants must equal the metering routes this server serves."""

from __future__ import annotations

import os
import re

import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SDK_LICENSE_SRC = os.path.join(
    REPO_ROOT, "sdk", "packages", "sdk", "src", "core", "license.ts"
)
PATH_CONST_RE = re.compile(r'^export const ([A-Z0-9_]*_PATH) = "([^"]+)";$', re.MULTILINE)

# The metering routes the SDK must call, as documented in README.md and
# backend/README.md. A legacy alias may also be served, but it is not the route
# the client should use, so it is not listed here.
DOCUMENTED_SDK_ROUTES = {
    "HEARTBEAT_PATH": "/v1/heartbeat",
    "LICENSE_VERIFY_PATH": "/v1/license/verify",
}


def sdk_route_paths() -> dict[str, str]:
    """Path constants the SDK client sends to, e.g. {"HEARTBEAT_PATH": "/v1/heartbeat"}."""
    if not os.path.exists(SDK_LICENSE_SRC):
        pytest.skip("the SDK source is not checked out next to the backend")
    with open(SDK_LICENSE_SRC, encoding="utf-8") as fh:
        return dict(PATH_CONST_RE.findall(fh.read()))


def served_routes(client) -> set[tuple[str, str]]:
    routes = client.app.routes
    return {
        (route.path, method)
        for route in routes
        for method in (getattr(route, "methods", None) or set())
    }


def test_sdk_paths_match_the_documented_routes():
    assert sdk_route_paths() == DOCUMENTED_SDK_ROUTES


def test_every_documented_route_is_a_served_post_route(client):
    served = served_routes(client)
    missing = {
        name: path
        for name, path in DOCUMENTED_SDK_ROUTES.items()
        if (path, "POST") not in served
    }
    assert not missing, f"documented routes the server does not serve: {missing}"


def test_legacy_license_heartbeat_alias_meters(client):
    """SDK 0.1.x beats to /v1/license/heartbeat must still be recorded."""
    from tests.conftest import key_hash

    body = {
        "licenseKeyHash": key_hash("test-key-builder-AAA"),
        "bundleIds": {"crypto.cex": 2},
        "sdkVersion": "0.1.0",
        "platform": "node",
    }
    legacy = client.post("/v1/license/heartbeat", json=body)
    current = client.post("/v1/heartbeat", json=body)
    assert legacy.status_code == 200
    assert current.status_code == 200
    assert legacy.json()["ok"] is True
    assert current.json()["ok"] is True
