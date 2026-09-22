/**
 * Shared bundle base: every bundle read goes through `readOne`/`readMany`,
 * which enforce the §7.3 freshness contract:
 *
 *   1. Serve from cache when the entry is within `maxAge`  → freshness CACHED.
 *   2. Otherwise fetch fresh                                → freshness LIVE.
 *   3. If the fetch fails and only stale cache exists       → throw StaleData
 *      (with lastFetchedAt + oldestAcceptable) instead of silently
 *      returning old data. Auth/license/deprecation errors always
 *      propagate unchanged; with no cache at all the original error
 *      propagates (it explains why there is no data).
 *
 * Every read also records one heartbeat call for its bundle id (§3.3).
 */
import { MemoryCache } from "../core/cache.js";
import { StaleData, UnifiedDataError } from "../core/errors.js";
import { LicenseClient } from "../core/license.js";
import { Transport, type FetchFn, type TransportOptions } from "../core/transport.js";
import type { Provenance, ReadOptions } from "../types/index.js";

export interface BundleSharedOptions {
  fetch?: FetchFn;
  license?: LicenseClient;
  cache?: MemoryCache;
  contactEmail?: string;
  /**
   * Clock for freshness math. Defaults to the cache's clock (which is
   * `Date.now` unless a test injects one), so cache timestamps and
   * maxAge comparisons always agree.
   */
  now?: () => number;
}

export interface ReadArgs<T> {
  bundleId: string;
  /** Provenance label, e.g. "binance", "sec-edgar". */
  source: string;
  cacheKey: string;
  /** Default maxAge in seconds when the caller doesn't pass one. */
  defaultMaxAgeSec: number;
  /** Cache TTL in seconds (≥ maxAge). */
  ttlSec: number;
  /** Fresh fetch; returns data WITHOUT provenance (attached here). */
  fetch: () => Promise<T>;
  options?: ReadOptions;
}

/** Errors that must never be converted into StaleData. */
const PASS_THROUGH_CODES = new Set([
  "UpstreamAuthRequired",
  "UpstreamSchemaDrift",
  "UpstreamDeprecated",
  "LicenseInvalid",
  "BundleNotLicensed",
]);

export abstract class BundleBase {
  protected readonly license?: LicenseClient;
  protected readonly cache: MemoryCache;
  protected readonly fetch?: FetchFn;
  protected readonly contactEmail?: string;
  private readonly nowFn: () => number;

  constructor(opts: BundleSharedOptions = {}) {
    this.license = opts.license;
    this.cache = opts.cache ?? new MemoryCache();
    this.fetch = opts.fetch;
    this.contactEmail = opts.contactEmail;
    // Share the cache's clock so maxAge math and entry timestamps agree.
    this.nowFn = opts.now ?? (() => this.cache.nowMs());
  }

  protected transport(baseUrl: string, source: string, extra?: Partial<TransportOptions>): Transport {
    return new Transport({ baseUrl, source, fetch: this.fetch, contactEmail: this.contactEmail, ...extra });
  }

  private withProvenance<T extends object>(
    items: T[],
    source: string,
    fetchedAtMs: number,
    freshness: Provenance["freshness"],
  ): Array<T & Provenance> {
    const fetchedAt = new Date(fetchedAtMs).toISOString();
    return items.map((item) => ({ ...item, source, fetchedAt, freshness }));
  }

  protected async readMany<T extends object>(args: ReadArgs<T[]>): Promise<Array<T & Provenance>> {
    const maxAgeSec = args.options?.maxAge ?? args.defaultMaxAgeSec;
    const maxAgeMs = maxAgeSec * 1000;
    this.license?.assertBundleAllowed(args.bundleId);
    this.license?.recordCall(args.bundleId);

    const now = this.nowFn();
    const cached = this.cache.get<T[]>(args.cacheKey);
    // maxAge: 0 (or negative) means "never serve cached"; Infinity accepts any retained entry.
    const fresh =
      cached && maxAgeSec > 0 && (maxAgeSec === Infinity || now - cached.fetchedAtMs <= maxAgeMs)
        ? cached
        : undefined;
    if (fresh) {
      return this.withProvenance(fresh.value, args.source, fresh.fetchedAtMs, "CACHED");
    }

    try {
      const data = await args.fetch();
      const entry = this.cache.set(args.cacheKey, data, args.ttlSec * 1000);
      return this.withProvenance(data, args.source, entry.fetchedAtMs, "LIVE");
    } catch (err) {
      if (err instanceof UnifiedDataError && PASS_THROUGH_CODES.has(err.code)) throw err;
      const stale = this.cache.get<T[]>(args.cacheKey);
      if (stale) {
        throw new StaleData(
          `No result for "${args.cacheKey}" satisfies maxAge=${maxAgeSec}s ` +
            `(newest cached fetch: ${new Date(stale.fetchedAtMs).toISOString()}).`,
          {
            source: args.source,
            lastFetchedAt: new Date(stale.fetchedAtMs).toISOString(),
            oldestAcceptable: new Date(now - maxAgeMs).toISOString(),
            cause: err,
          },
        );
      }
      throw err;
    }
  }

  protected async readOne<T extends object>(args: ReadArgs<T>): Promise<T & Provenance> {
    const [first] = await this.readMany({ ...args, fetch: async () => [await args.fetch()] });
    return first;
  }

  /** Cache key helper: stable, namespaced, no user data beyond the lookup key. */
  protected key(...parts: Array<string | number>): string {
    return parts.join(":");
  }
}
