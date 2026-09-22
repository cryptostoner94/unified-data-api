/**
 * DEX/token bundle (`crypto.dex`) — prices, pairs, token metadata.
 *
 * Sources:
 *   - DEX Screener   https://api.dexscreener.com            KEYLESS
 *     (commercial use permitted BUT the no-compete clause needs legal review
 *     before shipping — see spec §2.1)
 *   - GeckoTerminal  https://api.geckoterminal.com/api/v2   KEYLESS
 *   - CoinGecko      https://api.coingecko.com/api/v3       GATED (end user's own
 *     Demo key via `x-cg-demo-api-key`; Demo = attribution required, no commercial license)
 *   - Etherscan V2   https://api.etherscan.io/v2/api        GATED (end user's own free key;
 *     ToS bans commercial use without prior written permission — never bundle our key)
 *
 * NOTE — Solscan is EXCLUDED (spec §2.1: no verifiable free tier, paid-only).
 * It is not implemented here, on purpose.
 */
import { BundleBase, type BundleSharedOptions } from "../base.js";
import { UpstreamAuthRequired } from "../../core/errors.js";
import { expectArray, expectRecord, guardShape, num, optNumber, optString, reqString } from "../../core/schema.js";
import type { Pair, Provenance, Quote, ReadOptions } from "../../types/index.js";

export const DEX_BUNDLE_ID = "crypto.dex";

export interface DexBundleOptions extends BundleSharedOptions {
  /** End user's own CoinGecko Demo key (GATED). */
  coinGeckoApiKey?: string;
  /** End user's own Etherscan API key (GATED). */
  etherscanApiKey?: string;
}

type BarePair = Omit<Pair, "source" | "fetchedAt" | "freshness">;
type BareQuote = Omit<Quote, "source" | "fetchedAt" | "freshness">;

function guardDexScreenerPairs(raw: unknown): BarePair[] {
  return guardShape("dexscreener-pairs", raw, (v) => {
    const o = expectRecord(v);
    const pairs = expectArray(o["pairs"] ?? [], "pairs");
    return (Array.isArray(pairs) ? pairs : []).map((p) => {
      const pair = expectRecord(p);
      const base = expectRecord(pair["baseToken"] ?? {});
      const quote = expectRecord(pair["quoteToken"] ?? {});
      const liquidity = pair["liquidity"];
      const volume = pair["volume"];
      return {
        chainId: optString(pair, "chainId"),
        baseToken: reqString(base, "symbol"),
        quoteToken: optString(quote, "symbol") ?? "?",
        dex: optString(pair, "dexId"),
        priceUsd: optNumber(pair, "priceUsd"),
        liquidityUsd: liquidity != null ? optNumber(expectRecord(liquidity), "usd") : undefined,
        volume24h: volume != null ? optNumber(expectRecord(volume), "h24") : undefined,
        pairId: optString(pair, "pairAddress"),
      };
    });
  }, "dexscreener");
}

function guardGeckoTrending(raw: unknown, network: string): BarePair[] {
  return guardShape("geckoterminal-trending", raw, (v) => {
    const o = expectRecord(v);
    return expectArray(o["data"]).map((p) => {
      const pool = expectRecord(p);
      const attr = expectRecord(pool["attributes"] ?? {});
      const name = optString(attr, "name") ?? "?/?";
      const [baseToken = "?", quoteToken = "?"] = name.split("/").map((s) => s.trim());
      const volume = attr["volume_usd"];
      return {
        chainId: network,
        baseToken,
        quoteToken,
        dex: "geckoterminal",
        priceUsd: optNumber(attr, "base_token_price_usd"),
        liquidityUsd: optNumber(attr, "reserve_in_usd"),
        volume24h: volume != null ? optNumber(expectRecord(volume), "h24") : undefined,
        pairId: optString(attr, "address") ?? optString(pool, "id"),
      };
    });
  }, "geckoterminal");
}

function guardGeckoTokenPrices(raw: unknown): BareQuote[] {
  return guardShape("geckoterminal-token-price", raw, (v) => {
    const o = expectRecord(v);
    const data = expectRecord(o["data"], "data");
    const attr = expectRecord(data["attributes"] ?? {});
    const prices = expectRecord(attr["token_prices"] ?? {});
    const now = new Date().toISOString();
    return Object.entries(prices).map(([address, price]) => ({
      symbol: address,
      price: num(price),
      timestamp: now,
    }));
  }, "geckoterminal");
}

