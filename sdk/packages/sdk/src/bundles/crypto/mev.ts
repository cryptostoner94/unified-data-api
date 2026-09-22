/**
 * MEV bundle (`crypto.mev`) — mempool, pending-tx, relay data, extraction stats.
 *
 * Sources (all KEYLESS):
 *   - mempool.space REST  https://mempool.space/api
 *     (WS is partially UNVERIFIED per spec — this bundle uses REST polling)
 *   - Flashbots / Ultrasound / bloXroute MEV-Boost relay data API
 *   - blockchain.info WS  wss://ws.blockchain.info/inv (unconfirmed_sub)
 *
 * Feeds the m11-platform trading-engine track (read-only context): relay bid
 * traces and mempool feeds are the raw inputs for bundle-visibility and
 * pending-tx analysis.
 */
import { BundleBase, type BundleSharedOptions } from "../base.js";
import { PollingAdapter } from "../../adapters/rest.js";
import { RestAdapter } from "../../adapters/rest.js";
import { StreamAdapter, type StreamEvent } from "../../adapters/ws.js";
import { Transport } from "../../core/transport.js";
import { expectArray, expectRecord, guardShape, isoDate, num, optNumber, reqNumber, reqString } from "../../core/schema.js";
import type { FeeEstimate, MempoolStats, MempoolTx, ReadOptions, RelayBid } from "../../types/index.js";

export const MEV_BUNDLE_ID = "crypto.mev";

/** Known MEV-Boost relay data-API bases (spec §2.1). */
export const RELAYS = {
  flashbots: "https://boost-relay.flashbots.net",
  ultrasound: "https://relay.ultrasound.money",
  bloxroute: "https://bloxroute.max-profit.blxrbdn.com",
} as const;

export interface MevBundleOptions extends BundleSharedOptions {
  /** Override the relay base URL (default Flashbots). */
  relayBaseUrl?: string;
}

function guardFeeEstimate(raw: unknown): Omit<FeeEstimate, "source" | "fetchedAt" | "freshness"> {
  return guardShape("mempool-fees", raw, (v) => {
    const o = expectRecord(v);
    return {
      fastestSatVbyte: reqNumber(o, "fastestFee"),
      halfHourSatVbyte: reqNumber(o, "halfHourFee"),
      hourSatVbyte: reqNumber(o, "hourFee"),
      economySatVbyte: reqNumber(o, "economyFee"),
      minimumSatVbyte: reqNumber(o, "minimumFee"),
    };
  }, "mempool.space");
}

function guardRecentTxs(raw: unknown): Array<Omit<MempoolTx, "source" | "fetchedAt" | "freshness">> {
  return guardShape("mempool-recent", raw, (v) => {
    return expectArray(v).map((t) => {
      const o = expectRecord(t);
      return {
        hash: reqString(o, "txid"),
        feeSatVbyte: optNumber(o, "fee") != null && optNumber(o, "vsize") ? Math.round((o["fee"] as number) / (o["vsize"] as number)) : undefined,
        firstSeen: new Date().toISOString(),
        valueSats: optNumber(o, "value"),
      };
    });
  }, "mempool.space");
}

function guardMempoolStats(raw: unknown): { txCount: number; vBytes: number; totalFeeSats: number } {
  return guardShape("mempool-stats", raw, (v) => {
    const o = expectRecord(v);
    return { txCount: reqNumber(o, "count"), vBytes: reqNumber(o, "vBytes"), totalFeeSats: reqNumber(o, "totalFee") };
  }, "mempool.space");
}

function guardRelayBids(raw: unknown, relay: string): Array<Omit<RelayBid, "source" | "fetchedAt" | "freshness">> {
  return guardShape("relay-bidtraces", raw, (v) => {
    return expectArray(v).map((b) => {
      const o = expectRecord(b);
      const slot = o["slot"];
      return {
        slot: typeof slot === "number" || typeof slot === "string" ? slot : String(slot ?? "?"),
        builder: String(o["builder_pubkey"] ?? o["builder"] ?? "unknown"),
        value: String(o["value"] ?? "0"),
        relay,
      };
    });
  }, relay);
}

export class MevBundle extends BundleBase {
  private readonly mempool: Transport;
  private readonly relayBaseUrl: string;
  private relayTransport?: Transport;

  constructor(opts: MevBundleOptions = {}) {
    super(opts);
    this.mempool = this.transport("https://mempool.space/api", "mempool.space");
    this.relayBaseUrl = opts.relayBaseUrl ?? RELAYS.flashbots;
  }

  private relay(): Transport {
    if (!this.relayTransport || this.relayTransport.baseUrl !== this.relayBaseUrl) {
      this.relayTransport = this.transport(this.relayBaseUrl, "mev-relay");
    }
    return this.relayTransport;
  }

  /** Recommended fee rates (sat/vByte). Price-like → default maxAge 120s. */
  async feeEstimates(options?: ReadOptions): Promise<FeeEstimate> {
    return this.readOne({
      bundleId: MEV_BUNDLE_ID,
      source: "mempool.space",
      cacheKey: this.key(MEV_BUNDLE_ID, "fees"),
      defaultMaxAgeSec: 120,
      ttlSec: 300,
      options,
      fetch: async () => {
        const { data } = await this.mempool.request({ path: "/v1/fees/recommended", guard: guardFeeEstimate });
        return data;
      },
    });
  }

