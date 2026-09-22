import { describe, expect, it } from "vitest";
import { DexBundle } from "../../src/bundles/crypto/dex.js";
import { UpstreamAuthRequired } from "../../src/core/errors.js";
import { jsonResponse, mockFetch, route } from "../helpers.js";

function dexFetch() {
  return mockFetch([
    route("api.dexscreener.com/latest/dex/tokens", () =>
      jsonResponse({
        pairs: [{
          chainId: "ethereum", dexId: "uniswap", pairAddress: "0xpair",
          baseToken: { symbol: "ABC" }, quoteToken: { symbol: "WETH" },
          priceUsd: "1.5", liquidity: { usd: 1_000_000 }, volume: { h24: 500_000 },
        }],
      }),
    ),
    route("api.geckoterminal.com/api/v2/networks/eth/trending_pools", () =>
      jsonResponse({
        data: [{
          id: "eth_0xpool",
          attributes: {
            name: "ABC / WETH", address: "0xpool",
            base_token_price_usd: "1.5", reserve_in_usd: "2000000",
            volume_usd: { h24: "750000" },
          },
        }],
      }),
    ),
    route("api.geckoterminal.com/api/v2/simple/networks/eth/token_price", () =>
      jsonResponse({ data: { attributes: { token_prices: { "0xtoken": "2.5" } } } }),
    ),
    route("api.coingecko.com/api/v3/simple/price", () =>
      jsonResponse({ bitcoin: { usd: 67000 }, ethereum: { usd: 3500 } }),
    ),
    route("api.etherscan.io/v2/api", (url) =>
      url.includes("action=ethprice")
        ? jsonResponse({ status: "1", result: { ethusd: "3500.25", ethusd_timestamp: "1757000000" } })
        : jsonResponse({ status: "1", result: "123456789" }),
    ),
  ]);
}

describe("DexBundle", () => {
  it("tokenPairs normalizes DEX Screener pairs", async () => {
    const b = new DexBundle({ fetch: dexFetch() });
    const pairs = await b.tokenPairs({ addresses: ["0xtoken"] });
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({
      chainId: "ethereum", baseToken: "ABC", quoteToken: "WETH", dex: "uniswap",
      priceUsd: 1.5, liquidityUsd: 1_000_000, volume24h: 500_000, pairId: "0xpair",
    });
    expect(pairs[0].source).toBe("dexscreener");
    expect(pairs[0].freshness).toBe("LIVE");
  });

  it("trendingPools normalizes GeckoTerminal pools", async () => {
    const b = new DexBundle({ fetch: dexFetch() });
    const pools = await b.trendingPools({ network: "eth" });
    expect(pools).toHaveLength(1);
    expect(pools[0].baseToken).toBe("ABC");
    expect(pools[0].quoteToken).toBe("WETH");
    expect(pools[0].priceUsd).toBe(1.5);
    expect(pools[0].source).toBe("geckoterminal");
  });

  it("tokenPrices normalizes GeckoTerminal token prices", async () => {
    const b = new DexBundle({ fetch: dexFetch() });
    const quotes = await b.tokenPrices({ network: "eth", addresses: ["0xtoken"] });
    expect(quotes).toHaveLength(1);
    expect(quotes[0].symbol).toBe("0xtoken");
    expect(quotes[0].price).toBe(2.5);
  });

  it("simplePrice without the end user's key → UpstreamAuthRequired", async () => {
    const b = new DexBundle({ fetch: dexFetch() });
    await expect(b.simplePrice({ ids: ["bitcoin"] })).rejects.toBeInstanceOf(UpstreamAuthRequired);
  });

  it("simplePrice with key sends x-cg-demo-api-key", async () => {
    const fetch = dexFetch();
    const b = new DexBundle({ fetch, coinGeckoApiKey: "demo-key" });
    const quotes = await b.simplePrice({ ids: ["bitcoin", "ethereum"] });
    expect(quotes).toHaveLength(2);
    expect(quotes[0].price).toBe(67000);
    const call = fetch.captured.find((c) => c.url.includes("api.coingecko.com"));
    expect(call?.headers["x-cg-demo-api-key"]).toBe("demo-key");
  });

  it("ethPrice without the end user's key → UpstreamAuthRequired", async () => {
    const b = new DexBundle({ fetch: dexFetch() });
    await expect(b.ethPrice()).rejects.toBeInstanceOf(UpstreamAuthRequired);
  });

  it("ethPrice + tokenBalance via Etherscan V2 with the user's key", async () => {
    const b = new DexBundle({ fetch: dexFetch(), etherscanApiKey: "user-etherscan-key" });
    const q = await b.ethPrice({ chainId: 1 });
    expect(q.symbol).toBe("ETH/USD");
    expect(q.price).toBe(3500.25);
    expect(q.source).toBe("etherscan");
    const bal = await b.tokenBalance({ chainId: 1, address: "0xuser", contractAddress: "0xtoken" });
    expect(bal.balanceRaw).toBe("123456789");
    expect(bal.address).toBe("0xuser");
  });
});
