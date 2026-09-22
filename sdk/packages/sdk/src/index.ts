/**
 * @unified-data/sdk — client-side TypeScript SDK for the Unified Public-Data API.
 *
 * Bundles PUBLIC endpoints into normalized per-category bundles. Data calls go
 * DIRECT from the end user's machine to the public endpoints — no server proxy.
 * We sell curation, normalization, types, and docs; metering is per-use via
 * license-key validation + a usage heartbeat (counts only — never user data).
 *
 * Phase 1 scope: crypto bundles (mev, resolver, cex, dex, wallet) + enterprise
 * (filings, macro, patents, registries). Travel/weather/maps/news/sports are
 * roadmap (see README).
 */
import { MemoryCache } from "./core/cache.js";
import { LicenseClient, DEFAULT_LICENSE_BASE_URL } from "./core/license.js";
import type { FetchFn } from "./core/transport.js";
import { SDK_VERSION } from "./version.js";
import { MevBundle, type MevBundleOptions } from "./bundles/crypto/mev.js";
import { ResolverBundle, type ResolverBundleOptions } from "./bundles/crypto/resolver.js";
import { CexBundle } from "./bundles/crypto/cex.js";
import { DexBundle, type DexBundleOptions } from "./bundles/crypto/dex.js";
import { WalletBundle } from "./bundles/crypto/wallet.js";
import { FilingsBundle } from "./bundles/enterprise/filings.js";
import { MacroBundle, type MacroBundleOptions } from "./bundles/enterprise/macro.js";
import { PatentsBundle, type PatentsBundleOptions } from "./bundles/enterprise/patents.js";
import { RegistriesBundle, type RegistriesBundleOptions } from "./bundles/enterprise/registries.js";

export interface SdkCreateOptions {
  /** License key issued for your plan. Validated once via POST /v1/license/verify. */
  licenseKey: string;
  /** Override the licensing-server base URL (default is a documented placeholder). */
  licenseBaseUrl?: string;
  /** Injectable fetch (for tests, custom agents, or non-standard runtimes). */
  fetch?: FetchFn;
  /** Contact email embedded in the User-Agent sent to upstreams (SEC requires one). */
  contactEmail?: string;

  // Per-bundle options (GATED keys are ALWAYS the end user's own — never ours).
  mev?: Omit<MevBundleOptions, "fetch" | "license" | "cache" | "contactEmail">;
  resolver?: Omit<ResolverBundleOptions, "fetch" | "license" | "cache" | "contactEmail">;
  dex?: Omit<DexBundleOptions, "fetch" | "license" | "cache" | "contactEmail">;
  macro?: Omit<MacroBundleOptions, "fetch" | "license" | "cache" | "contactEmail">;
  patents?: Omit<PatentsBundleOptions, "fetch" | "license" | "cache" | "contactEmail">;
  registries?: Omit<RegistriesBundleOptions, "fetch" | "license" | "cache" | "contactEmail">;

  // License-client tuning (mainly for tests).
  heartbeatIntervalMs?: number;
  heartbeatCallThreshold?: number;
}

export class UnifiedDataSDK {
  readonly license: LicenseClient;
  readonly crypto: {
    mev: MevBundle;
    resolver: ResolverBundle;
    cex: CexBundle;
    dex: DexBundle;
    wallet: WalletBundle;
  };
  readonly enterprise: {
    filings: FilingsBundle;
    macro: MacroBundle;
    patents: PatentsBundle;
    registries: RegistriesBundle;
  };

  private constructor(opts: SdkCreateOptions, license: LicenseClient, cache: MemoryCache) {
    this.license = license;
    const shared = { fetch: opts.fetch, license, cache, contactEmail: opts.contactEmail };
    this.crypto = {
      mev: new MevBundle({ ...shared, ...opts.mev }),
      resolver: new ResolverBundle({ ...shared, ...opts.resolver }),
      cex: new CexBundle(shared),
      dex: new DexBundle({ ...shared, ...opts.dex }),
      wallet: new WalletBundle(shared),
    };
    this.enterprise = {
      filings: new FilingsBundle(shared),
      macro: new MacroBundle({ ...shared, ...opts.macro }),
      patents: new PatentsBundle({ ...shared, ...opts.patents }),
      registries: new RegistriesBundle({ ...shared, ...opts.registries }),
    };
  }

  /**
   * Create + initialize the SDK. Validates the license key
   * (POST /v1/license/verify; result cached 24h; 7-day offline grace),
   * then starts the usage heartbeat. Throws LicenseInvalid on failure.
   */
  static async create(opts: SdkCreateOptions): Promise<UnifiedDataSDK> {
    const license = new LicenseClient({
      licenseKey: opts.licenseKey,
      baseUrl: opts.licenseBaseUrl,
      fetch: opts.fetch,
      heartbeatIntervalMs: opts.heartbeatIntervalMs,
      heartbeatCallThreshold: opts.heartbeatCallThreshold,
    });
    await license.verify();
    license.start();
    return new UnifiedDataSDK(opts, license, new MemoryCache());
  }

  /** Stop the heartbeat timer and flush a final beat (best-effort). */
  async shutdown(): Promise<void> {
    await this.license.stop();
  }
}

// ---------------------------------------------------------------------------
// Re-exports: types, core, adapters, bundles
// ---------------------------------------------------------------------------

export { SDK_VERSION, DEFAULT_LICENSE_BASE_URL };
export * from "./types/index.js";
export * from "./core/index.js";
export * from "./adapters/index.js";
export * from "./bundles/crypto/index.js";
export * from "./bundles/enterprise/index.js";
export { BundleBase } from "./bundles/base.js";
export type { BundleSharedOptions } from "./bundles/base.js";
