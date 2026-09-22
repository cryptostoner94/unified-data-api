/**
 * Direct-call HTTP client (§3.2).
 *
 * All public-data calls execute in the END USER's runtime (browser, Node, or
 * their server). Our servers never see data traffic. This client wraps fetch
 * with: per-source base URL + descriptive User-Agent (mandatory for SEC/NWS/
 * Nominatim), timeouts, abort support, a polite per-host throttle, and the
 * retry/backoff policy from core/retry.ts.
 *
 * No API keys of ours are ever shipped: keyless sources need none; GATED
 * sources take the end user's own key at bundle init.
 */
import { NetworkError, UnifiedDataError, UpstreamAuthRequired, UpstreamDeprecated, UpstreamRateLimited, UpstreamSchemaDrift } from "./errors.js";
import { parseRetryAfterMs, withRetry, type RetryOptions } from "./retry.js";
import { SDK_VERSION } from "../version.js";

export type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface TransportOptions {
  /** e.g. "https://data-api.binance.vision" */
  baseUrl: string;
  /** Short label used in the User-Agent and error provenance, e.g. "binance". */
  source: string;
  fetch?: FetchFn;
  /** Extra default headers (merged under the SDK defaults). */
  headers?: Record<string, string>;
  /** Request timeout ms (default 15_000). 0 disables. */
  timeoutMs?: number;
  /** Minimum gap between requests through this transport, ms (default 0). SEC needs ≥100. */
  minIntervalMs?: number;
  /** Retry policy override. */
  retry?: RetryOptions;
  /** Contact email embedded in the User-Agent (SEC requires name + contact). */
  contactEmail?: string;
}

/** Descriptive UA; SEC EDGAR rejects requests without name + contact email. */
export function defaultUserAgent(source: string, contactEmail = "sdk@unified-data.dev"): string {
  return `unified-data-sdk/${SDK_VERSION} (source: ${source}; +https://unified-data.dev; contact: ${contactEmail})`;
}

export interface RequestOptions<T> {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  /** Path relative to baseUrl, e.g. "/api/v3/klines". */
  path: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  headers?: Record<string, string>;
  /** Runtime shape guard applied to the decoded body (drives UpstreamSchemaDrift). */
  guard?: (raw: unknown) => T;
  /** Expected response kind. Default "json". */
  response?: "json" | "text" | "bytes";
  signal?: AbortSignal;
  /** Skip retry even for retryable errors (e.g. non-idempotent POSTs). */
  noRetry?: boolean;
}

export interface ConditionalValidators {
  etag?: string;
  lastModified?: string;
}

export class Transport {
  readonly baseUrl: string;
  readonly source: string;
  private readonly fetchFn: FetchFn;
  private readonly defaultHeaders: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly minIntervalMs: number;
  private readonly retryOpts?: RetryOptions;
  private lastRequestAt = 0;
  private throttleQueue: Promise<void> = Promise.resolve();

  constructor(opts: TransportOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.source = opts.source;
    const globalFetch = typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined;
    if (!opts.fetch && !globalFetch) throw new Error("Transport requires a fetch implementation (none provided and global fetch unavailable).");
    this.fetchFn = opts.fetch ?? (globalFetch as FetchFn);
    this.defaultHeaders = {
      "User-Agent": defaultUserAgent(opts.source, opts.contactEmail),
      Accept: "application/json",
      ...opts.headers,
    };
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.minIntervalMs = opts.minIntervalMs ?? 0;
    this.retryOpts = opts.retry;
  }

