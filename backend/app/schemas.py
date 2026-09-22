"""Pydantic request/response schemas. Strict validation, fail-closed."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field, field_validator


# --- License verify -----------------------------------------------------------
class LicenseVerifyRequest(BaseModel):
    licenseKey: str = Field(..., min_length=1, max_length=512)


class LicenseVerifyResponse(BaseModel):
    valid: bool
    plan: str | None = None
    bundles: list[str] = Field(default_factory=list)
    expiresAt: str | None = None
    notice: str | None = None


# --- Heartbeat ----------------------------------------------------------------
class HeartbeatRequest(BaseModel):
    licenseKeyHash: str = Field(..., min_length=64, max_length=64,
                                description="SHA-256 hex of the license key")
    bundleIds: dict[str, int] = Field(..., min_length=1, max_length=50)
    sdkVersion: str = Field(..., min_length=1, max_length=64)
    platform: str = Field(..., min_length=1, max_length=64)

    @field_validator("licenseKeyHash")
    @classmethod
    def _hex(cls, v: str) -> str:
        try:
            int(v, 16)
        except ValueError as exc:
            raise ValueError("licenseKeyHash must be hex") from exc
        return v.lower()

    @field_validator("bundleIds")
    @classmethod
    def _non_negative_counts(cls, v: dict[str, int]) -> dict[str, int]:
        for bundle, count in v.items():
            if not isinstance(count, int) or isinstance(count, bool):
                raise ValueError(f"count for bundle {bundle!r} must be an integer")
            if count < 0:
                raise ValueError(f"count for bundle {bundle!r} must be >= 0")
        return v


class HeartbeatResponse(BaseModel):
    ok: bool
    downgrade: bool = False
    notice: str | None = None


# --- x402 metering stub (spec §4.1 — STUB ONLY, no real payments) ---------------
class X402ChallengeResponse(BaseModel):
    protocol: str = "x402"
    resource: str
    price: dict[str, Any]
    payTo: str
    facilitator: str
    expiresIn: int
    note: str


class X402VerifyRequest(BaseModel):
    resource: str = Field(..., min_length=1, max_length=512)
    proof: dict[str, Any] = Field(default_factory=dict,
                                  description="Mock settlement proof (stub only)")


class X402VerifyResponse(BaseModel):
    settled: bool
    note: str


# --- Misc ---------------------------------------------------------------------
class HealthResponse(BaseModel):
    status: str
    version: str
    time: str


class NoticeItem(BaseModel):
    id: str
    severity: str  # info | warning | critical
    title: str
    body: str
    publishedAt: str
    bundleIds: list[str] = Field(default_factory=list)
