import { describe, expect, it } from "vitest";
import { MevBundle, RELAYS } from "../../src/bundles/crypto/mev.js";
import { jsonResponse, mockFetch, route } from "../helpers.js";

function mevFetch() {
  return mockFetch([
    route("mempool.space/api/v1/fees/recommended", () =>
      jsonResponse({ fastestFee: 12, halfHourFee: 8, hourFee: 5, economyFee: 3, minimumFee: 1 }),
    ),
    route("mempool.space/api/mempool/recent", () =>
      jsonResponse([{ txid: "abc123", fee: 2000, vsize: 200, value: 50_000 }]),
    ),
    route("mempool.space/api/mempool", () =>
      jsonResponse({ count: 150_000, vBytes: 120_000_000, totalFee: 5_000_000 }),
    ),
    route("mempool.space/api/blocks/tip/height", () =>
      new Response("880000", { status: 200, headers: { "Content-Type": "text/plain" } }),
    ),
    route("boost-relay.flashbots.net/relay/v1/data/bidtraces/proposer_payload_delivered", () =>
      jsonResponse([{ slot: 11_223_344, builder_pubkey: "0xbuilder", value: "123456789000000000" }]),
    ),
    route("boost-relay.flashbots.net/relay/v1/data/bidtraces/builder_blocks_received", () =>
      jsonResponse([{ slot: 11_223_345, builder_pubkey: "0xbuilder2", value: "999000000000000000" }]),
    ),
  ]);
}

describe("MevBundle", () => {
  it("feeEstimates normalizes mempool.space fees with provenance", async () => {
    const b = new MevBundle({ fetch: mevFetch() });
    const fees = await b.feeEstimates();
    expect(fees.fastestSatVbyte).toBe(12);
    expect(fees.economySatVbyte).toBe(3);
    expect(fees.source).toBe("mempool.space");
    expect(fees.freshness).toBe("LIVE");
    expect(Date.parse(fees.fetchedAt)).not.toBeNaN();
  });

  it("mempoolStats combines backlog + tip height", async () => {
    const b = new MevBundle({ fetch: mevFetch() });
    const stats = await b.mempoolStats();
    expect(stats.txCount).toBe(150_000);
    expect(stats.vBytes).toBe(120_000_000);
    expect(stats.tipHeight).toBe(880_000);
    expect(stats.freshness).toBe("LIVE");
  });

  it("recentTxs normalizes pending transactions", async () => {
    const b = new MevBundle({ fetch: mevFetch() });
    const txs = await b.recentTxs(10);
    expect(txs).toHaveLength(1);
    expect(txs[0].hash).toBe("abc123");
    expect(txs[0].feeSatVbyte).toBe(10); // 2000/200
    expect(txs[0].valueSats).toBe(50_000);
    expect(txs[0].source).toBe("mempool.space");
  });

  it("relayBids / builderBlocks normalize bid traces", async () => {
    const b = new MevBundle({ fetch: mevFetch() });
    const bids = await b.relayBids(10);
    expect(bids).toHaveLength(1);
    expect(bids[0].slot).toBe(11_223_344);
    expect(bids[0].builder).toBe("0xbuilder");
    expect(bids[0].value).toBe("123456789000000000");
    expect(bids[0].relay).toBe(RELAYS.flashbots);
    const blocks = await b.builderBlocks(10);
    expect(blocks[0].slot).toBe(11_223_345);
  });

  it("serves CACHED within maxAge without refetching", async () => {
    const fetch = mevFetch();
    const b = new MevBundle({ fetch });
    await b.feeEstimates();
    const calls = fetch.callCount();
    const again = await b.feeEstimates({ maxAge: 600 });
    expect(again.freshness).toBe("CACHED");
    expect(fetch.callCount()).toBe(calls);
  });

  it("streamUnconfirmedTxs builds a blockchain.info StreamAdapter", () => {
    const b = new MevBundle({ fetch: mevFetch() });
    const stream = b.streamUnconfirmedTxs();
    expect(stream.health().connected).toBe(false);
    stream.disconnect();
  });

  it("pollMempoolStats returns a working PollingAdapter", async () => {
    const b = new MevBundle({ fetch: mevFetch() });
    const poller = b.pollMempoolStats(60_000);
    await poller.pollOnce();
    expect(poller.snapshot()).toHaveLength(1);
    expect(poller.snapshot()[0].txCount).toBe(150_000);
    poller.stop();
  });
});
