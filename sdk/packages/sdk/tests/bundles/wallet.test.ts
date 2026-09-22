import { describe, expect, it } from "vitest";
import { WalletBundle } from "../../src/bundles/crypto/wallet.js";
import { jsonResponse, mockFetch, route } from "../helpers.js";

function walletFetch() {
  return mockFetch([
    route("mempool.space/api/address/bc1qtest", (url) => {
      if (url.includes("/txs")) {
        return jsonResponse([{ txid: "tx1", fee: 500, vsize: 250, value: 10_000, status: { confirmed: true, block_time: 1_757_000_000 } }]);
      }
      if (url.includes("/utxo")) {
        return jsonResponse([{ txid: "tx1", vout: 0, value: 10_000, status: { confirmed: true } }]);
      }
      return jsonResponse({
        address: "bc1qtest",
        chain_stats: { funded_txo_sum: 100_000, spent_txo_sum: 40_000, tx_count: 3 },
        mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 1 },
      });
    }),
    route("blockchain.info/rawaddr", () =>
      jsonResponse({
        address: "bc1qtest", final_balance: 60_000, n_tx: 4,
        txs: [{ hash: "tx1", time: 1_757_000_000 }],
      }),
    ),
  ]);
}

describe("WalletBundle", () => {
  it("addressInfo computes balance from chain stats", async () => {
    const b = new WalletBundle({ fetch: walletFetch() });
    const info = await b.addressInfo({ address: "bc1qtest" });
    expect(info.address).toBe("bc1qtest");
    expect(info.chain).toBe("bitcoin");
    expect(info.balanceSats).toBe(60_000);
    expect(info.txCount).toBe(4);
    expect(info.source).toBe("mempool.space");
    expect(info.freshness).toBe("LIVE");
  });

  it("addressTxs normalizes transactions", async () => {
    const b = new WalletBundle({ fetch: walletFetch() });
    const txs = await b.addressTxs({ address: "bc1qtest" });
    expect(txs).toHaveLength(1);
    expect(txs[0].hash).toBe("tx1");
    expect(txs[0].confirmations).toBe(1);
    expect(txs[0].timestamp).toBe(new Date(1_757_000_000 * 1000).toISOString());
  });

  it("addressUtxos normalizes UTXOs", async () => {
    const b = new WalletBundle({ fetch: walletFetch() });
    const utxos = await b.addressUtxos({ address: "bc1qtest" });
    expect(utxos).toHaveLength(1);
    expect(utxos[0]).toMatchObject({ txid: "tx1", vout: 0, valueSats: 10_000, confirmed: true });
  });

  it("blockchainInfoAddress uses the second keyless source", async () => {
    const b = new WalletBundle({ fetch: walletFetch() });
    const info = await b.blockchainInfoAddress({ address: "bc1qtest" });
    expect(info.balanceSats).toBe(60_000);
    expect(info.source).toBe("blockchain.info");
    const txs = await b.blockchainInfoTxs({ address: "bc1qtest" });
    expect(txs[0].hash).toBe("tx1");
  });
});
