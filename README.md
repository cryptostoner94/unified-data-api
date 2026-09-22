# Unified Public-Data API

*All data is officially sourced from the platforms' own public endpoints — our catalog mirrors the source truthfully. We sell convenience: **one bundle, one interface, one bill**, instead of hunting across platforms.*

A client-side SDK that bundles public endpoints into normalized, typed per-category **bundles**.
Data calls go **direct from the end user's machine to the public endpoints** — no server proxy
for public data. Platform rate limits therefore stay **per-user-IP**, exactly as if the user
went direct.

We sell **curation, normalization, types, and docs** — not the data. Metering is per-use via a
lightweight license-key validation + usage heartbeat to our server. The heavy data never touches
our infrastructure.

## Repo layout

| Directory | What it is |
|---|---|
| [`sdk/`](sdk/) | `@cryptostoner/sdk` — TypeScript monorepo: core transport, normalized schemas, freshness labels (`LIVE`/`CACHED`/`ESTIMATE`), `StaleData`/`maxAge`, license + heartbeat client, feed adapters, Phase-1 bundles |
| [`backend/`](backend/) | FastAPI licensing/metering server: `POST /v1/license/verify`, `POST /v1/heartbeat`, x402 metering stub, tier config; Dockerfile + docker-compose |
| [`docs-watcher/`](docs-watcher/) | Scheduled upstream monitor: liveness, docs-hash changes, schema drift, deprecation headers, feed staleness — 24-endpoint Phase-1 registry |
| [`landing/`](landing/) | Single-page marketing site (no build step) |

## Phase 1 scope (live in this repo)

- **Crypto pilot:** MEV (mempool.space, relay data), Resolver (1inch/The Graph — user brings key), CEX market data (Binance, Kraken), DEX/token (DEX Screener, GeckoTerminal), Wallet/labels
- **Enterprise:** SEC EDGAR filings + XBRL, BLS, US Census, FRED, USPTO patents + trademarks, UK Companies House, GLEIF LEI, OpenCorporates, EPO patents

Later phases (travel, weather, maps, news, sports) are roadmap — see the design spec.

## Quickstart

```bash
npm install @cryptostoner/sdk   # v0.1.0 published — or use source
```

```ts
import { UnifiedData } from "@cryptostoner/sdk";
const sdk = new UnifiedData({ licenseKey: "YOUR-LICENSE-KEY" });
const q = await sdk.crypto.cex.quote("BTCUSDT", { maxAge: 60 });
console.log(q.price, q.freshness, q.source); // price is never shown as live when cached
```

## Deploy (user's server)

One-shot, idempotent — run as root on the target Ubuntu server. It installs
Node 20 (if missing), clones/pulls to `/opt/unified-data-api`, runs `npm ci`,
builds, runs the full offline test suite, and installs + enables systemd units
for the API backend, the docs-watcher (daily full + hourly Tier-0 timers), and
the landing page (nginx if present, else a static fallback).

```bash
curl -fsSL https://raw.githubusercontent.com/cryptostoner94/unified-data-api/main/deploy.sh | sudo bash
```

Secrets come from `/opt/unified-data-api/.env`, created from
`backend/.env.example` on first run only — fill in real values afterwards, then
`systemctl restart unified-api`. To also publish `@cryptostoner/sdk` to npm
during deploy: `export NPM_TOKEN=<token>` before running (read from the
environment only, never written to disk).

## Honesty notes

- Keyless public data stays direct and unmetered at the data layer; we meter at the license/bundle layer via heartbeat counts only — never queries, symbols, addresses, or locations.
- GATED sources require the **end user's own key** (never bundled). EXCLUDED sources (per their ToS) are not implemented — see the design spec appendix.
- Freshness: every result carries `source`, `fetchedAt`, and `freshness`. A cached price displayed as live is treated as a defect.
- No secrets are committed to this repo. Ever. (`.env.example` files contain placeholders only.)

## License

MIT
