import { describe, expect, it } from "vitest";
import { LicenseClient, DEFAULT_LICENSE_BASE_URL } from "../../src/core/license.js";
import { SDK_VERSION } from "../../src/version.js";
import { BundleNotLicensed, LicenseInvalid } from "../../src/core/errors.js";
import { jsonResponse, mockFetch, route } from "../helpers.js";

const LICENSE_KEY = "test-license-key-abc-123";

function licenseRoutes(overrides: { verify?: unknown; heartbeat?: unknown } = {}) {
  const heartbeats: unknown[] = [];
  const verifies: unknown[] = [];
  const fetch = mockFetch([
    {
      match: (url, init) => url.includes("/v1/license/verify") && init?.method === "POST",
      respond: (_url, init) => {
        verifies.push(JSON.parse(String(init?.body)));
        return jsonResponse(overrides.verify ?? { valid: true, plan: "pro" });
      },
    },
    {
      match: (url, init) => url.includes("/v1/license/heartbeat") && init?.method === "POST",
      respond: (_url, init) => {
        heartbeats.push(JSON.parse(String(init?.body)));
        return jsonResponse(overrides.heartbeat ?? { ok: true });
      },
    },
  ]);
  return { fetch, heartbeats, verifies };
}

describe("LicenseClient", () => {
  it("POSTs /v1/license/verify on init and caches the result 24h", async () => {
    const { fetch } = licenseRoutes();
    const client = new LicenseClient({ licenseKey: LICENSE_KEY, fetch });
    const first = await client.verify();
    expect(first.valid).toBe(true);
    const second = await client.verify();
    expect(second.valid).toBe(true);
    const verifyCalls = fetch.captured.filter((c) => c.url.includes("/v1/license/verify"));
    expect(verifyCalls).toHaveLength(1); // second verify served from 24h cache
    expect(verifyCalls[0].url).toBe(`${DEFAULT_LICENSE_BASE_URL}/v1/license/verify`);
  });

  it("uses a configurable base URL", async () => {
    const { fetch } = licenseRoutes();
    const client = new LicenseClient({ licenseKey: LICENSE_KEY, baseUrl: "https://license.example.test", fetch });
    await client.verify();
    expect(fetch.captured[0].url).toBe("https://license.example.test/v1/license/verify");
  });

  it("throws LicenseInvalid on explicit server rejection (never masked by cache)", async () => {
    const { fetch } = licenseRoutes({ verify: { valid: false, message: "key revoked" } });
    const client = new LicenseClient({ licenseKey: "bad-key", fetch });
    await expect(client.verify()).rejects.toBeInstanceOf(LicenseInvalid);
  });

  it("offline: honors a cached valid license within the 7-day grace period", async () => {
    let online = true;
    const fetch = mockFetch([
      route("/v1/license/verify", () => {
        if (!online) throw new TypeError("fetch failed");
        return jsonResponse({ valid: true, plan: "pro" });
      }, "POST"),
    ]);
    let now = 1_000_000;
    const client = new LicenseClient({ licenseKey: LICENSE_KEY, fetch, now: () => now });
    await client.verify();
    expect(fetch.callCount()).toBe(1);
    // 25h later the 24h cache expired; network is down → grace applies.
    online = false;
    now += 25 * 3_600_000;
    const result = await client.verify();
    expect(result.valid).toBe(true);
    expect(result.message).toContain("offline-grace");
  });

  it("offline with no cached license → LicenseInvalid", async () => {
    const fetch = mockFetch([
      route("/v1/license/verify", () => {
        throw new TypeError("fetch failed");
      }, "POST"),
    ]);
    const client = new LicenseClient({ licenseKey: LICENSE_KEY, fetch });
    await expect(client.verify()).rejects.toBeInstanceOf(LicenseInvalid);
  });

  it("heartbeat payload contains ONLY counts — never query params or user data", async () => {
    const { fetch, heartbeats } = licenseRoutes();
    const client = new LicenseClient({ licenseKey: LICENSE_KEY, fetch, platform: "test-platform" });
    await client.verify();
    // Simulate bundle calls the SDK would record (symbols/addresses stay out).
    client.recordCall("crypto.cex");
    client.recordCall("crypto.cex");
    client.recordCall("enterprise.filings");
    await client.heartbeat();

    expect(heartbeats).toHaveLength(1);
    const payload = heartbeats[0] as Record<string, unknown>;
    // Exact shape — nothing more, nothing less.
    expect(Object.keys(payload).sort()).toEqual(["bundleIds", "licenseKeyHash", "platform", "sdkVersion"]);
    expect(payload["bundleIds"]).toEqual({ "crypto.cex": 2, "enterprise.filings": 1 });
    expect(payload["sdkVersion"]).toBe(SDK_VERSION);
    expect(payload["platform"]).toBe("test-platform");
    // The raw key is hashed, never transmitted.
    expect(payload["licenseKeyHash"]).toBe(await LicenseClient.sha256Hex(LICENSE_KEY));
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(LICENSE_KEY);
    expect(serialized).not.toContain("BTCUSDT");
    expect(serialized).not.toContain("bc1");
  });

  it("auto-heartbeats every 1000 calls", async () => {
    const { heartbeats } = licenseRoutes();
    const fetch = mockFetch([
      route("/v1/license/verify", () => jsonResponse({ valid: true }), "POST"),
      {
        match: (url, init) => url.includes("/v1/license/heartbeat") && init?.method === "POST",
        respond: (_url, init) => {
          heartbeats.push(JSON.parse(String(init?.body)));
          return jsonResponse({ ok: true });
        },
      },
    ]);
    const client = new LicenseClient({ licenseKey: LICENSE_KEY, fetch, heartbeatCallThreshold: 5 });
    await client.verify();
    for (let i = 0; i < 5; i++) client.recordCall("crypto.cex");
    await new Promise((r) => setTimeout(r, 20)); // fire-and-forget heartbeat
    expect(heartbeats.length).toBeGreaterThanOrEqual(1);
    await client.stop();
  });

  it("downgrade: true disables bundles via BundleNotLicensed", async () => {
    const { fetch } = licenseRoutes({ verify: { valid: true, plan: "pro", downgrade: true } });
    const client = new LicenseClient({ licenseKey: LICENSE_KEY, fetch });
    await client.verify();
    expect(client.isDowngraded).toBe(true);
    expect(() => client.assertBundleAllowed("crypto.cex")).toThrow(BundleNotLicensed);
  });

  it("plan bundle allowlist is enforced", async () => {
    const { fetch } = licenseRoutes({ verify: { valid: true, plan: "starter", bundles: ["crypto.cex"] } });
    const client = new LicenseClient({ licenseKey: LICENSE_KEY, fetch });
    await client.verify();
    expect(() => client.assertBundleAllowed("crypto.cex")).not.toThrow();
    expect(() => client.assertBundleAllowed("enterprise.filings")).toThrow(BundleNotLicensed);
  });

  it("requires a license key at construction", () => {
    expect(() => new LicenseClient({ licenseKey: "" })).toThrow(LicenseInvalid);
  });
});
