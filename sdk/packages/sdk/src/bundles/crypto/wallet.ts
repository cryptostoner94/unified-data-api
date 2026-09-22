/**
 * Wallet/labels bundle (`crypto.wallet`).
 *
 * Keyless-first (spec §2.1):
 *   - mempool.space address endpoints  https://mempool.space/api
 *     (`/api/address/{addr}`, `/txs`, `/utxo` — Bitcoin; also serves Liquid)
 *   - blockchain.info `rawaddr` REST endpoint
 *
 * Label/tag datasets are provider-specific and mostly paid — those ship as
 * GATED adapters where the user brings their own key. No bundled labels in v1.
 *
 * Account-state reads default to maxAge 300s (between the price 120s and feed
 * 900s defaults — an explicit, documented choice for balance data).
 */
import { BundleBase, type BundleSharedOptions } from "../base.js";
import { expectArray, expectRecord, guardShape, isoDate, num, optNumber, reqString } from "../../core/schema.js";
import type { Provenance, ReadOptions, WalletInfo, WalletTx } from "../../types/index.js";

export const WALLET_BUNDLE_ID = "crypto.wallet";

export interface Utxo extends Provenance {
  txid: string;
  vout: number;
  valueSats: number;
  confirmed: boolean;
}

type BareWalletInfo = Omit<WalletInfo, "source" | "fetchedAt" | "freshness">;
type BareWalletTx = Omit<WalletTx, "source" | "fetchedAt" | "freshness">;
type BareUtxo = Omit<Utxo, "source" | "fetchedAt" | "freshness">;

function guardMempoolAddress(raw: unknown, address: string): BareWalletInfo {
  return guardShape("mempool-address", raw, (v) => {
    const o = expectRecord(v);
    const stats = expectRecord(o["chain_stats"] ?? {});
    const mempoolStats = o["mempool_stats"] != null ? expectRecord(o["mempool_stats"]) : undefined;
    const funded = num(stats["funded_txo_sum"] ?? 0);
    const spent = num(stats["spent_txo_sum"] ?? 0);
    return {
      address,
      chain: "bitcoin",
      balanceSats: funded - spent,
      txCount: num(stats["tx_count"] ?? 0) + (mempoolStats ? num(mempoolStats["tx_count"] ?? 0) : 0),
    };
  }, "mempool.space");
}

function guardMempoolTxs(raw: unknown, address: string): BareWalletTx[] {
  return guardShape("mempool-address-txs", raw, (v) =>
    expectArray(v).map((t) => {
      const o = expectRecord(t);
      const status = o["status"] != null ? expectRecord(o["status"]) : undefined;
      const blockTime = status ? optNumber(status, "block_time") : undefined;
      return {
        hash: reqString(o, "txid"),
        address,
        valueSats: optNumber(o, "value"),
        confirmations: status?.["confirmed"] === true ? 1 : 0,
        timestamp: blockTime != null ? new Date(blockTime * 1000).toISOString() : undefined,
      };
    }), "mempool.space");
}

function guardMempoolUtxos(raw: unknown): BareUtxo[] {
  return guardShape("mempool-utxo", raw, (v) =>
    expectArray(v).map((u) => {
      const o = expectRecord(u);
      const status = o["status"] != null ? expectRecord(o["status"]) : undefined;
      return {
        txid: reqString(o, "txid"),
        vout: num(o["vout"] ?? 0),
        valueSats: num(o["value"] ?? 0),
        confirmed: status?.["confirmed"] === true,
      };
    }), "mempool.space");
}

function guardBlockchainInfoAddr(raw: unknown): { info: BareWalletInfo; txs: BareWalletTx[] } {
  return guardShape("blockchain.info-rawaddr", raw, (v) => {
    const o = expectRecord(v);
    const address = reqString(o, "address");
    const info: BareWalletInfo = {
      address,
      chain: "bitcoin",
      balanceSats: num(o["final_balance"] ?? 0),
      txCount: num(o["n_tx"] ?? 0),
    };
    const txs: BareWalletTx[] = expectArray(o["txs"] ?? []).map((t) => {
      const tx = expectRecord(t);
      return {
        hash: reqString(tx, "hash"),
        address,
        timestamp: tx["time"] != null ? isoDate(num(tx["time"])) : undefined,
      };
    });
    return { info, txs };
  }, "blockchain.info");
}