  /** Mempool backlog stats + chain tip height. Feed → default maxAge 900s. */
  async mempoolStats(options?: ReadOptions): Promise<MempoolStats> {
    return this.readOne({
      bundleId: MEV_BUNDLE_ID,
      source: "mempool.space",
      cacheKey: this.key(MEV_BUNDLE_ID, "mempool-stats"),
      defaultMaxAgeSec: 900,
      ttlSec: 1800,
      options,
      fetch: async () => {
        const [{ data: stats }, tip] = await Promise.all([
          this.mempool.request({ path: "/mempool", guard: guardMempoolStats }),
          this.mempool.request<string>({ path: "/blocks/tip/height", response: "text" }).catch(() => undefined),
        ]);
        const tipHeight = tip ? Number(tip.data.trim()) : undefined;
        return { ...stats, tipHeight: Number.isFinite(tipHeight) ? tipHeight : undefined };
      },
    });
  }

  /** Recently-seen mempool transactions. Feed → default maxAge 900s. */
  async recentTxs(limit = 25, options?: ReadOptions): Promise<MempoolTx[]> {
    return this.readMany({
      bundleId: MEV_BUNDLE_ID,
      source: "mempool.space",
      cacheKey: this.key(MEV_BUNDLE_ID, "recent", limit),
      defaultMaxAgeSec: 900,
      ttlSec: 1800,
      options,
      fetch: async () => {
        const { data } = await this.mempool.request({ path: "/mempool/recent", guard: guardRecentTxs });
        return data.slice(0, limit);
      },
    });
  }

  /** Bids delivered to proposers (per relay). Feed → default maxAge 900s. */
  async relayBids(limit = 100, options?: ReadOptions & { relayBaseUrl?: string }): Promise<RelayBid[]> {
    const relay = options?.relayBaseUrl ?? this.relayBaseUrl;
    return this.readMany({
      bundleId: MEV_BUNDLE_ID,
      source: "mev-relay",
      cacheKey: this.key(MEV_BUNDLE_ID, "proposer-payload-delivered", relay, limit),
      defaultMaxAgeSec: 900,
      ttlSec: 1800,
      options,
      fetch: async () => {
        const t = this.transport(relay, "mev-relay");
        const { data } = await t.request({
          path: "/relay/v1/data/bidtraces/proposer_payload_delivered",
          query: { limit },
          guard: (raw) => guardRelayBids(raw, relay),
        });
        return data;
      },
    });
  }

  /** Blocks received from builders (per relay). Feed → default maxAge 900s. */
  async builderBlocks(limit = 100, options?: ReadOptions & { relayBaseUrl?: string }): Promise<RelayBid[]> {
    const relay = options?.relayBaseUrl ?? this.relayBaseUrl;
    return this.readMany({
      bundleId: MEV_BUNDLE_ID,
      source: "mev-relay",
      cacheKey: this.key(MEV_BUNDLE_ID, "builder-blocks-received", relay, limit),
      defaultMaxAgeSec: 900,
      ttlSec: 1800,
      options,
      fetch: async () => {
        const t = this.transport(relay, "mev-relay");
        const { data } = await t.request({
          path: "/relay/v1/data/bidtraces/builder_blocks_received",
          query: { limit },
          guard: (raw) => guardRelayBids(raw, relay),
        });
        return data;
      },
    });
  }

  /**
   * Live unconfirmed-transaction stream via blockchain.info WS.
   * Returns a StreamAdapter — call `.connect()`. Events are LIVE while the
   * subscription is healthy (§7.2).
   */
  streamUnconfirmedTxs(): StreamAdapter {
    return new StreamAdapter({
      url: "wss://ws.blockchain.info/inv",
      source: "blockchain.info",
      subscribe: (send) => send({ op: "unconfirmed_sub" }),
      parseMessage: (data): StreamEvent | null => {
        let msg: unknown = data;
        if (typeof data === "string") {
          try {
            msg = JSON.parse(data);
          } catch {
            return null;
          }
        }
        const o = expectRecord(msg);
        if (o["op"] !== "utx") return null;
        const x = expectRecord(o["x"]);
        const receivedAt = new Date().toISOString();
        const tx: Omit<MempoolTx, "source" | "fetchedAt" | "freshness"> = {
          hash: String(x["hash"] ?? ""),
          firstSeen: x["time"] != null ? isoDate(num(x["time"]), "time") : receivedAt,
          valueSats: undefined,
        };
        return { kind: "mempool-tx", receivedAt, data: tx };
      },
    });
  }

  /**
   * REST-polling fallback for mempool stats (the mempool.space WS is
   * partially UNVERIFIED per spec — prefer this over a socket there).
   */
  pollMempoolStats(intervalMs = 60_000): PollingAdapter<Omit<MempoolStats, "source" | "fetchedAt" | "freshness">> {
    return new PollingAdapter({
      adapter: new RestAdapter({ transport: this.mempool }),
      path: "/mempool",
      intervalMs,
      source: "mempool.space",
      guard: (raw) => [guardMempoolStats(raw)],
      idOf: (s) => `${s.txCount}:${s.vBytes}:${s.totalFeeSats}`,
    });
  }
}
