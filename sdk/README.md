# @cryptostoner/sdk

Client-side TypeScript SDK for the Unified Public-Data API product.

*All data is officially sourced from the platforms' own public endpoints — our catalog mirrors the source truthfully. We sell convenience: one bundle, one interface, one bill.*

## What this is

A TypeScript SDK that bundles **public** endpoints into normalized, typed per-category **bundles**.
Data calls go **direct from the end user's machine to the public endpoints** — no server proxy for
public data. Platform rate limits therefore stay **per-user-IP**, exactly as if the user went direct.

We sell **curation, normalization, types, and docs** — not the data. Metering is per-use via a
lightweight license-key validation + usage heartbeat to our server. The heavy data never touches
our infrastructure.

**Phase 1 scope** (this package): crypto bundles (`mev`, `resolver`, `cex`, `dex`, `wallet`) +
enterprise bundles (`filings`, `macro`, `patents`, `registries`). Travel, weather, maps, news, and
sports bundles are **roadmap** — not implemented here.

## Install

```bash
npm install @cryptostoner/sdk
```

Requires Node 18+ (or any runtime with `fetch`; `WebSocket` only needed for streaming).

## Quickstart

```ts
import { UnifiedDataSDK } from "@cryptostoner/sdk";

const sdk = await UnifiedDataSDK.create({
  licenseKey: process.env.UNIFIED_DATA_LICENSE_KEY!,
  contactEmail: "you@example.com", // embedded in the User-Agent (SEC requires name + contact)
});

// CEX klines (Binance, keyless)
const candles = await sdk.crypto.cex.klines({ venue: "binance", symbol: "BTCUSDT", interval: "1h" });
console.log(candles[0].close, candles[0].freshness); // 104, "LIVE"

// Every result carries provenance:
const q = await sdk.crypto.cex.ticker({ venue: "kraken", symbol: "XBTUSD" });
// q = { symbol, price, timestamp, source: "kraken", fetchedAt, freshness: "LIVE" }

// SEC filings (keyless)
const filings = await sdk.enterprise.filings.submissions({ cik: "320193", form: "10-K" });

// GATED sources take the END USER's key at bundle init — never ours:
const sdk2 = await UnifiedDataSDK.create({
  licenseKey: "...",
  dex: { coinGeckoApiKey: "USER'S OWN coingecko demo key", etherscanApiKey: "USER'S OWN etherscan key" },
  resolver: { oneInchApiKey: "USER'S OWN 1inch key", theGraphApiKey: "USER'S OWN graph key" },
  macro: { fredApiKey: "USER'S OWN fred key" },
  patents: { usptoApiKey: "USER'S OWN uspto key", tsdrApiKey: "USER'S OWN tsdr key" },
  registries: { companiesHouseApiKey: "USER'S OWN key", openCorporatesToken: "USER'S OWN token", epoAccessToken: "USER'S OWN token" },
});

await sdk.shutdown(); // stop heartbeat, flush final beat
```

## Per-bundle usage

### Crypto

