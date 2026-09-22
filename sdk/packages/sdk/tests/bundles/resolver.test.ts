import { describe, expect, it } from "vitest";
import { ResolverBundle } from "../../src/bundles/crypto/resolver.js";
import { UpstreamAuthRequired } from "../../src/core/errors.js";
import { jsonResponse, mockFetch, route } from "../helpers.js";

function resolverFetch() {
  return mockFetch([
    route("data-api.binance.vision/api/v3/depth", () =>
      jsonResponse({ lastUpdateId: 1, bids: [["100.5", "1.2"]], asks: [["101.0", "0.8"]] }),
    ),
    route("api.kraken.com/0/public/Depth", () =>
      jsonResponse({ error: [], result: { XXBTZUSD: { asks: [["101.0", "0.8", 1]], bids: [["100.5", "1.2", 1]] } } }),
    ),
    route("api.1inch.dev/swap", () =>
      jsonResponse({ dstAmount: "2000000", srcAmount: "1000000" }),
    ),
    route("gateway.thegraph.com/api", () =>
      jsonResponse({ data: { pairs: [{ id: "0xpair" }] } }),
    ),
  ]);
}

describe("ResolverBundle", () => {
  it("orderBook from Binance normalizes bids/asks", async () => {
    const b = new ResolverBundle({ fetch: resolverFetch() });
    const book = await b.orderBook({ venue: "binance", symbol: "BTCUSDT", limit: 5 });
    expect(book.bids).toEqual([[100.5, 1.2]]);
    expect(book.asks).toEqual([[101.0, 0.8]]);
    expect(book.source).toBe("binance");
    expect(book.freshness).toBe("LIVE");
  });

  it("orderBook from Kraken handles the pair-keyed result", async () => {
    const b = new ResolverBundle({ fetch: resolverFetch() });
    const book = await b.orderBook({ venue: "kraken", symbol: "XBTUSD", limit: 5 });
    expect(book.bids).toEqual([[100.5, 1.2]]);
    expect(book.asks).toEqual([[101.0, 0.8]]);
    expect(book.source).toBe("kraken");
  });

  it("1inch quote without the end user's key → UpstreamAuthRequired", async () => {
    const b = new ResolverBundle({ fetch: resolverFetch() });
    await expect(b.oneInchQuote({ chain: 1, src: "0xa", dst: "0xb", amount: "1000000" })).rejects.toBeInstanceOf(
      UpstreamAuthRequired,
    );
  });

  it("1inch quote with the end user's key sends Bearer auth", async () => {
    const fetch = resolverFetch();
    const b = new ResolverBundle({ fetch, oneInchApiKey: "user-key-1" });
    const q = await b.oneInchQuote({ chain: 1, src: "0xa", dst: "0xb", amount: "1000000" });
    expect(q.price).toBe(2);
    expect(q.source).toBe("1inch");
    const call = fetch.captured.find((c) => c.url.includes("api.1inch.dev"));
    expect(call?.headers["authorization"]).toBe("Bearer user-key-1");
  });

  it("subgraphQuery without the end user's key → UpstreamAuthRequired", async () => {
    const b = new ResolverBundle({ fetch: resolverFetch() });
    await expect(b.subgraphQuery({ subgraphId: "abc", query: "{ pairs { id } }" })).rejects.toBeInstanceOf(
      UpstreamAuthRequired,
    );
  });

  it("subgraphQuery POSTs GraphQL with the user's key in the path", async () => {
    const fetch = resolverFetch();
    const b = new ResolverBundle({ fetch, theGraphApiKey: "user-graph-key" });
    const res = await b.subgraphQuery({ subgraphId: "QmAbc", query: "{ pairs { id } }" });
    expect(res.subgraphId).toBe("QmAbc");
    expect(res.data).toEqual({ pairs: [{ id: "0xpair" }] });
    const call = fetch.captured.find((c) => c.url.includes("gateway.thegraph.com"));
    expect(call?.url).toContain("/api/user-graph-key/subgraphs/id/QmAbc");
    expect(call?.method).toBe("POST");
  });
});