function guardCoinGeckoSimplePrice(raw: unknown): BareQuote[] {
  return guardShape("coingecko-simple-price", raw, (v) => {
    const o = expectRecord(v);
    const now = new Date().toISOString();
    const out: BareQuote[] = [];
    for (const [id, vs] of Object.entries(o)) {
      const perCurrency = expectRecord(vs);
      for (const [cur, price] of Object.entries(perCurrency)) {
        out.push({ symbol: `${id}/${cur}`.toUpperCase(), price: num(price), timestamp: now });
      }
    }
    return out;
  }, "coingecko");
}

export interface TokenBalance extends Provenance {
  address: string;
  chainId: number;
  contractAddress: string;
  /** Raw balance in the token's smallest unit (string — exceeds float precision). */
  balanceRaw: string;
}

export class DexBundle extends BundleBase {
  private readonly coinGeckoApiKey?: string;
  private readonly etherscanApiKey?: string;

  constructor(opts: DexBundleOptions = {}) {
    super(opts);
    this.coinGeckoApiKey = opts.coinGeckoApiKey;
    this.etherscanApiKey = opts.etherscanApiKey;
  }

  /** Pairs for token addresses (DEX Screener, KEYLESS). Price → maxAge 120s. */
  async tokenPairs(args: { addresses: string[] }, options?: ReadOptions): Promise<Pair[]> {
    const csv = args.addresses.join(",");
    return this.readMany({
      bundleId: DEX_BUNDLE_ID,
      source: "dexscreener",
      cacheKey: this.key(DEX_BUNDLE_ID, "dexscreener-tokens", csv),
      defaultMaxAgeSec: 120,
      ttlSec: 300,
      options,
      fetch: async () => {
        const t = this.transport("https://api.dexscreener.com", "dexscreener");
        const { data } = await t.request({ path: `/latest/dex/tokens/${csv}`, guard: guardDexScreenerPairs });
        return data;
      },
    });
  }

  /** Full-text pair search (DEX Screener, KEYLESS). */
  async searchPairs(args: { q: string }, options?: ReadOptions): Promise<Pair[]> {
    return this.readMany({
      bundleId: DEX_BUNDLE_ID,
      source: "dexscreener",
      cacheKey: this.key(DEX_BUNDLE_ID, "dexscreener-search", args.q),
      defaultMaxAgeSec: 120,
      ttlSec: 300,
      options,
      fetch: async () => {
        const t = this.transport("https://api.dexscreener.com", "dexscreener");
        const { data } = await t.request({ path: "/latest/dex/search", query: { q: args.q }, guard: guardDexScreenerPairs });
        return data;
      },
    });
  }

  /** Trending pools on a GeckoTerminal network (KEYLESS). */
  async trendingPools(args: { network: string }, options?: ReadOptions): Promise<Pair[]> {
    return this.readMany({
      bundleId: DEX_BUNDLE_ID,
      source: "geckoterminal",
      cacheKey: this.key(DEX_BUNDLE_ID, "geckoterminal-trending", args.network),
      defaultMaxAgeSec: 120,
      ttlSec: 300,
      options,
      fetch: async () => {
        const t = this.transport("https://api.geckoterminal.com/api/v2", "geckoterminal");
        const { data } = await t.request({
          path: `/networks/${args.network}/trending_pools`,
          guard: (raw) => guardGeckoTrending(raw, args.network),
        });
        return data;
      },
    });
  }

  /** Token USD prices by contract address (GeckoTerminal, KEYLESS). */
  async tokenPrices(args: { network: string; addresses: string[] }, options?: ReadOptions): Promise<Quote[]> {
    const csv = args.addresses.join(",");
    return this.readMany({
      bundleId: DEX_BUNDLE_ID,
      source: "geckoterminal",
      cacheKey: this.key(DEX_BUNDLE_ID, "geckoterminal-prices", args.network, csv),
      defaultMaxAgeSec: 120,
      ttlSec: 300,
      options,
      fetch: async () => {
        const t = this.transport("https://api.geckoterminal.com/api/v2", "geckoterminal");
        const { data } = await t.request({
          path: `/simple/networks/${args.network}/token_price/${csv}`,
          guard: guardGeckoTokenPrices,
        });
        return data;
      },
    });
  }

