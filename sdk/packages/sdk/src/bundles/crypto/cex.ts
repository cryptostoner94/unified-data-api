/**
 * CEX market-data bundle (`crypto.cex`) — klines, tickers, trades.
 *
 * Sources (all KEYLESS, market-data-only):
 *   - Binance  https://data-api.binance.vision (+ WS wss://data-stream.binance.vision)
 *   - Kraken   https://api.kraken.com           (+ WS v2 wss://ws.kraken.com/v2)
 *
 * NOTE — Coinbase Exchange is EXCLUDED from this SDK (spec §2.1): its Market
 * Data ToS (2026-08-07) forbids redistribution, end-user-facing apps,
 * benchmarks, and AI/ML training without written consent. It is not
 * implemented here, on purpose.
 */
import { BundleBase, type BundleSharedOptions } from "../base.js";
import { StreamAdapter, type StreamEvent } from "../../adapters/ws.js";
import { expectArray, expectRecord, guardShape, isoDate, num, optNumber } from "../../core/schema.js";
import type { Candle, Quote, ReadOptions, Trade } from "../../types/index.js";

export const CEX_BUNDLE_ID = "crypto.cex";

type Venue = "binance" | "kraken";

/** Venue interval → Kraken OHLC interval minutes. */
const KRAKEN_INTERVALS: Record<string, number> = {
  "1m": 1, "3m": 3, "5m": 5, "15m": 15, "30m": 30,
  "1h": 60, "2h": 120, "4h": 240, "6h": 360, "8h": 480, "12h": 720,
  "1d": 1440, "3d": 4320, "1w": 10080,
};

function guardBinanceKlines(raw: unknown, interval: string): Array<Omit<Candle, "source" | "fetchedAt" | "freshness">> {
  return guardShape("binance-klines", raw, (v) =>
    expectArray(v).map((k) => {
      const a = expectArray(k);
      return {
        open: num(a[1]), high: num(a[2]), low: num(a[3]), close: num(a[4]), volume: num(a[5]),
        interval, timestamp: isoDate(num(a[0])),
      };
    }), "binance");
}

function guardKrakenOhlc(raw: unknown, interval: string): Array<Omit<Candle, "source" | "fetchedAt" | "freshness">> {
  return guardShape("kraken-ohlc", raw, (v) => {
    const o = expectRecord(v);
    const result = expectRecord(o["result"], "result");
    const firstKey = Object.keys(result).find((k) => k !== "last");
    if (!firstKey) throw new Error("empty result");
    return expectArray(result[firstKey]).map((k) => {
      const a = expectArray(k);
      return {
        open: num(a[1]), high: num(a[2]), low: num(a[3]), close: num(a[4]), volume: num(a[6]),
        interval, timestamp: isoDate(num(a[0])),
      };
    });
  }, "kraken");
}

function guardBinanceTicker(raw: unknown): Omit<Quote, "source" | "fetchedAt" | "freshness" | "symbol"> & { symbol: string } {
  return guardShape("binance-ticker24h", raw, (v) => {
    const o = expectRecord(v);
    return {
      symbol: String(o["symbol"] ?? ""),
      price: num(o["lastPrice"]),
      timestamp: isoDate(num(o["closeTime"])),
      bid: optNumber(o, "bidPrice"),
      ask: optNumber(o, "askPrice"),
      change24hPct: optNumber(o, "priceChangePercent"),
      volume24h: optNumber(o, "volume"),
    };
  }, "binance");
}

function guardKrakenTicker(raw: unknown, symbol: string): Omit<Quote, "source" | "fetchedAt" | "freshness"> {
  return guardShape("kraken-ticker", raw, (v) => {
    const o = expectRecord(v);
    const result = expectRecord(o["result"], "result");
    const firstKey = Object.keys(result)[0];
    if (!firstKey) throw new Error("empty result");
    const t = expectRecord(result[firstKey]);
    const last = expectArray(t["c"])[0];
    const bid = expectArray(t["b"])[0];
    const ask = expectArray(t["a"])[0];
    return { symbol, price: num(last), timestamp: new Date().toISOString(), bid: num(bid), ask: num(ask) };
  }, "kraken");
}

function guardBinanceTrades(raw: unknown, symbol: string): Array<Omit<Trade, "source" | "fetchedAt" | "freshness">> {
  return guardShape("binance-trades", raw, (v) =>
    expectArray(v).map((t) => {
      const o = expectRecord(t);
      return {
        symbol,
        price: num(o["price"]),
        qty: num(o["qty"]),
        timestamp: isoDate(num(o["time"])),
        side: o["isBuyerMaker"] === true ? ("sell" as const) : ("buy" as const),
      };
    }), "binance");
}

function guardKrakenTrades(raw: unknown, symbol: string): Array<Omit<Trade, "source" | "fetchedAt" | "freshness">> {
  return guardShape("kraken-trades", raw, (v) => {
    const o = expectRecord(v);
    const result = expectRecord(o["result"], "result");
    const firstKey = Object.keys(result).find((k) => k !== "last");
    if (!firstKey) throw new Error("empty result");
    return expectArray(result[firstKey]).map((t) => {
      const a = expectArray(t);
      return {
        symbol,
        price: num(a[0]),
        qty: num(a[1]),
        timestamp: isoDate(num(a[2])),
        side: a[3] === "s" ? ("sell" as const) : ("buy" as const),
      };
    });
  }, "kraken");
}

export class CexBundle extends BundleBase {
  constructor(opts: BundleSharedOptions = {}) {
    super(opts);
  }