  buildUrl(path: string, query?: RequestOptions<unknown>["query"]): string {
    const url = new URL(path.startsWith("http") ? path : `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  private async throttle(): Promise<void> {
    if (this.minIntervalMs <= 0) return;
    const run = this.throttleQueue.then(async () => {
      const wait = this.minIntervalMs - (Date.now() - this.lastRequestAt);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastRequestAt = Date.now();
    });
    // Chain without letting a rejection break the queue.
    this.throttleQueue = run.catch(() => undefined);
    await run;
  }

  private async doFetch(url: string, init: RequestInit, guardName: string): Promise<Response> {
    await this.throttle();
    const controller = new AbortController();
    const timeout = this.timeoutMs > 0 ? setTimeout(() => controller.abort(new Error(`request timed out after ${this.timeoutMs}ms`)), this.timeoutMs) : undefined;
    try {
      return await this.fetchFn(url, { ...init, signal: init.signal ?? controller.signal });
    } catch (err) {
      throw this.toNetworkError(err, url, guardName);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private toNetworkError(err: unknown, url: string, guardName: string): NetworkError {
    if (err instanceof UnifiedDataError) return new NetworkError(err.message, { source: this.source, cause: err });
    const msg = err instanceof Error ? err.message : String(err);
    const aborted = (err instanceof Error && err.name === "AbortError") || /timed out|aborted/i.test(msg);
    return new NetworkError(`${aborted ? "Request timed out/aborted" : "Network failure"} calling ${this.source} (${guardName}): ${msg}`, {
      source: this.source,
      cause: err,
    });
  }

  /** Map HTTP status → taxonomy error. Returns undefined for 2xx. */
  private statusToError(res: Response, guardName: string): UnifiedDataError | undefined {
    if (res.status >= 200 && res.status < 300) return undefined;
    const where = `${this.source} ${guardName} → HTTP ${res.status}`;
    if (res.status === 429) {
      const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
      return new UpstreamRateLimited(`${where}: rate limited`, retryAfterMs, { source: this.source });
    }
    if (res.status === 401 || res.status === 403) {
      return new UpstreamAuthRequired(this.source, `${where}: authentication required (GATED source — the end user must supply their own key)`, {
        source: this.source,
      });
    }
    if (res.status === 410) return new UpstreamDeprecated(`${where}: endpoint gone`, { source: this.source });
    if (res.status >= 500) return new NetworkError(`${where}: upstream server error`, { source: this.source });
    return new NetworkError(`${where}: unexpected status`, { source: this.source, retryable: false });
  }

  async request<T>(opts: RequestOptions<T>): Promise<{ data: T; headers: Headers; status: number }> {
    const guardName = opts.guard ? opts.guard.name || "response" : opts.path;
    const url = this.buildUrl(opts.path, opts.query);
    const headers: Record<string, string> = { ...this.defaultHeaders, ...opts.headers };
    let body: BodyInit | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
      body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
    }
    const init: RequestInit = { method: opts.method ?? "GET", headers, body, signal: opts.signal };

    const attempt = async (): Promise<{ data: T; headers: Headers; status: number }> => {
      const res = await this.doFetch(url, init, guardName);
      const mapped = this.statusToError(res, guardName);
      if (mapped) throw mapped;
      let data: T;
      try {
        if (opts.response === "text") data = (await res.text()) as T;
        else if (opts.response === "bytes") data = (await res.arrayBuffer()) as T;
        else data = (await res.json()) as T;
      } catch (err) {
        throw new NetworkError(`Failed to decode ${this.source} response body (${guardName}): ${err instanceof Error ? err.message : String(err)}`, {
          source: this.source,
          cause: err,
        });
      }
      if (opts.guard) {
        try {
          data = opts.guard(data);
        } catch (err) {
          // Re-throw taxonomy errors untouched; wrap anything else as drift.
          if (err instanceof UnifiedDataError) throw err;
          throw new UpstreamSchemaDrift(
            `Upstream response failed shape guard "${guardName}" on ${this.source}: ${err instanceof Error ? err.message : String(err)}`,
            guardName,
            { source: this.source, cause: err },
          );
        }
      }
      return { data, headers: res.headers, status: res.status };
    };

    if (opts.noRetry) return attempt();
    return withRetry(attempt, this.retryOpts);
  }

  /** GET with If-None-Match / If-Modified-Since; 304 → { notModified: true }. */
  async conditionalGet<T>(
    opts: RequestOptions<T> & { validators?: ConditionalValidators },
  ): Promise<{ notModified: true; headers: Headers } | { notModified: false; data: T; headers: Headers; status: number }> {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.validators?.etag) headers["If-None-Match"] = opts.validators.etag;
    if (opts.validators?.lastModified) headers["If-Modified-Since"] = opts.validators.lastModified;
    const url = this.buildUrl(opts.path, opts.query);
    const merged: RequestInit = {
      method: "GET",
      headers: { ...this.defaultHeaders, ...headers },
      signal: opts.signal,
    };
    const res = await this.doFetch(url, merged, opts.path);
    if (res.status === 304) return { notModified: true, headers: res.headers };
    const mapped = this.statusToError(res, opts.path);
    if (mapped) throw mapped;
    let data: T;
    try {
      if (opts.response === "text") data = (await res.text()) as T;
      else if (opts.response === "bytes") data = (await res.arrayBuffer()) as T;
      else data = (await res.json()) as T;
    } catch (err) {
      throw new NetworkError(`Failed to decode ${this.source} response body: ${err instanceof Error ? err.message : String(err)}`, {
        source: this.source,
        cause: err,
      });
    }
    if (opts.guard) {
      try {
        data = opts.guard(data);
      } catch (err) {
        if (err instanceof UnifiedDataError) throw err;
        throw new UpstreamSchemaDrift(`Upstream response failed shape guard on ${this.source}: ${String(err)}`, opts.path, {
          source: this.source,
          cause: err,
        });
      }
    }
    return { notModified: false, data, headers: res.headers, status: res.status };
  }
}