  /** Simple price lookup (CoinGecko, GATED — end user's own Demo key). */
  async simplePrice(args: { ids: string[]; vsCurrencies?: string[] }, options?: ReadOptions): Promise<Quote[]> {
    if (!this.coinGeckoApiKey) throw new UpstreamAuthRequired("coingecko", undefined, { source: "coingecko" });
    const key = this.coinGeckoApiKey;
    return this.readMany({
      bundleId: DEX_BUNDLE_ID,
      source: "coingecko",
      cacheKey: this.key(DEX_BUNDLE_ID, "coingecko-simple", args.ids.join(","), (args.vsCurrencies ?? ["usd"]).join(",")),
      defaultMaxAgeSec: 120,
      ttlSec: 300,
      options,
      fetch: async () => {
        const t = this.transport("https://api.coingecko.com/api/v3", "coingecko");
        const { data } = await t.request({
          path: "/simple/price",
          query: { ids: args.ids.join(","), vs_currencies: (args.vsCurrencies ?? ["usd"]).join(",") },
          headers: { "x-cg-demo-api-key": key },
          guard: guardCoinGeckoSimplePrice,
        });
        return data;
      },
    });
  }

  /** ETH price via Etherscan V2 stats (GATED — end user's own key). */
  async ethPrice(args: { chainId?: number } = {}, options?: ReadOptions): Promise<Quote> {
    if (!this.etherscanApiKey) throw new UpstreamAuthRequired("etherscan", undefined, { source: "etherscan" });
    const key = this.etherscanApiKey;
    const chainId = args.chainId ?? 1;
    return this.readOne({
      bundleId: DEX_BUNDLE_ID,
      source: "etherscan",
      cacheKey: this.key(DEX_BUNDLE_ID, "etherscan-ethprice", chainId),
      defaultMaxAgeSec: 120,
      ttlSec: 300,
      options,
      fetch: async () => {
        const t = this.transport("https://api.etherscan.io/v2/api", "etherscan");
        const { data } = await t.request({
          path: "",
          query: { chainid: chainId, module: "stats", action: "ethprice", apikey: key },
          guard: (raw) =>
            guardShape("etherscan-ethprice", raw, (v) => {
              const o = expectRecord(v);
              const r = expectRecord(o["result"] ?? {});
              return {
                symbol: "ETH/USD",
                price: num(r["ethusd"]),
                timestamp: r["ethusd_timestamp"] != null ? new Date(Number(r["ethusd_timestamp"]) * 1000).toISOString() : new Date().toISOString(),
              } as BareQuote;
            }, "etherscan"),
        });
        return data;
      },
    });
  }

  /** ERC-20 token balance via Etherscan V2 (GATED — end user's own key). */
  async tokenBalance(
    args: { chainId: number; address: string; contractAddress: string },
    options?: ReadOptions,
  ): Promise<TokenBalance> {
    if (!this.etherscanApiKey) throw new UpstreamAuthRequired("etherscan", undefined, { source: "etherscan" });
    const key = this.etherscanApiKey;
    return this.readOne({
      bundleId: DEX_BUNDLE_ID,
      source: "etherscan",
      cacheKey: this.key(DEX_BUNDLE_ID, "etherscan-tokenbalance", args.chainId, args.address, args.contractAddress),
      defaultMaxAgeSec: 300,
      ttlSec: 900,
      options,
      fetch: async () => {
        const t = this.transport("https://api.etherscan.io/v2/api", "etherscan");
        const { data } = await t.request({
          path: "",
          query: {
            chainid: args.chainId, module: "account", action: "tokenbalance",
            contractaddress: args.contractAddress, address: args.address, tag: "latest", apikey: key,
          },
          guard: (raw) =>
            guardShape("etherscan-tokenbalance", raw, (v) => {
              const o = expectRecord(v);
              return {
                address: args.address,
                chainId: args.chainId,
                contractAddress: args.contractAddress,
                balanceRaw: reqString(o, "result"),
              };
            }, "etherscan"),
        });
        return data as Omit<TokenBalance, "source" | "fetchedAt" | "freshness">;
      },
    });
  }
}