```ts
// MEV — mempool, relay data (all keyless)
await sdk.crypto.mev.feeEstimates();                    // sat/vB fee tiers
await sdk.crypto.mev.mempoolStats();                    // backlog + tip height
await sdk.crypto.mev.recentTxs(25);                     // pending transactions
await sdk.crypto.mev.relayBids(100);                    // Flashbots proposer payloads
await sdk.crypto.mev.relayBids(100, { relayBaseUrl: "https://relay.ultrasound.money" });
await sdk.crypto.mev.builderBlocks(100);                // builder blocks received
const stream = sdk.crypto.mev.streamUnconfirmedTxs();   // blockchain.info WS
stream.on("message", (e) => console.log(e.data));
stream.connect();

// Resolver — quotes, order books (1inch + The Graph are GATED)
await sdk.crypto.resolver.orderBook({ venue: "binance", symbol: "BTCUSDT", limit: 100 });
await sdk.crypto.resolver.orderBook({ venue: "kraken", symbol: "XBTUSD" });
await sdk2.crypto.resolver.oneInchQuote({ chain: 1, src: "0x...", dst: "0x...", amount: "1000000" });
await sdk2.crypto.resolver.subgraphQuery({ subgraphId: "Qm...", query: "{ pairs(first: 5) { id } }" });

// CEX — klines, tickers, trades (Binance + Kraken, keyless)
// NOTE: Coinbase Exchange is EXCLUDED (its Market Data ToS forbids redistribution).
await sdk.crypto.cex.klines({ venue: "binance", symbol: "BTCUSDT", interval: "1h", limit: 100 });
await sdk.crypto.cex.ticker({ venue: "kraken", symbol: "XBTUSD" });
await sdk.crypto.cex.recentTrades({ venue: "binance", symbol: "BTCUSDT", limit: 50 });
const trades = sdk.crypto.cex.streamTrades({ venue: "binance", symbol: "BTCUSDT" }); // WS, ping every 20s
trades.connect();

// DEX/token — pairs, prices
// NOTE: Solscan is EXCLUDED (no verifiable free tier). DEX Screener's no-compete
// clause needs legal review before commercial shipping (see spec §2.1).
await sdk.crypto.dex.tokenPairs({ addresses: ["0x..."] });       // DEX Screener
await sdk.crypto.dex.searchPairs({ q: "pepe" });                 // DEX Screener
await sdk.crypto.dex.trendingPools({ network: "eth" });          // GeckoTerminal
await sdk.crypto.dex.tokenPrices({ network: "eth", addresses: ["0x..."] });
await sdk2.crypto.dex.simplePrice({ ids: ["bitcoin"] });          // CoinGecko (GATED)
await sdk2.crypto.dex.ethPrice({ chainId: 1 });                   // Etherscan (GATED)

// Wallet — address data (keyless-first; no bundled label datasets in v1)
await sdk.crypto.wallet.addressInfo({ address: "bc1q..." });     // mempool.space
await sdk.crypto.wallet.addressTxs({ address: "bc1q..." });
await sdk.crypto.wallet.addressUtxos({ address: "bc1q..." });
await sdk.crypto.wallet.blockchainInfoAddress({ address: "bc1q..." });
```

### Enterprise

```ts
// SEC EDGAR filings & XBRL (keyless; descriptive User-Agent + ≤10 req/s handled)
await sdk.enterprise.filings.companyTickers();                       // ticker → CIK directory
await sdk.enterprise.filings.submissions({ cik: "320193", form: "10-K" });
await sdk.enterprise.filings.companyFacts({ cik: "320193", concept: "us-gaap.Revenues" });
await sdk.enterprise.filings.companyConcept({ cik: "320193", tag: "Revenues" });

// Macro: BLS (keyless v1), Census (keyless), FRED (GATED)
await sdk.enterprise.macro.blsSeries({ seriesIds: ["CUUR0000SA0"], startYear: "2024", endYear: "2024" });
await sdk.enterprise.macro.censusQuery({ year: "2023", dataset: "acs/acs5", get: ["NAME", "B19013_001E"], forClause: "state:*" });
await sdk2.enterprise.macro.fredObservations({ seriesId: "GDP" });

// Patents & trademarks (both GATED — end user's own USPTO keys)
await sdk2.enterprise.patents.searchPatents({ query: "semiconductor packaging" });
await sdk2.enterprise.patents.trademarkStatus({ serialNumber: "88442211" });

// Registries: GLEIF is keyless (CC0); Companies House / OpenCorporates / EPO are GATED
await sdk.enterprise.registries.leiRecord({ lei: "984500ABCDEF..." });
await sdk.enterprise.registries.leiSearch({ name: "Acme" });
await sdk2.enterprise.registries.ukCompany({ companyNumber: "12345678" });
await sdk2.enterprise.registries.openCorporatesSearch({ q: "acme", jurisdictionCode: "gb" });
await sdk2.enterprise.registries.epoSearch({ q: "widget" });
```

## Freshness labels (§7)

Every normalized result carries `source`, `fetchedAt`, and `freshness`:

| Label | Meaning |
|---|---|
| `LIVE` | Fetched on demand from the upstream in this call (or pushed via a healthy WebSocket subscription). |
| `CACHED` | Served from the SDK cache — `fetchedAt` tells exactly how old it is. |
| `ESTIMATE` | Derived/indicative value, never a firm quote. Never display as a price without the label. |

