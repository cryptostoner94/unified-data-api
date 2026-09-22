"""x402 metering STUB (spec §4.1).

This module is a STUB ONLY for development and integration testing:

- GET /v1/x402/challenge returns a 402-style payment-challenge payload with
  PLACEHOLDER values (fake payTo address, fake facilitator URL).
- POST /v1/x402/verify accepts a MOCK settlement proof and always answers
  {settled: true} — nothing is verified against any chain.

There are deliberately:
- NO real charges,
- NO real chain calls,
- NO outbound network calls of any kind in this module.

Real x402 settlement (payment verification via a facilitator) must be
implemented before any production metering depends on this endpoint.
"""

from __future__ import annotations

from app.schemas import (
    X402ChallengeResponse,
    X402VerifyRequest,
    X402VerifyResponse,
)

# --- Placeholders. These are intentionally fake. --------------------------------
STUB_PAY_TO = "0x000000000000000000000000000000000000dEaD"  # placeholder
STUB_FACILITATOR = "https://facilitator.example.invalid/x402"  # placeholder
STUB_ASSET = "USDC"
STUB_NETWORK = "base"
STUB_PRICE_AMOUNT = "0.001"  # placeholder price per resource unit
STUB_EXPIRES_IN_SECONDS = 300


def build_challenge(resource: str) -> X402ChallengeResponse:
    return X402ChallengeResponse(
        resource=resource,
        price={
            "amount": STUB_PRICE_AMOUNT,
            "asset": STUB_ASSET,
            "network": STUB_NETWORK,
        },
        payTo=STUB_PAY_TO,
        facilitator=STUB_FACILITATOR,
        expiresIn=STUB_EXPIRES_IN_SECONDS,
        note=(
            "STUB ONLY — development placeholder. No real payment is required, "
            "no charge is made, and no chain transaction is performed. "
            "Wire real x402 settlement before production use."
        ),
    )


def verify_stub_proof(request: X402VerifyRequest) -> X402VerifyResponse:
    # Stub: accept any well-formed mock proof. Real implementation must verify
    # the settlement with the facilitator/chain here.
    return X402VerifyResponse(
        settled=True,
        note=(
            "STUB ONLY — the proof was NOT verified against any chain or "
            "facilitator. Always true in stub mode."
        ),
    )
