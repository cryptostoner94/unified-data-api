import { describe, expect, it } from "vitest";
import {
  BundleNotLicensed,
  isUnifiedDataError,
  LicenseInvalid,
  NetworkError,
  StaleData,
  UnifiedDataError,
  UpstreamAuthRequired,
  UpstreamDeprecated,
  UpstreamRateLimited,
  UpstreamSchemaDrift,
} from "../../src/core/errors.js";

describe("unified error taxonomy (§3.4)", () => {
  it("exposes every taxonomy code on .code and .name", () => {
    const cases: Array<[UnifiedDataError, string]> = [
      [new UpstreamRateLimited("rl", 1500), "UpstreamRateLimited"],
      [new UpstreamDeprecated("dep"), "UpstreamDeprecated"],
      [new UpstreamSchemaDrift("drift", "shape"), "UpstreamSchemaDrift"],
      [new UpstreamAuthRequired("1inch"), "UpstreamAuthRequired"],
      [new NetworkError("net"), "NetworkError"],
      [new LicenseInvalid("lic"), "LicenseInvalid"],
      [new BundleNotLicensed("crypto.cex"), "BundleNotLicensed"],
      [new StaleData("stale"), "StaleData"],
    ];
    for (const [err, code] of cases) {
      expect(err.code).toBe(code);
      expect(err.name).toBe(code);
      expect(err).toBeInstanceOf(UnifiedDataError);
      expect(err).toBeInstanceOf(Error);
      expect(isUnifiedDataError(err)).toBe(true);
    }
    expect(isUnifiedDataError(new Error("plain"))).toBe(false);
    expect(isUnifiedDataError("nope")).toBe(false);
  });

  it("UpstreamRateLimited carries retryAfterMs and is retryable", () => {
    const err = new UpstreamRateLimited("slow down", 2000);
    expect(err.retryAfterMs).toBe(2000);
    expect(err.retryable).toBe(true);
  });

  it("NetworkError is retryable; auth/license/deprecation are not", () => {
    expect(new NetworkError("x").retryable).toBe(true);
    expect(new UpstreamAuthRequired("p").retryable).toBe(false);
    expect(new LicenseInvalid("x").retryable).toBe(false);
    expect(new UpstreamDeprecated("x").retryable).toBe(false);
    expect(new UpstreamSchemaDrift("x").retryable).toBe(false);
    expect(new BundleNotLicensed("b").retryable).toBe(false);
  });

  it("StaleData carries lastFetchedAt and oldestAcceptable", () => {
    const err = new StaleData("too old", {
      lastFetchedAt: "2026-09-20T00:00:00.000Z",
      oldestAcceptable: "2026-09-22T00:00:00.000Z",
      source: "binance",
    });
    expect(err.lastFetchedAt).toBe("2026-09-20T00:00:00.000Z");
    expect(err.oldestAcceptable).toBe("2026-09-22T00:00:00.000Z");
    expect(err.source).toBe("binance");
  });

  it("UpstreamAuthRequired names the GATED provider", () => {
    const err = new UpstreamAuthRequired("etherscan");
    expect(err.provider).toBe("etherscan");
    expect(err.message).toContain("etherscan");
  });
});
