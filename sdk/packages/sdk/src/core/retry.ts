/**
 * Retry with exponential backoff + jitter (§3.6).
 *
 * Honors `Retry-After` (via UpstreamRateLimited.retryAfterMs) and retries
 * retryable taxonomy errors (UpstreamRateLimited, NetworkError) by default.
 * Non-retryable errors (auth, license, schema drift, deprecation) fail fast.
 */
import { NetworkError, UnifiedDataError, UpstreamRateLimited } from "./errors.js";

export interface RetryOptions {
  /** Total attempts including the first (default 4). */
  maxAttempts?: number;
  /** Base delay before the first retry in ms (default 500). */
  baseDelayMs?: number;
  /** Cap for any single backoff delay in ms (default 10_000). */
  maxDelayMs?: number;
  /** Add ±25% jitter (default true). Disable in tests for determinism. */
  jitter?: boolean;
  /** Override: decide per error whether to retry. */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  /** Sleep implementation (injectable for tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Called before each retry. */
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

const DEFAULTS = { maxAttempts: 4, baseDelayMs: 500, maxDelayMs: 10_000, jitter: true } as const;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff with optional full jitter. Deterministic when `jitter` is false. */
export function backoffDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number, jitter: boolean): number {
  const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  if (!jitter || exp <= 0) return exp;
  // "Equal jitter": half deterministic, half random.
  const half = exp / 2;
  return half + Math.random() * half;
}

/**
 * Parse a `Retry-After` header value into milliseconds.
 * Accepts delta-seconds ("120") or an HTTP date. Returns undefined when unparseable.
 */
export function parseRetryAfterMs(value: string | null | undefined): number | undefined {
  if (value == null || value === "") return undefined;
  const trimmed = value.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

function defaultShouldRetry(err: unknown): boolean {
  if (err instanceof UpstreamRateLimited) return true;
  if (err instanceof NetworkError) return err.retryable;
  if (err instanceof UnifiedDataError) return false;
  // Unknown errors from the fetch layer (TypeError etc. are mapped to
  // NetworkError by transport, but defense in depth costs nothing).
  return false;
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULTS.maxAttempts);
  const baseDelayMs = opts.baseDelayMs ?? DEFAULTS.baseDelayMs;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULTS.maxDelayMs;
  const jitter = opts.jitter ?? DEFAULTS.jitter;
  const sleep = opts.sleep ?? defaultSleep;
  const shouldRetry = opts.shouldRetry ?? defaultShouldRetry;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts || !shouldRetry(err, attempt)) throw err;
      // Honor the server's asked delay when the error carries one.
      const serverDelay = err instanceof UpstreamRateLimited ? err.retryAfterMs : undefined;
      const delayMs =
        serverDelay != null
          ? Math.min(serverDelay, maxDelayMs)
          : backoffDelayMs(attempt, baseDelayMs, maxDelayMs, jitter);
      opts.onRetry?.(err, attempt, delayMs);
      await sleep(delayMs);
    }
  }
  throw lastError;
}
