/**
 * Client-side cache (§3.2): per-endpoint TTLs, stale-while-revalidate,
 * persisted to localStorage/IndexedDB (browser) or disk (Node) when available.
 *
 * v1 ships an in-memory store plus an optional persistence backend interface.
 * `maxAge` enforcement (§7.3) reads through here: `getFresh(key, maxAgeMs)`
 * returns the entry only when it is young enough.
 */

export interface CacheEntry<T> {
  value: T;
  /** Epoch ms when the value was fetched. */
  fetchedAtMs: number;
  /** How long the entry may live in the cache (epoch-ms absolute). */
  expiresAtMs: number;
  /** Conditional-request validators, when the upstream supplied them. */
  etag?: string;
  lastModified?: string;
}

/** Minimal persistence backend; the SDK never requires one. */
export interface CacheBackend {
  load(): Record<string, CacheEntry<unknown>> | undefined;
  save(entries: Record<string, CacheEntry<unknown>>): void;
}

/** localStorage-backed persistence; silently no-ops where unavailable. */
export class LocalStorageBackend implements CacheBackend {
  constructor(private readonly storageKey = "unified-data-sdk:cache:v1") {}
  private storage(): Storage | undefined {
    try {
      return typeof localStorage !== "undefined" ? localStorage : undefined;
    } catch {
      return undefined;
    }
  }
  load(): Record<string, CacheEntry<unknown>> | undefined {
    try {
      const raw = this.storage()?.getItem(this.storageKey);
      if (!raw) return undefined;
      const parsed = JSON.parse(raw) as Record<string, CacheEntry<unknown>>;
      return parsed && typeof parsed === "object" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  save(entries: Record<string, CacheEntry<unknown>>): void {
    try {
      this.storage()?.setItem(this.storageKey, JSON.stringify(entries));
    } catch {
      // Quota or privacy mode — caching degrades to memory-only.
    }
  }
}

export interface MemoryCacheOptions {
  /** Default TTL for entries, ms (default 5 min). */
  defaultTtlMs?: number;
  /** Max entries before oldest-first eviction (default 1000). */
  maxEntries?: number;
  /** Optional persistence backend (loaded lazily on first read). */
  backend?: CacheBackend;
  /** Clock (injectable for tests). */
  now?: () => number;
}

export class MemoryCache {
  private entries = new Map<string, CacheEntry<unknown>>();
  private loaded = false;
  private readonly defaultTtlMs: number;
  private readonly maxEntries: number;
  private readonly backend?: CacheBackend;
  private readonly now: () => number;

  constructor(opts: MemoryCacheOptions = {}) {
    this.defaultTtlMs = opts.defaultTtlMs ?? 5 * 60 * 1000;
    this.maxEntries = opts.maxEntries ?? 1000;
    this.backend = opts.backend;
    this.now = opts.now ?? Date.now;
  }

  /** Current time per the injected clock (tests may fake the clock). */
  nowMs(): number {
    return this.now();
  }

  private ensureLoaded(): void {
    if (this.loaded || !this.backend) {
      this.loaded = true;
      return;
    }
    this.loaded = true;
    const persisted = this.backend.load();
    if (persisted) {
      const now = this.now();
      for (const [k, e] of Object.entries(persisted)) {
        if (e && typeof e === "object" && e.expiresAtMs > now) this.entries.set(k, e);
      }
    }
  }

  private persist(): void {
    if (!this.backend) return;
    try {
      this.backend.save(Object.fromEntries(this.entries));
    } catch {
      // Persistence is best-effort.
    }
  }

  get<T>(key: string): CacheEntry<T> | undefined {
    this.ensureLoaded();
    const entry = this.entries.get(key) as CacheEntry<T> | undefined;
    if (!entry) return undefined;
    if (entry.expiresAtMs <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  /**
   * Return the entry only if it is not older than `maxAgeMs`.
   * This is the §7.3 enforcement point: callers that cannot accept older data
   * get `undefined` and must fetch fresh (or throw StaleData).
   */
  getFresh<T>(key: string, maxAgeMs: number): CacheEntry<T> | undefined {
    const entry = this.get<T>(key);
    if (!entry) return undefined;
    if (maxAgeMs === Infinity) return entry;
    return this.now() - entry.fetchedAtMs <= maxAgeMs ? entry : undefined;
  }

  set<T>(key: string, value: T, ttlMs?: number, validators?: { etag?: string; lastModified?: string }): CacheEntry<T> {
    this.ensureLoaded();
    const now = this.now();
    const entry: CacheEntry<T> = {
      value,
      fetchedAtMs: now,
      expiresAtMs: now + (ttlMs ?? this.defaultTtlMs),
      ...validators,
    };
    this.entries.set(key, entry);
    // Oldest-first eviction (Map preserves insertion order).
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.persist();
    return entry;
  }

  /**
   * Stale-while-revalidate: return the cached value immediately when present
   * (even if older than `maxAgeMs`), then refresh in the background.
   * The returned `freshness` reflects what was actually served.
   */
  async swr<T>(
    key: string,
    maxAgeMs: number,
    ttlMs: number,
    fetcher: () => Promise<T>,
  ): Promise<{ value: T; fetchedAtMs: number; freshness: "LIVE" | "CACHED" }> {
    const fresh = this.getFresh<T>(key, maxAgeMs);
    if (fresh) return { value: fresh.value, fetchedAtMs: fresh.fetchedAtMs, freshness: "CACHED" };
    const stale = this.get<T>(key);
    const refresh = fetcher()
      .then((value) => this.set(key, value, ttlMs))
      .catch(() => undefined);
    if (stale) {
      // Serve stale now; refresh in background (un-awaited by design).
      void refresh;
      return { value: stale.value, fetchedAtMs: stale.fetchedAtMs, freshness: "CACHED" };
    }
    const entry = await refresh.then((e) => e ?? fetcher().then((v) => this.set(key, v, ttlMs)));
    return { value: entry.value, fetchedAtMs: entry.fetchedAtMs, freshness: "LIVE" };
  }

  invalidate(key: string): void {
    this.entries.delete(key);
    this.persist();
  }

  clear(): void {
    this.entries.clear();
    this.persist();
  }

  size(): number {
    this.ensureLoaded();
    return this.entries.size;
  }
}