  /** OHLC klines. Price data → default maxAge 120s. */
  async klines(args: { venue: Venue; symbol: string; interval?: string; limit?: number }, options?: ReadOptions): Promise<Candle[]> {
    const interval = args.interval ?? "1h";
    const limit = args.limit ?? 100;
    return this.readMany({
      bundleId: CEX_BUNDLE_ID,
      source: args.venue,
      cacheKey: this.key(CEX_BUNDLE_ID, "klines", args.venue, args.symbol, interval, limit),
      defaultMaxAgeSec: 120,
      ttlSec: 300,
      options,
      fetch: async () => {
        if (args.venue === "binance") {
          const t = this.transport("https://data-api.binance.vision", "binance");
          const { data } = await t.request({
            path: "/api/v3/klines",
            query: { symbol: args.symbol, interval, limit },
            guard: (raw) => guardBinanceKlines(raw, interval),
          });
          return data;
        }
        const t = this.transport("https://api.kraken.com", "kraken");
        const { data } = await t.request({
          path: "/0/public/OHLC",
          query: { pair: args.symbol, interval: KRAKEN_INTERVALS[interval] ?? 60 },
          guard: (raw) => guardKrakenOhlc(raw, interval),
        });
        return data.slice(-limit);
      },
    });
  }

  /** 24h ticker snapshot. Price data → default maxAge 120s. */
  async ticker(args: { venue: Venue; symbol: string }, options?: ReadOptions): Promise<Quote> {
    return this.readOne({
      bundleId: CEX_BUNDLE_ID,
      source: args.venue,
      cacheKey: this.key(CEX_BUNDLE_ID, "ticker", args.venue, args.symbol),
      defaultMaxAgeSec: 120,
      ttlSec: 300,
      options,
      fetch: async () => {
        if (args.venue === "binance") {
          const t = this.transport("https://data-api.binance.vision", "binance");
          const { data } = await t.request({ path: "/api/v3/ticker/24hr", query: { symbol: args.symbol }, guard: guardBinanceTicker });
          return data;
        }
        const t = this.transport("https://api.kraken.com", "kraken");
        const { data } = await t.request({
          path: "/0/public/Ticker",
          query: { pair: args.symbol },
          guard: (raw) => guardKrakenTicker(raw, args.symbol),
        });
        return data;
      },
    });
  }

  /** Recent public trades. Price data → default maxAge 120s. */
  async recentTrades(args: { venue: Venue; symbol: string; limit?: number }, options?: ReadOptions): Promise<Trade[]> {
    const limit = args.limit ?? 50;
    return this.readMany({
      bundleId: CEX_BUNDLE_ID,
      source: args.venue,
      cacheKey: this.key(CEX_BUNDLE_ID, "trades", args.venue, args.symbol, limit),
      defaultMaxAgeSec: 120,
      ttlSec: 300,
      options,
      fetch: async () => {
        if (args.venue === "binance") {
          const t = this.transport("https://data-api.binance.vision", "binance");
          const { data } = await t.request({
            path: "/api/v3/trades",
            query: { symbol: args.symbol, limit },
            guard: (raw) => guardBinanceTrades(raw, args.symbol),
          });
          return data;
        }
        const t = this.transport("https://api.kraken.com", "kraken");
        const { data } = await t.request({
          path: "/0/public/Trades",
          query: { pair: args.symbol },
          guard: (raw) => guardKrakenTrades(raw, args.symbol),
        });
        return data.slice(-limit);
      },
    });
  }

  /**
   * Live trade stream. Binance: `wss://data-stream.binance.vision` (ping every
   * 20s per spec); Kraken: WS v2 public trade channel. Events are LIVE while
   * the subscription is healthy (§7.2).
   */
  streamTrades(args: { venue: Venue; symbol: string }): StreamAdapter {
    if (args.venue === "binance") {
      const stream = args.symbol.toLowerCase();
      return new StreamAdapter({
        url: `wss://data-stream.binance.vision/ws/${stream}@trade`,
        source: "binance",
        pingPayload: { method: "ping" },
        pingIntervalMs: 20_000,
        parseMessage: (data): StreamEvent | null => {
          const raw = typeof data === "string" ? JSON.parse(data) : data;
          const o = expectRecord(raw);
          const receivedAt = new Date().toISOString();
          const trade: Omit<Trade, "source" | "fetchedAt" | "freshness"> = {
            symbol: String(o["s"] ?? args.symbol),
            price: num(o["p"]),
            qty: num(o["q"]),
            timestamp: isoDate(num(o["T"])),
            side: o["m"] === true ? "sell" : "buy",
          };
          return { kind: "trade", receivedAt, data: trade };
        },
      });
    }
    return new StreamAdapter({
      url: "wss://ws.kraken.com/v2",
      source: "kraken",
      subscribe: (send) => send({ method: "subscribe", params: { channel: "trade", symbol: [args.symbol] } }),
      parseMessage: (data): StreamEvent[] | null => {
        const raw = typeof data === "string" ? JSON.parse(data) : data;
        const o = expectRecord(raw);
        if (o["channel"] !== "trade" || o["type"] !== "update") return null;
        const receivedAt = new Date().toISOString();
        return expectArray(o["data"]).map((t) => {
          const tr = expectRecord(t);
          const trade: Omit<Trade, "source" | "fetchedAt" | "freshness"> = {
            symbol: String(tr["symbol"] ?? args.symbol),
            price: num(tr["price"]),
            qty: num(tr["qty"]),
            timestamp: String(tr["timestamp"] ?? receivedAt),
            side: tr["side"] === "sell" ? "sell" : "buy",
          };
          return { kind: "trade", receivedAt, data: trade };
        });
      },
    });
  }
}
