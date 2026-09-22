/**
 * Resolver bundle (`crypto.resolver`) — quotes, orderbooks, fills.
 *
 * Sources:
 *   - 1inch Swap API quotes   https://api.1inch.dev            GATED (end user's own key;
 *     the public tier is non-commercial-only per DevPortal ToS — never bundle our key)
 *   - Binance order book      https://data-api.binance.vision  KEYLESS
 *   - Kraken order book       https://api.kraken.com           KEYLESS
 *   - The Graph (DEX subgraphs) https://gateway.thegraph.com   GATED (end user's own key)
 */
import { BundleBase, type BundleSharedOptions } from "../base.js";
import { UpstreamAuthRequired } from "../../core/errors.js";
import { expectArray, expectRecord, guardShape, num, reqString } from "../../core/schema.js";
import type { OrderBook, Quote, ReadOptions, SubgraphResult } from "../../types/index.js";

export const RESOLVER_BUNDLE_ID = "crypto.resolver";

export interface ResolverBundleOptions extends BundleSharedOptions {
  /** End user's own 1inch DevPortal key (GATED). */
  oneInchApiKey?: string;
  /** End user's own The Graph API key (GATED). */
  theGraphApiKey?: string;
}

type Venue = "binance" | "kraken";

function guardBinanceDepth(raw: unknown): { bids: Array<[number, number]>; asks: Array<[number, number]> } {
  return guardShape("binance-depth", raw, (v) => {
    const o = expectRecord(v);
    const pair = (arr: unknown): Array<[number, number]> =>
      expectArray(arr, "levels").map((lvl) => {
        const [p, q] = expectArray(lvl);
        return [num(p), num(q)];
      });
    return { bids: pair(o["bids"]), asks: pair(o["asks"]) };
  }, "binance");
}

function guardKrakenDepth(raw: unknown): { bids: Array<[number, number]>; asks: Array<[number, number]> } {
  return guardShape("kraken-depth", raw, (v) => {
    const o = expectRecord(v);
    const result = expectRecord(o["result"], "result");
    const firstKey = Object.keys(result)[0];
    if (!firstKey) throw new Error("empty result");
    const book = expectRecord(result[firstKey]);
    const pair = (arr: unknown): Array<[number, number]> =>
      expectArray(arr, "levels").map((lvl) => {
        const [p, q] = expectArray(lvl);
        return [num(p), num(q)];
      });
    return { bids: pair(book["bids"]), asks: pair(book["asks"]) };
  }, "kraken");
}

function guardOneInchQuote(raw: unknown): { dstAmount: string } {
  return guardShape("1inch-quote", raw, (v) => {
    const o = expectRecord(v);
    return { dstAmount: reqString(o, "dstAmount") };
  }, "1inch");
}

export class ResolverBundle extends BundleBase {
  private readonly oneInchApiKey?: string;
  private readonly theGraphApiKey?: string;

  constructor(opts: ResolverBundleOptions = {}) {
    super(opts);
    this.oneInchApiKey = opts.oneInchApiKey;
    this.theGraphApiKey = opts.theGraphApiKey;
  }

  /**
   * 1inch Swap API quote (GATED). `amount` is in the src token's smallest
   * unit. Returns a Quote whose price is the dst/src ratio.
   */
  async oneInchQuote(
    args: { chain: number | string; src: string; dst: string; amount: string },
    options?: ReadOptions,
  ): Promise<Quote> {
    if (!this.oneInchApiKey) throw new UpstreamAuthRequired("1inch", undefined, { source: "1inch" });
    const key = this.oneInchApiKey;
    return this.readOne({
      bundleId: RESOLVER_BUNDLE_ID,
      source: "1inch",
      cacheKey: this.key(RESOLVER_BUNDLE_ID, "1inch-quote", args.chain, args.src, args.dst, args.amount),
      defaultMaxAgeSec: 120,
      ttlSec: 300,
      options,
      fetch: async () => {
        const t = this.transport("https://api.1inch.dev", "1inch");
        const { data } = await t.request({
          path: `/swap/v6.0/${args.chain}/quote`,
          query: { src: args.src, dst: args.dst, amount: args.amount },
          headers: { Authorization: `Bearer ${key}` },
          guard: guardOneInchQuote,
        });
        const srcAmt = Number(args.amount);
        const dstAmt = Number(data.dstAmount);
        return {
          symbol: `${args.src}->${args.dst}`,
          price: srcAmt > 0 ? dstAmt / srcAmt : NaN,
          timestamp: new Date().toISOString(),
        };
      },
    });
  }

  /** Order book from Binance or Kraken (both KEYLESS). Price → default maxAge 120s. */
  async orderBook(args: { venue: Venue; symbol: string; limit?: number }, options?: ReadOptions): Promise<OrderBook> {
    const limit = args.limit ?? 100;
    return this.readOne({
      bundleId: RESOLVER_BUNDLE_ID,
      source: args.venue,
      cacheKey: this.key(RESOLVER_BUNDLE_ID, "depth", args.venue, args.symbol, limit),
      defaultMaxAgeSec: 120,
      ttlSec: 300,
      options,
      fetch: async () => {
        if (args.venue === "binance") {
          const t = this.transport("https://data-api.binance.vision", "binance");
          const { data } = await t.request({
            path: "/api/v3/depth",
            query: { symbol: args.symbol, limit },
            guard: guardBinanceDepth,
          });
          return { bids: data.bids, asks: data.asks, timestamp: new Date().toISOString() };
        }
        const t = this.transport("https://api.kraken.com", "kraken");
        const { data } = await t.request({
          path: "/0/public/Depth",
          query: { pair: args.symbol, count: limit },
          guard: guardKrakenDepth,
        });
        return { bids: data.bids, asks: data.asks, timestamp: new Date().toISOString() };
      },
    });
  }

  /**
   * Raw GraphQL passthrough to a DEX subgraph on The Graph's decentralized
   * network (GATED — end user's own key). Normalized only with provenance;
   * the subgraph schema is app-specific.
   */
  async subgraphQuery(
    args: { subgraphId: string; query: string; variables?: Record<string, unknown> },
    options?: ReadOptions,
  ): Promise<SubgraphResult> {
    if (!this.theGraphApiKey) throw new UpstreamAuthRequired("the-graph", undefined, { source: "the-graph" });
    const key = this.theGraphApiKey;
    return this.readOne({
      bundleId: RESOLVER_BUNDLE_ID,
      source: "the-graph",
      cacheKey: this.key(RESOLVER_BUNDLE_ID, "subgraph", args.subgraphId, JSON.stringify({ q: args.query, v: args.variables ?? {} })),
      defaultMaxAgeSec: 120,
      ttlSec: 300,
      options,
      fetch: async () => {
        const t = this.transport("https://gateway.thegraph.com", "the-graph");
        const { data } = await t.request<unknown>({
          method: "POST",
          path: `/api/${key}/subgraphs/id/${args.subgraphId}`,
          body: { query: args.query, variables: args.variables ?? {} },
          guard: (raw) => {
            const o = expectRecord(raw);
            if (o["errors"]) throw new Error(`subgraph errors: ${JSON.stringify(o["errors"]).slice(0, 300)}`);
            return o["data"] ?? null;
          },
        });
        return { subgraphId: args.subgraphId, data };
      },
    });
  }
}
