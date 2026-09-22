/**
 * License validation + usage heartbeat (§3.3).
 *
 * Metering WITHOUT proxying: the heavy data never touches our servers. The
 * only traffic to our infrastructure is:
 *   1. `POST /v1/license/verify` once per SDK init (result cached 24h; the SDK
 *      keeps working offline with a cached valid license for a 7-day grace
 *      period, so airplane-mode apps don't break).
 *   2. A tiny heartbeat every 15 minutes or every 1,000 bundle calls
 *      (whichever first): `{ licenseKeyHash, bundleIds, sdkVersion, platform }`.
 *
 * NEVER sent: query parameters, symbols, addresses, locations, or any other
 * user data — per-bundle call COUNTS only, aggregated. The payload is <1 KB.
 * This is the core trust contract of the product; see README "Heartbeat privacy".
 */
import { BundleNotLicensed, LicenseInvalid } from "./errors.js";
import { SDK_VERSION } from "../version.js";
import type { FetchFn } from "./transport.js";

/**
 * Default licensing-server base URL.
 * PLACEHOLDER — no production licensing server exists yet; override via
 * `licenseBaseUrl` (or `UNIFIED_DATA_LICENSE_URL`) when one is deployed.
 */
export const DEFAULT_LICENSE_BASE_URL = "https://license.unified-data.dev";

export interface LicenseVerifyResult {
  valid: boolean;
  plan?: string;
  /** When present, only these bundle ids are enabled. */
  bundles?: string[];
  /** Server asks the SDK to disable paid bundles until renewal. */
  downgrade?: boolean;
  message?: string;
  expiresAt?: string;
}

export interface HeartbeatPayload {
  /** SHA-256 hex of the license key — the raw key is never transmitted. */
  licenseKeyHash: string;
  /** Per-bundle call counts since the last heartbeat, e.g. { "crypto.cex": 842 }. */
  bundleIds: Record<string, number>;
  sdkVersion: string;
  /** Runtime platform, e.g. "node/linux-x64" or "web". No user data. */
  platform: string;
}

export interface HeartbeatResponse {
  ok?: boolean;
  downgrade?: boolean;
  message?: string;
}

export interface LicenseClientOptions {
  licenseKey: string;
  baseUrl?: string;
  fetch?: FetchFn;
  /** Calls recorded before a heartbeat is forced (default 1000). */
  heartbeatCallThreshold?: number;
  /** Heartbeat interval ms (default 15 min). */
  heartbeatIntervalMs?: number;
  /** How long a verify result is trusted without re-checking (default 24h). */
  verifyCacheTtlMs?: number;
  /** Offline grace for a cached valid license (default 7 days). */
  offlineGraceMs?: number;
  platform?: string;
  now?: () => number;
}

function detectPlatform(): string {
  try {
    const proc = (globalThis as { process?: { platform?: string; arch?: string; versions?: { node?: string } } }).process;
    if (proc?.versions?.node) return `node/${proc.platform ?? "unknown"}-${proc.arch ?? "unknown"}`;
    if (typeof navigator !== "undefined") return "web";
  } catch {
    // fall through
  }
  return "unknown";
}

export class LicenseClient {
  private readonly licenseKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;
  private readonly heartbeatCallThreshold: number;
  private readonly heartbeatIntervalMs: number;
  private readonly verifyCacheTtlMs: number;
  private readonly offlineGraceMs: number;
  private readonly platform: string;
  private readonly now: () => number;

  private cachedVerify?: { result: LicenseVerifyResult; atMs: number };
  private downgraded = false;
  private counts: Record<string, number> = {};
  private callsSinceHeartbeat = 0;
  private timer?: ReturnType<typeof setInterval>;
  private heartbeatInFlight = false;