**Rule: a price must never be presented as live when it is cached.** `formatPrice()` renders the
freshness label by default; hiding it requires the explicit opt-out:

```ts
import { formatPrice } from "@cryptostoner/sdk";
formatPrice(67000.5, { currency: "$", freshness: q.freshness }); // "$67,000.50 (LIVE)"
formatPrice(67000.5, { freshness: "CACHED", hideFreshness: true }); // explicit opt-out
```

### `maxAge` — developer-enforced freshness

Every bundle read accepts `maxAge` (seconds, or `Infinity`). Defaults: **prices 120s, feeds 900s,
reference 7d**. If no result satisfies `maxAge`, the SDK throws `StaleData` (with `lastFetchedAt`
and `oldestAcceptable`) instead of silently returning old data:

```ts
const q = await sdk.crypto.cex.ticker({ venue: "binance", symbol: "BTCUSDT" }, { maxAge: 60 });
// throws StaleData when no quote ≤60s old can be produced
```

Notes on defaults: wallet account-state reads use 300s (documented choice between price and feed);
macro/registry/patent data defaults to 1d revalidation (macro series are cached until the next
scheduled release, labeled CACHED); SEC company tickers default to 7d.

## Heartbeat privacy

Metering works **without proxying**: the only traffic to our servers is

1. `POST /v1/license/verify` once per init (result cached 24h; the SDK keeps working offline with
   a cached valid license for a **7-day grace period**, so airplane-mode apps don't break), and
2. a tiny heartbeat every **15 minutes or every 1,000 bundle calls** (whichever first).

The heartbeat payload is exactly:

```json
{ "licenseKeyHash": "<sha256 of key>", "bundleIds": { "crypto.cex": 842 }, "sdkVersion": "0.1.0", "platform": "node/linux-x64" }
```

**Never sent:** query parameters, symbols, addresses, locations, or any other user data — per-bundle
call **counts** only, aggregated. The raw license key is never transmitted (only its SHA-256 hash).
This is the core trust contract of the product.

The default license base URL (`https://license.unified-data.dev`) is a **placeholder** — no
production licensing server exists yet. Override via `licenseBaseUrl` when one is deployed.

## Errors

One taxonomy, matched on `err.code`:

`UpstreamRateLimited` (has `retryAfterMs`) · `UpstreamDeprecated` · `UpstreamSchemaDrift`
· `UpstreamAuthRequired` (GATED source without the end user's key) · `NetworkError`
· `LicenseInvalid` · `BundleNotLicensed` · `StaleData` (has `lastFetchedAt`, `oldestAcceptable`)

Retries use exponential backoff + jitter, honor `Retry-After` and 429s, and never retry
auth/license/deprecation/drift errors.

## Access tiers

- **KEYLESS** — works out of the box (mempool.space, Binance, Kraken, DEX Screener,
  GeckoTerminal, SEC EDGAR, BLS v1, Census, GLEIF, …).
- **GATED** — the *end user* supplies their own key at bundle init and accepts that provider's
  ToS themselves: 1inch, CoinGecko (Demo), Etherscan, The Graph, FRED, USPTO ODP/TSDR,
  UK Companies House, OpenCorporates, EPO OPS. **We never bundle a key.**
- **EXCLUDED** — deliberately not implemented: Coinbase Exchange (Market Data ToS forbids
  redistribution), Solscan (no verifiable free tier), Yahoo Finance (no official API; ToS
  prohibits automated access), ESPN unofficial API (unlicensed). A test fails the build if any
  of these hosts appear in `src/`.

## Roadmap (not in Phase 1)

Travel & bookings, weather & maps, finance (stocks/FX beyond FRED), sports, news & reference,
and the feed-type layer (RSS/GTFS/WS streams/datasets/iCal adapters exist — bundles pending).
See the product spec for the phased rollout.

## Development

```bash
npm install        # from build/sdk (workspace root)
npm test           # vitest, fully mocked/offline
npm run typecheck  # tsc --noEmit
npm run build      # emit dist/
```