export class WalletBundle extends BundleBase {
  constructor(opts: BundleSharedOptions = {}) {
    super(opts);
  }

  /** Address summary (mempool.space). Account state → default maxAge 300s. */
  async addressInfo(args: { address: string }, options?: ReadOptions): Promise<WalletInfo> {
    return this.readOne({
      bundleId: WALLET_BUNDLE_ID,
      source: "mempool.space",
      cacheKey: this.key(WALLET_BUNDLE_ID, "address", args.address),
      defaultMaxAgeSec: 300,
      ttlSec: 900,
      options,
      fetch: async () => {
        const t = this.transport("https://mempool.space/api", "mempool.space");
        const { data } = await t.request({
          path: `/address/${args.address}`,
          guard: (raw) => guardMempoolAddress(raw, args.address),
        });
        return data;
      },
    });
  }

  /** Address transactions, newest first (mempool.space). */
  async addressTxs(args: { address: string }, options?: ReadOptions): Promise<WalletTx[]> {
    return this.readMany({
      bundleId: WALLET_BUNDLE_ID,
      source: "mempool.space",
      cacheKey: this.key(WALLET_BUNDLE_ID, "address-txs", args.address),
      defaultMaxAgeSec: 300,
      ttlSec: 900,
      options,
      fetch: async () => {
        const t = this.transport("https://mempool.space/api", "mempool.space");
        const { data } = await t.request({
          path: `/address/${args.address}/txs`,
          guard: (raw) => guardMempoolTxs(raw, args.address),
        });
        return data;
      },
    });
  }

  /** Unspent outputs (mempool.space). */
  async addressUtxos(args: { address: string }, options?: ReadOptions): Promise<Utxo[]> {
    return this.readMany({
      bundleId: WALLET_BUNDLE_ID,
      source: "mempool.space",
      cacheKey: this.key(WALLET_BUNDLE_ID, "address-utxo", args.address),
      defaultMaxAgeSec: 300,
      ttlSec: 900,
      options,
      fetch: async () => {
        const t = this.transport("https://mempool.space/api", "mempool.space");
        const { data } = await t.request({
          path: `/address/${args.address}/utxo`,
          guard: guardMempoolUtxos,
        });
        return data;
      },
    });
  }

  /** Address summary via blockchain.info REST (second keyless source). */
  async blockchainInfoAddress(args: { address: string }, options?: ReadOptions): Promise<WalletInfo> {
    return this.readOne({
      bundleId: WALLET_BUNDLE_ID,
      source: "blockchain.info",
      cacheKey: this.key(WALLET_BUNDLE_ID, "bci-address", args.address),
      defaultMaxAgeSec: 300,
      ttlSec: 900,
      options,
      fetch: async () => {
        const t = this.transport("https://blockchain.info", "blockchain.info");
        const { data } = await t.request({
          path: `/rawaddr/${args.address}`,
          query: { limit: 50 },
          guard: guardBlockchainInfoAddr,
        });
        return data.info;
      },
    });
  }

  /** Recent txs via blockchain.info REST (same payload as address summary). */
  async blockchainInfoTxs(args: { address: string }, options?: ReadOptions): Promise<WalletTx[]> {
    return this.readMany({
      bundleId: WALLET_BUNDLE_ID,
      source: "blockchain.info",
      cacheKey: this.key(WALLET_BUNDLE_ID, "bci-txs", args.address),
      defaultMaxAgeSec: 300,
      ttlSec: 900,
      options,
      fetch: async () => {
        const t = this.transport("https://blockchain.info", "blockchain.info");
        const { data } = await t.request({
          path: `/rawaddr/${args.address}`,
          query: { limit: 50 },
          guard: guardBlockchainInfoAddr,
        });
        return data.txs;
      },
    });
  }
}
