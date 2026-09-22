"""x402 metering STUB tests (spec §4.1). Verifies the stub contract only:
challenge payload shape + placeholder markers, and mock-verify settlement."""

from __future__ import annotations


def test_challenge_returns_402_style_payload(client):
    r = client.get("/v1/x402/challenge", params={"resource": "proxy/coingecko/quote"})
    assert r.status_code == 200
    body = r.json()
    assert body["protocol"] == "x402"
    assert body["resource"] == "proxy/coingecko/quote"
    assert body["price"]["asset"] == "USDC"
    assert "payTo" in body and body["payTo"]
    assert "facilitator" in body and body["facilitator"]
    assert isinstance(body["expiresIn"], int)
    assert "STUB" in body["note"]  # stub marker is always present


def test_challenge_resource_required(client):
    r = client.get("/v1/x402/challenge")
    assert r.status_code == 422


def test_challenge_placeholders_are_marked(client):
    r = client.get("/v1/x402/challenge", params={"resource": "proxy/x"})
    body = r.json()
    # payTo is an obviously-fake placeholder address; facilitator is an .invalid URL.
    assert "invalid" in body["facilitator"]
    assert "STUB" in body["note"]


def test_verify_mock_proof_settles(client):
    r = client.post(
        "/v1/x402/verify",
        json={"resource": "proxy/coingecko/quote", "proof": {"txHash": "0xdeadbeef", "mock": True}},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["settled"] is True
    assert "STUB" in body["note"]


def test_verify_accepts_empty_mock_proof(client):
    r = client.post("/v1/x402/verify", json={"resource": "proxy/x", "proof": {}})
    assert r.status_code == 200
    assert r.json()["settled"] is True


def test_verify_requires_resource(client):
    r = client.post("/v1/x402/verify", json={"proof": {"mock": True}})
    assert r.status_code == 422