  constructor(opts: LicenseClientOptions) {
    if (!opts.licenseKey) throw new LicenseInvalid("A license key is required to initialize the SDK.");
    this.licenseKey = opts.licenseKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_LICENSE_BASE_URL).replace(/\/+$/, "");
    const globalFetch = typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined;
    if (!opts.fetch && !globalFetch) throw new LicenseInvalid("License verification requires a fetch implementation.");
    this.fetchFn = opts.fetch ?? (globalFetch as FetchFn);
    this.heartbeatCallThreshold = opts.heartbeatCallThreshold ?? 1000;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 15 * 60 * 1000;
    this.verifyCacheTtlMs = opts.verifyCacheTtlMs ?? 24 * 60 * 60 * 1000;
    this.offlineGraceMs = opts.offlineGraceMs ?? 7 * 24 * 60 * 60 * 1000;
    this.platform = opts.platform ?? detectPlatform();
    this.now = opts.now ?? Date.now;
  }

  /** SHA-256 hex digest (WebCrypto; available in Node 18+ and browsers). */
  static async sha256Hex(input: string): Promise<string> {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) throw new Error("No SubtleCrypto available for license key hashing.");
    const digest = await subtle.digest("SHA-256", new TextEncoder().encode(input));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  /**
   * Validate the license key against the licensing server.
   * Result cached 24h; on network failure a cached valid license is honored
   * for the 7-day offline grace period. Throws LicenseInvalid otherwise.
   */
  async verify(): Promise<LicenseVerifyResult> {
    const now = this.now();
    if (this.cachedVerify && now - this.cachedVerify.atMs < this.verifyCacheTtlMs) {
      this.applyDowngrade(this.cachedVerify.result);
      return this.cachedVerify.result;
    }
    try {
      const res = await this.fetchFn(`${this.baseUrl}/v1/license/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": `unified-data-sdk/${SDK_VERSION}` },
        body: JSON.stringify({ licenseKey: this.licenseKey, sdkVersion: SDK_VERSION, platform: this.platform }),
      });
      if (!res.ok) throw new LicenseInvalid(`License server rejected the request (HTTP ${res.status}).`);
      const result = (await res.json()) as LicenseVerifyResult;
      if (!result || result.valid !== true) {
        throw new LicenseInvalid(result?.message ?? "License key is invalid or expired.");
      }
      this.cachedVerify = { result, atMs: now };
      this.applyDowngrade(result);
      return result;
    } catch (err) {
      // An explicit rejection from the server always throws — a cached
      // license must never override "this key is invalid".
      if (err instanceof LicenseInvalid) throw err;
      // Transport-level failure (offline / server down): honor a cached
      // valid license inside the 7-day offline grace period.
      if (this.cachedVerify?.result.valid && now - this.cachedVerify.atMs < this.offlineGraceMs) {
        return { ...this.cachedVerify.result, message: "offline-grace: using cached license validation" };
      }
      throw new LicenseInvalid(
        `Could not reach the license server and no valid cached license exists: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  private applyDowngrade(result: LicenseVerifyResult): void {
    this.downgraded = result.downgrade === true;
  }

  /** True when the server asked us to disable paid bundles. */
  get isDowngraded(): boolean {
    return this.downgraded;
  }

  get lastVerifyResult(): LicenseVerifyResult | undefined {
    return this.cachedVerify?.result;
  }

  /** Throws BundleNotLicensed when the plan/downgrade excludes this bundle. */
  assertBundleAllowed(bundleId: string): void {
    if (this.downgraded) throw new BundleNotLicensed(bundleId, "License server requested a downgrade — paid bundles are disabled until renewal.");
    const allowed = this.cachedVerify?.result.bundles;
    if (allowed && !allowed.includes(bundleId)) throw new BundleNotLicensed(bundleId);
  }

  /** Record one bundle call for the heartbeat counters. */
  recordCall(bundleId: string): void {
    this.counts[bundleId] = (this.counts[bundleId] ?? 0) + 1;
    this.callsSinceHeartbeat += 1;
    if (this.callsSinceHeartbeat >= this.heartbeatCallThreshold) {
      // Fire-and-forget; failures are retried on the next scheduled beat.
      void this.heartbeat().catch(() => undefined);
    }
  }

  /** Build the heartbeat payload — counts only, never query params or user data. */
  async buildHeartbeatPayload(): Promise<HeartbeatPayload> {
    return {
      licenseKeyHash: await LicenseClient.sha256Hex(this.licenseKey),
      bundleIds: { ...this.counts },
      sdkVersion: SDK_VERSION,
      platform: this.platform,
    };
  }

  /**
   * Send one heartbeat. Counts reset only on a successful send.
   * The payload intentionally contains NO symbols, addresses, locations,
   * query parameters, or any other user data.
   */
  async heartbeat(): Promise<void> {
    if (this.heartbeatInFlight) return;
    this.heartbeatInFlight = true;
    try {
      const payload = await this.buildHeartbeatPayload();
      const res = await this.fetchFn(`${this.baseUrl}/v1/license/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": `unified-data-sdk/${SDK_VERSION}` },
        body: JSON.stringify(payload),
      });
      if (!res.ok) return; // keep counts; retry on the next beat
      const body = (await res.json().catch(() => ({}))) as HeartbeatResponse;
      this.counts = {};
      this.callsSinceHeartbeat = 0;
      this.applyDowngrade({ valid: true, downgrade: body.downgrade });
    } finally {
      this.heartbeatInFlight = false;
    }
  }

  /** Start the periodic heartbeat (called by SDK init). */
  start(): void {
    this.stop();
    const timer = setInterval(() => {
      void this.heartbeat().catch(() => undefined);
    }, this.heartbeatIntervalMs);
    // Don't hold the process open for metering in Node.
    (timer as { unref?: () => void }).unref?.();
    this.timer = timer;
  }

  /** Stop the periodic heartbeat and flush one final beat (best-effort). */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.callsSinceHeartbeat > 0) {
      await this.heartbeat().catch(() => undefined);
    }
  }

  /** For tests: current unsent counters. */
  pendingCounts(): Record<string, number> {
    return { ...this.counts };
  }
}
