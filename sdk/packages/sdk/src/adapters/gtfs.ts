/**
 * BinaryAdapter (§2.7 "Feed adapter design"): GTFS-Realtime protobuf feeds.
 *
 * WORKING STUB: the poll → decode → typed-entities → event pipeline is fully
 * implemented (conditional GET, cadence, snapshot/health surface identical to
 * the other adapters). The protobuf *decoder* itself is injected via `decode`
 * because GTFS-RT decoding needs a protobuf runtime (e.g. the
 * `gtfs-realtime-bindings` package), which is a per-app dependency choice.
 *
 * Wire it like:
 *   import { transit_realtime } from "gtfs-realtime-bindings";
 *   const adapter = new BinaryAdapter({
 *     decode: (bytes) => decodeGtfsRt(transit_realtime.FeedMessage.decode(bytes)),
 *   });
 */
import type { FetchFn } from "../core/transport.js";
import { UpstreamSchemaDrift } from "../core/errors.js";

export type GtfsRtEntityType = "trip_update" | "vehicle" | "alert";

export interface GtfsRtEntity {
  id: string;
  type: GtfsRtEntityType;
  /** Decoded entity payload (feed-agnostic shape — pass through). */
  data: unknown;
}

export type GtfsRtDecoder = (bytes: Uint8Array) => GtfsRtEntity[];

export interface BinaryAdapterOptions {
  decode?: GtfsRtDecoder;
  fetch?: FetchFn;
  /** Poll cadence ms — GTFS-RT agencies advertise 15–60s (§7.2: ~1 min effective). */
  pollIntervalMs?: number;
  headers?: Record<string, string>;
  source?: string;
}

export interface BinaryHealth {
  running: boolean;
  lastPollAt?: string;
  lastEntityAt?: string;
  entityCount: number;
  consecutiveErrors: number;
  stale: boolean;
  expectedCadenceMs: number;
}

/** Default decoder: explains how to plug in a real protobuf decoder. */
export function unconfiguredDecoder(bytes: Uint8Array): GtfsRtEntity[] {
  void bytes;
  throw new UpstreamSchemaDrift(
    "GTFS-RT protobuf decoder not configured — supply `decode` (e.g. via the `gtfs-realtime-bindings` package).",
    "gtfs-rt",
    { source: "gtfs-rt" },
  );
}

export class BinaryAdapter {
  private readonly decode: GtfsRtDecoder;
  private readonly fetchFn: FetchFn;
  private readonly headers: Record<string, string>;
  private readonly pollIntervalMs: number;
  private readonly source: string;
  private timer?: ReturnType<typeof setInterval>;
  private etag?: string;
  private entities: GtfsRtEntity[] = [];
  private lastPollAtMs?: number;
  private lastEntityAtMs?: number;
  private consecutiveErrors = 0;
  private polling = false;
  private readonly listeners: Record<"entities" | "error", Array<(arg: unknown) => void>> = {
    entities: [],
    error: [],
  };

  constructor(opts: BinaryAdapterOptions = {}) {
    this.decode = opts.decode ?? unconfiguredDecoder;
    const globalFetch = typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined;
    if (!opts.fetch && !globalFetch) throw new Error("BinaryAdapter requires a fetch implementation.");
    this.fetchFn = opts.fetch ?? (globalFetch as FetchFn);
    this.headers = opts.headers ?? {};
    this.pollIntervalMs = opts.pollIntervalMs ?? 60_000;
    this.source = opts.source ?? "gtfs-rt";
  }

  on(event: "entities", cb: (entities: GtfsRtEntity[]) => void): this;
  on(event: "error", cb: (err: unknown) => void): this;
  on(event: "entities" | "error", cb: (arg: never) => void): this {
    (this.listeners[event] as Array<(arg: never) => void>).push(cb);
    return this;
  }

  private emit(event: "entities" | "error", arg: unknown): void {
    for (const cb of this.listeners[event]) {
      try {
        (cb as (a: unknown) => void)(arg);
      } catch {
        // ignore listener errors
      }
    }
  }

  connect(url: string): this {
    this.disconnect();
    void this.pollOnce(url);
    const timer = setInterval(() => void this.pollOnce(url), this.pollIntervalMs);
    (timer as { unref?: () => void }).unref?.();
    this.timer = timer;
    return this;
  }

  disconnect(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async pollOnce(url: string): Promise<{ notModified: boolean; entityCount: number }> {
    if (this.polling) return { notModified: true, entityCount: this.entities.length };
    this.polling = true;
    try {
      const headers: Record<string, string> = { ...this.headers };
      if (this.etag) headers["If-None-Match"] = this.etag;
      const res = await this.fetchFn(url, { headers });
      this.lastPollAtMs = Date.now();
      if (res.status === 304) return { notModified: true, entityCount: this.entities.length };
      if (!res.ok) throw new Error(`GTFS-RT feed returned HTTP ${res.status}`);
      const etag = res.headers.get("etag");
      if (etag) this.etag = etag;
      const bytes = new Uint8Array(await res.arrayBuffer());
      const entities = this.decode(bytes);
      this.entities = entities;
      if (entities.length > 0) this.lastEntityAtMs = Date.now();
      this.consecutiveErrors = 0;
      this.emit("entities", entities);
      return { notModified: false, entityCount: entities.length };
    } catch (err) {
      this.consecutiveErrors += 1;
      this.emit("error", err);
      throw err;
    } finally {
      this.polling = false;
    }
  }

  snapshot(): GtfsRtEntity[] {
    return [...this.entities];
  }

  health(): BinaryHealth {
    const since = this.lastEntityAtMs != null ? Date.now() - this.lastEntityAtMs : undefined;
    return {
      running: this.timer != null,
      lastPollAt: this.lastPollAtMs != null ? new Date(this.lastPollAtMs).toISOString() : undefined,
      lastEntityAt: this.lastEntityAtMs != null ? new Date(this.lastEntityAtMs).toISOString() : undefined,
      entityCount: this.entities.length,
      consecutiveErrors: this.consecutiveErrors,
      stale: since != null && since > 3 * this.pollIntervalMs,
      expectedCadenceMs: this.pollIntervalMs,
    };
  }
}
