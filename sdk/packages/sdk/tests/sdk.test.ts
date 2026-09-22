import { afterEach, describe, expect, it } from "vitest";
import { UnifiedDataSDK } from "../src/index.js";
import { LicenseInvalid } from "../src/core/errors.js";
import { jsonResponse, mockFetch, route } from "./helpers.js";

function sdkFetch() {
  return mockFetch([
    route("/v1/license/verify", () => jsonResponse({ valid: true, plan: "pro" }), "POST"),
    route("/v1/license/heartbeat", () => jsonResponse({ ok: true }), "POST"),
    route("data-api.binance.vision/api/v3/klines", () =>
      jsonResponse([[1_757_000_000_000, "100", "105", "99", "104", "10", 1_757_003_599_999]]),
    ),
    route("data.sec.gov/submissions/CIK0000320193.json", () =>
      jsonResponse({ cik: "0000320193", name: "Apple Inc.", filings: { recent: { form: [], filingDate: [], accessionNumber: [], primaryDocument: [] } } }),
    ),
  ]);
}

describe("UnifiedDataSDK", () => {
  let sdks: UnifiedDataSDK[] = [];
  afterEach(async () => {
    for (const s of sdks) await s.shutdown();
    sdks = [];
  });

  it("create() verifies the license and exposes all Phase-1 bundles", async () => {
    const fetch = sdkFetch();
    const sdk = await UnifiedDataSDK.create({ licenseKey: "key-1", fetch });
    sdks.push(sdk);
    expect(sdk.crypto.mev).toBeDefined();
    expect(sdk.crypto.resolver).toBeDefined();
    expect(sdk.crypto.cex).toBeDefined();
    expect(sdk.crypto.dex).toBeDefined();
    expect(sdk.crypto.wallet).toBeDefined();
    expect(sdk.enterprise.filings).toBeDefined();
    expect(sdk.enterprise.macro).toBeDefined();
    expect(sdk.enterprise.patents).toBeDefined();
    expect(sdk.enterprise.registries).toBeDefined();
    expect(fetch.captured.some((c) => c.url.includes("/v1/license/verify"))).toBe(true);
  });

  it("create() throws LicenseInvalid for a bad key", async () => {
    const fetch = mockFetch([
      route("/v1/license/verify", () => jsonResponse({ valid: false, message: "nope" }), "POST"),
    ]);
    await expect(UnifiedDataSDK.create({ licenseKey: "bad", fetch })).rejects.toBeInstanceOf(LicenseInvalid);
  });

  it("bundle reads record heartbeat counts and shutdown flushes a final beat", async () => {
    const fetch = sdkFetch();
    const sdk = await UnifiedDataSDK.create({ licenseKey: "key-2", fetch, heartbeatIntervalMs: 3_600_000 });
    sdks.push(sdk);
    await sdk.crypto.cex.klines({ venue: "binance", symbol: "BTCUSDT" });
    await sdk.enterprise.filings.submissions({ cik: "320193" });
    expect(sdk.license.pendingCounts()).toEqual({ "crypto.cex": 1, "enterprise.filings": 1 });
    await sdk.shutdown();
    sdks = [];
    const beats = fetch.captured.filter((c) => c.url.includes("/v1/license/heartbeat"));
    expect(beats.length).toBeGreaterThanOrEqual(1);
    const payload = JSON.parse(beats[beats.length - 1].bodyText!);
    expect(payload.bundleIds).toEqual({ "crypto.cex": 1, "enterprise.filings": 1 });
    expect(payload.licenseKeyHash).not.toContain("key-2");
  });

  it("passes GATED keys through to bundles", async () => {
    const fetch = sdkFetch();
    const sdk = await UnifiedDataSDK.create({
      licenseKey: "key-3",
      fetch,
      dex: { coinGeckoApiKey: "cg-key" },
      macro: { fredApiKey: "fred-key" },
    });
    sdks.push(sdk);
    // With the end user's key present, the GATED method proceeds to the fetch
    // (no mock route → 404 → NetworkError, NOT UpstreamAuthRequired) and the
    // user's key is sent as the provider requires.
    const err = await sdk.crypto.dex.simplePrice({ ids: ["bitcoin"] }).catch((e) => e);
    expect(err.code).not.toBe("UpstreamAuthRequired");
    const call = fetch.captured.find((c) => c.url.includes("api.coingecko.com"));
    expect(call?.headers["x-cg-demo-api-key"]).toBe("cg-key");
  });
});
