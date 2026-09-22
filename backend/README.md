# Unified Public-Data API — Licensing & Metering Backend

Server-side component of the Unified Public-Data API product (goal `goal_d01926e1b6ea`),
implementing the product spec's **§3.3 (license validation + heartbeat)** and **§4 (billing/metering)**.

> *All data is officially sourced from the platforms' own public endpoints — our catalog mirrors the source truthfully. We sell convenience: one bundle, one interface, one bill.*

## What this server does (and does not do)

- **Does:** validate license keys, ingest usage heartbeats, enforce plan quotas,
  push server→SDK notices (docs-watcher alerts), and expose an x402 **metering stub**.
- **Does NOT:** proxy public data. Per the product model, data calls go direct from the
  end user's machine to the platforms' public endpoints — this server only ever sees
  license keys and aggregated per-bundle call counts. It makes **no outbound network calls**.

## Privacy contract

- The heartbeat carries **counts only** — `{ "crypto.cex": 842 }` — never query parameters,
  symbols, addresses, locations, or any user data.
- Raw license keys are **never logged, stored, or returned**. They are hashed with SHA-256
  at the request boundary and at startup (env config); only hashes and 12-char fingerprints
  exist in memory. The test suite asserts this (`tests/test_no_key_logging.py`).

## Quick start

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# Configure (fail-closed: missing/malformed LICENSE_KEYS -> every key invalid)
cp .env.example .env   # then fill in LICENSE_KEYS in .env

uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Interactive docs: `http://localhost:8000/docs`

## API

| Method & path | Body / params | Response |
|---|---|---|
| `POST /v1/license/verify` | `{ "licenseKey": "..." }` | `{ valid, plan, bundles[], expiresAt, notice? }` |
| `POST /v1/heartbeat` | `{ licenseKeyHash, bundleIds: {bundle: count}, sdkVersion, platform }` | `{ ok, downgrade?, notice? }` |
| `GET /v1/health` | — | `{ status, version, time }` |
| `GET /v1/notice` | — | `{ notices: [...] }` (server→SDK notices) |
| `GET /v1/tiers` | — | pricing tiers (prices: **TBD — set by owner**) |
| `GET /v1/x402/challenge?resource=...` | — | **STUB** 402-style payment challenge (placeholder payTo/facilitator) |
| `POST /v1/x402/verify` | `{ resource, proof }` | **STUB** `{ settled: true }` — mock proof accepted, nothing verified |

### Heartbeat semantics

- `licenseKeyHash` is the SHA-256 hex of the license key (computed SDK-side; the raw key never leaves the client in heartbeat traffic).
- `bundleIds` keys must be known bundle ids (e.g. `crypto.cex`, `weather.forecast`) — unknown ids are rejected with 422. Counts must be non-negative integers.
- Aggregates persist to SQLite (`SQLITE_PATH`, default `data/metering.db`) or Postgres when `DATABASE_URL` is set (requires `psycopg`).
- Plan quotas are per UTC day (Free: 10,000; Builder/Pro/Enterprise configurable via `QUOTA_*` env, generous defaults). Over quota → `{ ok: true, downgrade: true }`; the SDK disables paid bundles until renewal/quota reset.
- Expired or unknown keys → `valid: false` / `{ ok: false }`. **Fail closed everywhere.**

### x402 stub (spec §4.1) — read this before wiring real payments

`GET /v1/x402/challenge` and `POST /v1/x402/verify` are **development stubs only**:
- challenge returns fake `payTo` (burn address) and a fake `.invalid` facilitator URL;
- verify accepts any well-formed mock proof and always answers `{ settled: true }`;
- **no real charges, no real chain calls, no facilitator interaction.**

Wire real x402 settlement (facilitator verification) before any production metering depends on these endpoints. The stub contract is pinned by `tests/test_x402.py` (stub markers must be present in every response).

## Configuration (env)

| Var | Purpose | Default |
|---|---|---|
| `LICENSE_KEYS` | JSON map of raw key → `{plan, bundles[], expiresAt?, label?}` | unset → **all keys invalid (fail closed)** |
| `QUOTA_FREE` / `QUOTA_BUILDER` / `QUOTA_PRO` / `QUOTA_ENTERPRISE` | daily bundle-call quotas | 10,000 / 250,000 / 2,000,000 / 50,000,000 |
| `DATABASE_URL` | Postgres DSN (optional; needs `psycopg`) | unset → SQLite |
| `SQLITE_PATH` | SQLite file path | `data/metering.db` |
| `LOG_LEVEL` | log verbosity | `INFO` |

See `.env.example` for a commented template. **Never commit a filled `.env`.**

## Docker

```bash
cp .env.example .env   # fill in LICENSE_KEYS (+ POSTGRES_PASSWORD if using Postgres)
docker compose up --build
```

API on `http://localhost:8000`. SQLite persists in the `api-data` volume by default;
uncomment `DATABASE_URL` in compose to switch to Postgres (set `POSTGRES_PASSWORD`).

## Tests

Fully mocked/offline — no network, no secrets:

```bash
.venv/bin/python -m pytest tests/ -q
```

35 tests: license verify (valid/invalid/unknown/expired/malformed), heartbeat shape
validation + unknown-bundle rejection + quota enforcement + persistence,
x402 stub flows, no-raw-key-logging assertions (log capture), health/notice/tiers.

## Layout

```
app/
  main.py      # FastAPI app, endpoints, fail-closed wiring
  config.py    # plans/tiers, bundle catalog, LICENSE_KEYS loading (hash at startup)
  schemas.py   # strict Pydantic request/response models
  db.py        # SQLite usage aggregates (+ optional Postgres via DATABASE_URL)
  notices.py   # server->SDK notices (seeded example)
  x402.py      # x402 metering STUB (no real payments — see module docstring)
tests/         # offline pytest suite
Dockerfile
docker-compose.yml   # api + postgres (later deploy)
.env.example
```
