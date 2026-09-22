/**
 * REST adapter + PollingAdapter (§2.7 "Feed adapter design").
 *
 * PollingAdapter: scheduled fetch with per-source cadence, ETag/Last-Modified
 * conditional requests (304 → no re-download), content-hash dedup, and
 * item-level normalization. Every adapter exposes the identical surface:
 * `connect()`/`start()`, `disconnect()`/`stop()`, `on(event)`, `snapshot()`,
 * `health()` — so bundles treat feeds and REST endpoints uniformly.
 */
import { Transport, type FetchFn } from "../core/transport.js";
import type { Provenance } from "../types/index.js";

export interface PollFetchResult<T> {
  items: T[];
  notModified: boolean;
  etag?: string;
  lastModified?: string;
  fetchedAtMs: number;
}

export interface RestAdapterOptions {
  transport: Transport;
  /** Normalize one raw payload into items (e.g. every feed item → NewsItem-ish). */
  normalize?: (raw: unknown, source: string, fetchedAt: string) => unknown[];
  fetch?: FetchFn;
}

export class RestAdapter {
  protected readonly transport: Transport;
  protected readonly normalize?: (raw: unknown, source: string, fetchedAt: string) => unknown[];

  constructor(opts: RestAdapterOptions) {
    this.transport = opts.transport;
    this.normalize = opts.normalize;
  }

  /**
   * GET with conditional validators. On 304 the caller keeps its cached copy
   * (`notModified: true`) — no re-download, no re-parse.
   */
  async get<T>(path: string, opts: {
    query?: Record<string, string | number | boolean | undefined | null>;
    headers?: Record<string, string>;
    guard?: (raw: unknown) => T;
    /** Response kind — "text" for RSS/Atom/iCal feeds. */
    response?: "json" | "text" | "bytes";
    etag?: string;
    lastModified?: string;
    signal?: AbortSignal;
  } = {}): Promise<PollFetchResult<T>> {
    const res = await this.transport.conditionalGet<T>({
      path,
      query: opts.query,
      headers: opts.headers,
      guard: opts.guard,
      response: opts.response,
      signal: opts.signal,
      validators: { etag: opts.etag, lastModified: opts.lastModified },
    });
    const fetchedAtMs = Date.now();
    if (res.notModified) {
      return { items: [], notModified: true, fetchedAtMs, etag: opts.etag, lastModified: opts.lastModified };
    }
    const items = this.normalize
      ? (this.normalize(res.data, this.transport.source, new Date(fetchedAtMs).toISOString()) as T[])
      : [res.data];
    return {
      items,
      notModified: false,
      etag: res.headers.get("etag") ?? opts.etag,
      lastModified: res.headers.get("last-modified") ?? opts.lastModified,
      fetchedAtMs,
    };
  }

  /**
   * List variant of {@link get} for endpoints that return an array payload.
   * Returns `PollFetchResult<T>` with `items: T[]` (no extra wrapping):
   * the guard sees the whole array, `normalize` output is the item list.
   */
  async getList<T>(path: string, opts: {
    query?: Record<string, string | number | boolean | undefined | null>;
    headers?: Record<string, string>;
    guard?: (raw: unknown) => T[];
    /** Response kind — "text" for RSS/Atom/iCal feeds. */
    response?: "json" | "text" | "bytes";
    etag?: string;
    lastModified?: string;
    signal?: AbortSignal;
  } = {}): Promise<PollFetchResult<T>> {
    const res = await this.transport.conditionalGet<T[]>({
      path,
      query: opts.query,
      headers: opts.headers,
      guard: opts.guard,
      response: opts.response,
      signal: opts.signal,
      validators: { etag: opts.etag, lastModified: opts.lastModified },
    });
    const fetchedAtMs = Date.now();
    if (res.notModified) {
      return { items: [], notModified: true, fetchedAtMs, etag: opts.etag, lastModified: opts.lastModified };
    }
    const items = this.normalize
      ? (this.normalize(res.data, this.transport.source, new Date(fetchedAtMs).toISOString()) as T[])
      : res.data;
    return {
      items,
      notModified: false,
      etag: res.headers.get("etag") ?? opts.etag,
      lastModified: res.headers.get("last-modified") ?? opts.lastModified,
      fetchedAtMs,
    };
  }
}

// ---------------------------------------------------------------------------
// PollingAdapter
// ---------------------------------------------------------------------------

export type PollingEvents<T> = {
  items: (items: Array<T & { fetchedAt: string }>) => void;
  error: (err: unknown) => void;
  poll: (info: { notModified: boolean; fetchedAtMs: number }) => void;
};

export interface PollingAdapterOptions<T> {
  adapter: RestAdapter;
  path: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  headers?: Record<string, string>;
  guard?: (raw: unknown) => T[];
  /** Poll cadence ms (per-source default; status pages 1–5 min). */
  intervalMs: number;
  /** Dedupe key per item (default: JSON hash). Only new items are emitted. */
  idOf?: (item: T) => string;
  /** Cap on retained snapshot items (default 500). */
  maxItems?: number;
  /** Response kind — "text" for RSS/Atom/iCal feeds. */
  response?: "json" | "text" | "bytes";
  /** Freshness source label for emitted items. */
  source: string;
}

