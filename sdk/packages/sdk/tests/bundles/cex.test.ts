import { describe, expect, it } from "vitest";
import { CexBundle } from "../../src/bundles/crypto/cex.js";
import { jsonResponse, mockFetch, route } from "../helpers.js";

function cexFetch() {
  return mockFetch([
    route("data-api.binance.vision/api/v3/klines", () =>
      jsonResponse([
        [1_757_000_000_000, "100.0", "105.0", "99.0", "104.0", "1234.5", 1_757_003_599_999],
        [1_757_003_600_000, "104.0", "106.0", "103.0", "105.5", "900.0", 1_757_007_199_999],
      ]),
    ),
    route("data-api.binance.vision/api/v3/ticker/24hr", () =>
      jsonResponse({
        symbol: "BTCUSDT", lastPrice: "67000.5", bidPrice: "67000.0", askPrice: "67001.0",
        priceChangePercent: "1.25", volume: "1234.5", closeTime: 1_757_003_599_999,
      }),
    ),
    route("data-api.binance.vision/api/v3/trades", () =>
      jsonResponse([{ price: "67000.5", qty: "0.01", time: 1_757_003_599_999, isBuyerMaker: false }]),
    ),
    route("api.kraken.com/0/public/Ticker", () =>
      jsonResponse({ error: [], result: { XXBTZUSD: { c: ["67000.5"], b: ["67000.0", "1"], a: ["67001.0", "1"] } } }),
    ),
    route("api.kraken.com/0/public/OHLC", () =>
      jsonResponse({ error: [], result: { XXBTZUSD: [[1_757_000_000, "100.0", "105.0", "99.0", "104.0", "104.0", "1234.5", 10]], last: 1_757_000_000 } }),
    ),
  ]);
}

describe("CexBundle", () => {
  it("klines from Binance → Candle[] with provenance", async () => {
    const b = new CexBundle({ fetch: cexFetch() });
    const candles = await b.klines({ venue: "binance", symbol: "BTCUSDT", interval: "1h", limit: 2 });
    expect(candles).toHaveLength(2);
    expect(candles[0]).toMatchObject({ open: 100, high: 105, low: 99, close: 104, volume: 1234.5, interval: "1h" });
    expect(candles[0].source).toBe("binance");
    expect(candles[0].freshness).toBe("LIVE");
  });

  it("klines from Kraken maps OHLC tuples", async () => {
    const b = new CexBundle({ fetch: cexFetch() });
    const candles = await b.klines({ venue: "kraken", symbol: "XBTUSD", interval: "1h" });
    expect(candles).toHaveLength(1);
    expect(candles[0].close).toBe(104);
    expect(candles[0].source).toBe("kraken");
  });

  it("ticker from Binance → Quote with 24h stats", async () => {
    const b = new CexBundle({ fetch: cexFetch() });
    const q = await b.ticker({ venue: "binance", symbol: "BTCUSDT" });
    expect(q.symbol).toBe("BTCUSDT");
    expect(q.price).toBe(67000.5);
    expect(q.bid).toBe(67000);
    expect(q.ask).toBe(67001);
    expect(q.change24hPct).toBe(1.25);
    expect(q.freshness).toBe("LIVE");
  });

  it("ticker from Kraken → Quote", async () => {
    const b = new CexBundle({ fetch: cexFetch() });
    const q = await b.ticker({ venue: "kraken", symbol: "XBTUSD" });
    expect(q.price).toBe(67000.5);
    expect(q.source).toBe("kraken");
  });

  it("recentTrades normalizes side from isBuyerMaker", async () => {
    const b = new CexBundle({ fetch: cexFetch() });
    const trades = await b.recentTrades({ venue: "binance", symbol: "BTCUSDT", limit: 10 });
    expect(trades).toHaveLength(1);
    expect(trades[0].side).toBe("buy");
    expect(trades[0].price).toBe(67000.5);
  });

  it("streamTrades builds adapters for both venues", () => {
    const b = new CexBundle({ fetch: cexFetch() });
    const binance = b.streamTrades({ venue: "binance", symbol: "BTCUSDT" });
    const kraken = b.streamTrades({ venue: "kraken", symbol: "BTC/USD" });
    expect(binance.health().connected).toBe(false);
    expect(kraken.health().connected).toBe(false);
    binance.disconnect();
    kraken.disconnect();
  });
});
