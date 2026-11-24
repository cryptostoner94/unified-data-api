"""Unified Public-Data API — licensing & metering backend (spec §3.3, §4).

Responsibilities: license validation, usage heartbeat ingestion, quota
enforcement, server->SDK notices, x402 metering STUB.

Deliberately NOT in scope: proxying public data (data calls go direct from
the end user's machine), any outbound network calls from this process.

Privacy: raw license keys are NEVER logged, stored, or returned. Incoming keys
are hashed with SHA-256 at the boundary and only the hash / a 12-char
fingerprint is used afterwards.
"""

from __future__ import annotations

import hashlib
import logging
from datetime import datetime, timezone

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse

from app import notices
from app.config import (
    BUNDLE_IDS,
    PLANS,
    LicenseEntry,
    Settings,
    get_settings,
    load_license_keys,
)
from app.db import UsageStore
from app.schemas import (
    HealthResponse,
    HeartbeatRequest,
    HeartbeatResponse,
    LicenseVerifyRequest,
    LicenseVerifyResponse,
    NoticeItem,
    X402VerifyRequest,
)
from app import x402 as x402_stub

APP_VERSION = "0.1.0"

log = logging.getLogger("data-api")


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _parse_expiry(iso: str | None) -> datetime | None:
    if not iso:
        return None
    return datetime.fromisoformat(str(iso).replace("Z", "+00:00"))


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    store = load_license_keys()
    usage = UsageStore(database_url=settings.database_url, sqlite_path=settings.sqlite_path)

    # The OpenAPI routes stay off a public listener: they publish the full
    # route schema of the licensing service. They are available in local dev
    # only, next to the plaintext transport opt-in.
    expose_docs = settings.allow_insecure_transport
    app = FastAPI(
        title="Unified Public-Data API — Licensing & Metering",
        version=APP_VERSION,
        docs_url="/docs" if expose_docs else None,
        redoc_url=None,
        openapi_url="/openapi.json" if expose_docs else None,
    )

    # ------------------------------------------------------------- transport
    def _is_tls(request: Request) -> bool:
        """True when the request reached us over TLS.

        uvicorn runs behind the local nginx proxy (loopback only) with
        --proxy-headers, so it normally rewrites the scheme from
        X-Forwarded-Proto before the app sees the request. The header is read
        again here only when the connection comes from the loopback peer.
        """
        if request.url.scheme == "https":
            return True
        peer = request.client.host if request.client else ""
        forwarded = request.headers.get("x-forwarded-proto", "").split(",")[0].strip().lower()
        return forwarded == "https" and peer in {"127.0.0.1", "::1"}

    def _require_tls(request: Request) -> None:
        """Refuse a credential-bearing route outside TLS.

        /v1/license/verify receives the raw license key, and the heartbeat hash
        is the metering credential. Over plaintext both are readable by anyone
        on the network path, so a non-dev deployment must fail closed here.
        """
        if settings.allow_insecure_transport or _is_tls(request):
            return
        log.warning("transport rejected: %s path=%s requires https", request.method, request.url.path)
        raise HTTPException(
            status_code=403,
            detail={
                "error": "https_required",
                "message": "License traffic must use HTTPS.",
            },
        )

    # ------------------------------------------------------------------ health
    @app.get("/v1/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        return HealthResponse(status="ok", version=APP_VERSION, time=_now_utc().isoformat())

    # ------------------------------------------------------------------ tiers
    @app.get("/v1/tiers")
    def tiers() -> dict:
        """Pricing tiers per spec §4.2. Prices are 'TBD — set by owner'."""
        return {
            "tiers": [
                {
                    "id": p.id,
                    "name": p.name,
                    "priceMonthly": p.price_monthly,
                    "description": p.description,
                    "dailyBundleCallQuota": p.daily_quota,
                }
                for p in PLANS.values()
            ]
        }

    # ------------------------------------------------- license verification
    def _expiry_notice(entry: LicenseEntry) -> str | None:
        expiry = _parse_expiry(entry.expires_at)
        if expiry is None:
            return None
        days_left = (expiry - _now_utc()).days
        if days_left < 0:
            return "License expired. Renew to restore service."
        if days_left <= 7:
            return f"License expires in {days_left} day(s) on {entry.expires_at}. Renew to avoid interruption."
        return None

    @app.post("/v1/license/verify", response_model=LicenseVerifyResponse)
    def license_verify(body: LicenseVerifyRequest, request: Request) -> LicenseVerifyResponse:
        _require_tls(request)
        # Hash FIRST — the raw key must never reach a log line, store, or response.
        key_hash = sha256_hex(body.licenseKey)
        fingerprint = key_hash[:12]
        # Wipe the local reference to the raw key as early as possible.
        del body

        entry = store.get(key_hash)
        if entry is None:
            log.info("license.verify denied: unknown key fp=%s", fingerprint)
            return LicenseVerifyResponse(valid=False, notice="Unknown license key.")

        expiry = _parse_expiry(entry.expires_at)
        if expiry is not None and _now_utc() > expiry:
            log.info("license.verify denied: expired key fp=%s plan=%s", fingerprint, entry.plan)
            return LicenseVerifyResponse(valid=False, plan=entry.plan, bundles=list(entry.bundles),
                                         expiresAt=entry.expires_at,
                                         notice="License expired. Renew to restore service.")

        plan = PLANS[entry.plan]
        log.info("license.verify ok: fp=%s plan=%s", fingerprint, plan.id)
        return LicenseVerifyResponse(
            valid=True,
            plan=plan.id,
            bundles=list(entry.bundles),
            expiresAt=entry.expires_at,
            notice=_expiry_notice(entry),
        )

    # ------------------------------------------------------------ heartbeat
    @app.post("/v1/heartbeat", response_model=HeartbeatResponse)
    @app.post("/v1/license/heartbeat", response_model=HeartbeatResponse, include_in_schema=False)
    def heartbeat(body: HeartbeatRequest, request: Request) -> HeartbeatResponse:
        _require_tls(request)
        key_hash = body.licenseKeyHash  # already a hash — safe to log
        fingerprint = key_hash[:12]

        entry = store.get(key_hash)
        if entry is None:
            log.info("heartbeat rejected: unknown key hash fp=%s", fingerprint)
            return HeartbeatResponse(ok=False, notice="Unknown license key hash.")

        expiry = _parse_expiry(entry.expires_at)
        if expiry is not None and _now_utc() > expiry:
            log.info("heartbeat rejected: expired key fp=%s", fingerprint)
            return HeartbeatResponse(ok=False, notice="License expired. Renew to restore service.")

        # Strict bundle-id validation — fail closed on anything unknown.
        unknown = [b for b in body.bundleIds if b not in BUNDLE_IDS]
        if unknown:
            log.info("heartbeat rejected: unknown bundle ids=%r fp=%s", unknown, fingerprint)
            raise HTTPException(status_code=422, detail={"error": "unknown_bundle_ids", "bundles": unknown})

        max_count = settings.heartbeat_max_count_per_bundle
        absurd = [b for b, n in body.bundleIds.items() if n > max_count]
        if absurd:
            log.info("heartbeat rejected: implausible counts fp=%s", fingerprint)
            raise HTTPException(status_code=422, detail={"error": "implausible_count", "bundles": absurd})

        unlicensed = [b for b in body.bundleIds if b not in entry.bundles]

        today = _now_utc().date()
        try:
            usage.add_counts(key_hash, dict(body.bundleIds), today)
            total_today = usage.daily_total(key_hash, today)
        except Exception:
            # Fail closed on storage errors: do not report ok.
            log.exception("heartbeat storage failure fp=%s", fingerprint)
            return HeartbeatResponse(ok=False, notice="Usage could not be recorded; retry shortly.")

        plan = PLANS[entry.plan]
        if total_today > plan.daily_quota:
            log.info("heartbeat downgrade: fp=%s plan=%s total=%d quota=%d",
                     fingerprint, plan.id, total_today, plan.daily_quota)
            return HeartbeatResponse(
                ok=True,
                downgrade=True,
                notice=(f"Daily bundle-call quota exceeded ({total_today} > {plan.daily_quota}). "
                        "Paid bundles disabled until renewal/quota reset."),
            )

        notice_text: str | None = None
        if unlicensed:
            notice_text = (f"Bundles not covered by your plan and not metered as licensed: "
                           f"{', '.join(sorted(unlicensed))}.")
        else:
            recent = [n for n in notices.list_notices()
                      if (_now_utc() - datetime.fromisoformat(n["publishedAt"])).days <= 7]
            if recent and plan.id != "free":
                latest = recent[-1]
                notice_text = f"[{latest['severity']}] {latest['title']}"

        log.info("heartbeat ok: fp=%s plan=%s total_today=%d", fingerprint, plan.id, total_today)
        return HeartbeatResponse(ok=True, notice=notice_text)

    # ---------------------------------------------------------------- notices
    @app.get("/v1/notice")
    def get_notices() -> dict:
        """Server -> SDK notices (spec §5): docs-watcher deprecation alerts, etc."""
        return {"notices": [NoticeItem(**n).model_dump() for n in notices.list_notices()]}

    # ------------------------------------------------- x402 metering (STUB)
    @app.get("/v1/x402/challenge")
    def x402_challenge(resource: str = Query(..., min_length=1, max_length=512)) -> dict:
        """Return a 402-style payment challenge payload. STUB ONLY — see app/x402.py."""
        return x402_stub.build_challenge(resource).model_dump()

    @app.post("/v1/x402/verify")
    def x402_verify(body: X402VerifyRequest) -> dict:
        """Verify a (mock) settlement proof. STUB ONLY — always settles without
        any chain or facilitator interaction. See app/x402.py."""
        return x402_stub.verify_stub_proof(body).model_dump()

    @app.on_event("shutdown")  # noqa: deprecated — kept for simplicity in the stub
    def _shutdown() -> None:
        usage.close()

    return app


def _boot() -> FastAPI:
    _configure_logging()
    return create_app()


def _configure_logging() -> None:
    level = getattr(logging, __import__("os").environ.get("LOG_LEVEL", "INFO").upper(), logging.INFO)
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
        force=True,
    )


# Uvicorn entry point: `uvicorn app.main:app`
app = _boot()