export interface PollingHealth {
  running: boolean;
  lastPollAt?: string;
  lastNewItemAt?: string;
  totalSeen: number;
  consecutiveErrors: number;
  /** True when no new item arrived within 3× the expected cadence (§7.4). */
  stale: boolean;
  expectedCadenceMs: number;
}

function defaultIdOf(item: unknown): string {
  const s = typeof item === "string" ? item : JSON.stringify(item);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return `h${(h >>> 0).toString(16)}`;
}

export class PollingAdapter<T> {
  private readonly opts: PollingAdapterOptions<T>;
  private readonly listeners: { [K in keyof PollingEvents<T>]: Array<PollingEvents<T>[K]> } = {
    items: [],
    error: [],
    poll: [],
  };
  private timer?: ReturnType<typeof setInterval>;
  private etag?: string;
  private lastModified?: string;
  private seen = new Map<string, T & { fetchedAt: string }>();
  private lastPollAtMs?: number;
  private lastNewItemAtMs?: number;
  private consecutiveErrors = 0;
  private polling = false;

  constructor(opts: PollingAdapterOptions<T>) {
    this.opts = opts;
  }

  on<K extends keyof PollingEvents<T>>(event: K, cb: PollingEvents<T>[K]): this {
    this.listeners[event].push(cb);
    return this;
  }

  private emit<K extends keyof PollingEvents<T>>(event: K, ...args: Parameters<PollingEvents<T>[K]>): void {
    for (const cb of this.listeners[event]) {
      try {
        (cb as (...a: unknown[]) => void)(...args);
      } catch {
        // Listener errors must not break the poll loop.
      }
    }
  }

  /** Start polling (immediate first poll, then on cadence). */
  start(): this {
    if (this.timer) return this;
    void this.pollOnce();
    const timer = setInterval(() => void this.pollOnce(), this.opts.intervalMs);
    (timer as { unref?: () => void }).unref?.();
    this.timer = timer;
    return this;
  }

  /** Alias matching the uniform adapter surface (`connect`/`disconnect`). */
  connect(): this {
    return this.start();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  disconnect(): void {
    this.stop();
  }

  async pollOnce(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const res = await this.opts.adapter.getList<T>(this.opts.path, {
        query: this.opts.query,
        headers: this.opts.headers,
        guard: this.opts.guard,
        response: this.opts.response,
        etag: this.etag,
        lastModified: this.lastModified,
      });
      this.lastPollAtMs = res.fetchedAtMs;
      if (!res.notModified) {
        this.etag = res.etag;
        this.lastModified = res.lastModified;
        const idOf = this.opts.idOf ?? defaultIdOf;
        const fresh: Array<T & { fetchedAt: string }> = [];
        const fetchedAt = new Date(res.fetchedAtMs).toISOString();
        for (const item of res.items) {
          const id = idOf(item);
          if (!this.seen.has(id)) {
            const withTs = { ...item, fetchedAt } as T & { fetchedAt: string };
            this.seen.set(id, withTs);
            fresh.push(withTs);
          }
        }
        const max = this.opts.maxItems ?? 500;
        while (this.seen.size > max) {
          const oldest = this.seen.keys().next().value as string | undefined;
          if (oldest === undefined) break;
          this.seen.delete(oldest);
        }
        if (fresh.length > 0) {
          this.lastNewItemAtMs = res.fetchedAtMs;
          this.emit("items", fresh);
        }
      }
      this.consecutiveErrors = 0;
      this.emit("poll", { notModified: res.notModified, fetchedAtMs: res.fetchedAtMs });
    } catch (err) {
      this.consecutiveErrors += 1;
      this.emit("error", err);
    } finally {
      this.polling = false;
    }
  }

  /** All items seen (newest last), capped at maxItems. */
  snapshot(): Array<T & { fetchedAt: string }> {
    return [...this.seen.values()];
  }

  health(): PollingHealth {
    const sinceNew = this.lastNewItemAtMs != null ? Date.now() - this.lastNewItemAtMs : undefined;
    return {
      running: this.timer != null,
      lastPollAt: this.lastPollAtMs != null ? new Date(this.lastPollAtMs).toISOString() : undefined,
      lastNewItemAt: this.lastNewItemAtMs != null ? new Date(this.lastNewItemAtMs).toISOString() : undefined,
      totalSeen: this.seen.size,
      consecutiveErrors: this.consecutiveErrors,
      stale: sinceNew != null && sinceNew > 3 * this.opts.intervalMs,
      expectedCadenceMs: this.opts.intervalMs,
    };
  }

  provenance(): Pick<Provenance, "source"> {
    return { source: this.opts.source };
  }
}
