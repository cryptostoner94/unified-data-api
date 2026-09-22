/**
 * Unified error taxonomy (§3.4 of the spec).
 *
 * Every failure the SDK surfaces is one of these classes, so callers can
 * branch on `err.code` (or `instanceof`) instead of parsing messages.
 */

/** All error codes in the taxonomy. */
export type UnifiedDataErrorCode =
  | "UpstreamRateLimited"
  | "UpstreamDeprecated"
  | "UpstreamSchemaDrift"
  | "UpstreamAuthRequired"
  | "NetworkError"
  | "LicenseInvalid"
  | "BundleNotLicensed"
  | "StaleData";

export interface UnifiedDataErrorOptions {
  /** Whether the operation is worth retrying. */
  retryable?: boolean;
  /** Which upstream source was being contacted, if any. */
  source?: string;
  cause?: unknown;
}

export class UnifiedDataError extends Error {
  readonly code: UnifiedDataErrorCode;
  readonly retryable: boolean;
  readonly source?: string;

  constructor(code: UnifiedDataErrorCode, message: string, opts: UnifiedDataErrorOptions = {}) {
    super(message);
    this.name = code;
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.source = opts.source;
    // lib is ES2020 (no ES2022 ErrorOptions overload); assign directly at runtime.
    if (opts.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause;
  }
}

/** Upstream answered 429 (or an equivalent quota signal). Carries `retryAfterMs`. */
export class UpstreamRateLimited extends UnifiedDataError {
  readonly retryAfterMs?: number;
  constructor(message: string, retryAfterMs?: number, opts: UnifiedDataErrorOptions = {}) {
    super("UpstreamRateLimited", message, { ...opts, retryable: true });
    this.retryAfterMs = retryAfterMs;
  }
}

/** Docs-watcher (or the upstream itself) flagged this endpoint as deprecated/removed. */
export class UpstreamDeprecated extends UnifiedDataError {
  constructor(message: string, opts: UnifiedDataErrorOptions = {}) {
    super("UpstreamDeprecated", message, { ...opts, retryable: false });
  }
}

/**
 * The upstream response failed our runtime shape guard — the provider may have
 * changed their schema. Logged + reported; surfaced so apps can degrade.
 */
export class UpstreamSchemaDrift extends UnifiedDataError {
  readonly expectedShape?: string;
  constructor(message: string, expectedShape?: string, opts: UnifiedDataErrorOptions = {}) {
    super("UpstreamSchemaDrift", message, { ...opts, retryable: false });
    this.expectedShape = expectedShape;
  }
}

/** A GATED source was used without the end user's own key. */
export class UpstreamAuthRequired extends UnifiedDataError {
  readonly provider: string;
  constructor(provider: string, message?: string, opts: UnifiedDataErrorOptions = {}) {
    super(
      "UpstreamAuthRequired",
      message ?? `${provider} requires the end user's own API key (GATED source — pass it at bundle init).`,
      { ...opts, retryable: false, source: opts.source ?? provider },
    );
    this.provider = provider;
  }
}

/** DNS/TLS/timeout/abort/5xx — the request never produced a usable response. */
export class NetworkError extends UnifiedDataError {
  constructor(message: string, opts: UnifiedDataErrorOptions = {}) {
    super("NetworkError", message, { ...opts, retryable: true });
  }
}

/** License key missing, invalid, expired, or unverifiable (no offline grace left). */
export class LicenseInvalid extends UnifiedDataError {
  constructor(message: string, opts: UnifiedDataErrorOptions = {}) {
    super("LicenseInvalid", message, { ...opts, retryable: false });
  }
}

/** The license server responded `downgrade: true` (or the plan excludes this bundle). */
export class BundleNotLicensed extends UnifiedDataError {
  readonly bundleId: string;
  constructor(bundleId: string, message?: string, opts: UnifiedDataErrorOptions = {}) {
    super(
      "BundleNotLicensed",
      message ?? `Bundle "${bundleId}" is not covered by the current license/plan.`,
      { ...opts, retryable: false },
    );
    this.bundleId = bundleId;
  }
}

/**
 * Thrown when no result satisfies the requested `maxAge` (§7.3) — instead of
 * silently returning stale data. Carries the last known fetch time so the
 * caller can decide how to degrade.
 */
export class StaleData extends UnifiedDataError {
  /** ISO timestamp of the newest cached value we had, if any. */
  readonly lastFetchedAt?: string;
  /** ISO timestamp: the oldest `fetchedAt` the caller would have accepted. */
  readonly oldestAcceptable?: string;
  constructor(message: string, opts: UnifiedDataErrorOptions & { lastFetchedAt?: string; oldestAcceptable?: string } = {}) {
    super("StaleData", message, { ...opts, retryable: true });
    this.lastFetchedAt = opts.lastFetchedAt;
    this.oldestAcceptable = opts.oldestAcceptable;
  }
}

/** Type guard for the taxonomy. */
export function isUnifiedDataError(err: unknown): err is UnifiedDataError {
  return err instanceof UnifiedDataError;
}
