"""Configuration for the licensing/metering backend.

Fail-closed: anything missing or malformed in env config degrades to DENY,
never to ALLOW. No secrets are committed — only `.env.example` placeholders.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone

log = logging.getLogger(__name__)

# --- Bundle catalog -----------------------------------------------------------
# Bundle ids mirror the SDK surface from the product spec (§2 / §3.1).
# This list is the server-side allow-list for heartbeat bundleIds.
BUNDLE_IDS: tuple[str, ...] = (
    # Crypto (§2.1)
    "crypto.mev", "crypto.resolver", "crypto.cex", "crypto.dex", "crypto.wallet",
    # Enterprise (§2.2)
    "enterprise.filings", "enterprise.macro", "enterprise.patents", "enterprise.registries",
    # Travel (§2.3)
    "travel.flights", "travel.hotels", "travel.restaurants",
    # Weather & maps (§2.4)
    "weather.forecast", "weather.alerts",
    "maps.geocode", "maps.places",
    # Finance (§2.5)
    "finance.stocks", "finance.fx", "finance.macro",
    # Sports, news, misc (§2.6)
    "sports.scores", "sports.fixtures",
    "news.headlines", "news.events",
    # Feed-type sources (§2.7)
    "feeds.earthquakes", "feeds.cve", "feeds.status", "feeds.transit", "feeds.holidays",
)

# --- Plans / pricing tiers (spec §4.2) ----------------------------------------
# Prices are deliberately NOT invented: they are "TBD — set by owner".
@dataclass(frozen=True)
class Plan:
    id: str
    name: str
    price_monthly: str  # "TBD — set by owner"
    description: str
    daily_quota: int    # max heartbeat-counted bundle calls per UTC day


def _quota(env_name: str, default: int) -> int:
    raw = os.environ.get(env_name)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = int(raw)
    except ValueError:
        log.warning("Invalid %s=%r; falling back to default %d", env_name, raw, default)
        return default
    if value < 0:
        log.warning("Negative %s=%r; falling back to default %d", env_name, raw, default)
        return default
    return value


PLANS: dict[str, Plan] = {
    "free": Plan(
        id="free",
        name="Free",
        price_monthly="TBD — set by owner",
        description="Keyless bundles, heartbeat-metered; enough to build and ship a side project. Community support.",
        daily_quota=_quota("QUOTA_FREE", 10_000),
    ),
    "builder": Plan(
        id="builder",
        name="Builder",
        price_monthly="TBD — set by owner",
        description="All keyless + free-key bundles, higher heartbeat quota, docs-watcher alerts, email support.",
        daily_quota=_quota("QUOTA_BUILDER", 250_000),
    ),
    "pro": Plan(
        id="pro",
        name="Pro",
        price_monthly="TBD — set by owner",
        description="Everything + GATED-bundle helpers (user brings own keys), approval-tier onboarding assistance, SLA on SDK fixes.",
        daily_quota=_quota("QUOTA_PRO", 2_000_000),
    ),
    "enterprise": Plan(
        id="enterprise",
        name="Enterprise",
        price_monthly="TBD — set by owner",
        description="Pooled paid upstream keys via the x402 proxy, custom bundles, SLA.",
        daily_quota=_quota("QUOTA_ENTERPRISE", 50_000_000),
    ),
}

PLAN_IDS = tuple(PLANS)


# --- License-key store --------------------------------------------------------
@dataclass
class LicenseEntry:
    """A license-key record. The RAW key is discarded after hashing at load time."""
    key_hash: str          # sha256 hex of the raw key
    fingerprint: str       # first 12 hex chars — safe for logs
    plan: str
    bundles: tuple[str, ...]
    expires_at: str | None  # ISO-8601; None = no expiry
    label: str = ""        # human label for the key; never the key itself


def load_license_keys() -> dict[str, LicenseEntry]:
    """Build the in-memory license store from the LICENSE_KEYS env var.

    LICENSE_KEYS is a JSON object: { "<raw-key>": {"plan": "...", "bundles": [...],
    "expiresAt": "...", "label": "..."} }.
    Raw keys are hashed with SHA-256 immediately and discarded; only hashes and
    fingerprints remain in memory. Malformed input -> fail closed (empty store).
    """
    raw = os.environ.get("LICENSE_KEYS")
    if not raw:
        log.warning("LICENSE_KEYS not set — license store is EMPTY; all keys will verify as invalid (fail closed).")
        return {}
    try:
        import hashlib

        data = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        log.error("LICENSE_KEYS is not valid JSON (%s) — license store is EMPTY (fail closed).", exc)
        return {}
    if not isinstance(data, dict):
        log.error("LICENSE_KEYS must be a JSON object — license store is EMPTY (fail closed).")
        return {}

    import hashlib

    store: dict[str, LicenseEntry] = {}
    for raw_key, meta in data.items():
        if not isinstance(raw_key, str) or not raw_key or not isinstance(meta, dict):
            log.warning("Skipping malformed LICENSE_KEYS entry (not a key->object pair).")
            continue
        plan = meta.get("plan")
        if plan not in PLANS:
            log.warning("Skipping license entry with unknown plan %r.", plan)
            continue
        bundles = meta.get("bundles", [])
        if not isinstance(bundles, list) or not all(isinstance(b, str) for b in bundles):
            log.warning("Skipping license entry with malformed bundles list.")
            continue
        unknown = [b for b in bundles if b not in BUNDLE_IDS]
        if unknown:
            log.warning("Skipping license entry with unknown bundle ids %r.", unknown)
            continue
        expires_at = meta.get("expiresAt")
        if expires_at is not None:
            try:
                datetime.fromisoformat(str(expires_at).replace("Z", "+00:00"))
            except ValueError:
                log.warning("Skipping license entry with malformed expiresAt %r.", expires_at)
                continue
        key_hash = hashlib.sha256(raw_key.encode("utf-8")).hexdigest()
        store[key_hash] = LicenseEntry(
            key_hash=key_hash,
            fingerprint=key_hash[:12],
            plan=plan,
            bundles=tuple(bundles),
            expires_at=expires_at,
            label=str(meta.get("label", "")),
        )
        # raw_key drops out of scope here — never retained, never logged.
    log.info("License store loaded: %d valid key(s).", len(store))
    return store


# --- Runtime settings ----------------------------------------------------------
@dataclass
class Settings:
    database_url: str = ""                      # empty -> SQLite at SQLITE_PATH
    sqlite_path: str = field(default_factory=lambda: os.environ.get("SQLITE_PATH", "data/metering.db"))
    heartbeat_max_bundles: int = 50             # hard cap on bundleIds entries per heartbeat
    heartbeat_max_count_per_bundle: int = 10_000_000
    log_level: str = field(default_factory=lambda: os.environ.get("LOG_LEVEL", "INFO"))


def get_settings() -> Settings:
    return Settings(database_url=os.environ.get("DATABASE_URL", ""))
