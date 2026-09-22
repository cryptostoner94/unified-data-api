import { describe, expect, it } from "vitest";
import { BundleBase, type BundleSharedOptions } from "../../src/bundles/base.js";
import { MemoryCache } from "../../src/core/cache.js";
import { NetworkError, StaleData, UpstreamAuthRequired } from "../../src/core/errors.js";
import type { ReadOptions } from "../../src/types/index.js";

/** Minimal bundle exposing readOne/readMany with a controllable fetcher. */
class ProbeBundle extends BundleBase {
  failNext = false;
  fetchCount = 0;

  constructor(opts: BundleSharedOptions = {}) {
    super(opts);
  }

  async probe(options?: ReadOptions & { maxAgeSec?: number; ttlSec?: number }) {
    return this.readOne({
      bundleId: "test.probe",
      source: "probe",
      cacheKey: "test.probe:value",
      defaultMaxAgeSec: options?.maxAgeSec ?? 120,
      ttlSec: options?.ttlSec ?? 600,
      options,
      fetch: async () => {
        this.fetchCount++;
        if (this.failNext) throw new NetworkError("upstream down", { source: "probe" });
        return { v: this.fetchCount };
      },
    });
  }

  async probeAuthFail() {
    return this.readOne({
      bundleId: "test.probe",
      source: "probe",
      cacheKey: "test.probe:auth",
      defaultMaxAgeSec: 120,
      ttlSec: 600,
      fetch: async () => {
        throw new UpstreamAuthRequired("probe-gated");
      },
    });
  }
}

describe("maxAge + StaleData (§7.3)", () => {
  it("first read is LIVE with provenance (source/fetchedAt/freshness)", async () => {
    const b = new ProbeBundle();
    const r = await b.probe();
    expect(r.freshness).toBe("LIVE");
    expect(r.source).toBe("probe");
    expect(r.v).toBe(1);
    expect(Date.parse(r.fetchedAt)).not.toBeNaN();
  });

  it("second read within maxAge is CACHED without a new fetch", async () => {
    const b = new ProbeBundle();
    await b.probe();
    const r = await b.probe();
    expect(r.freshness).toBe("CACHED");
    expect(b.fetchCount).toBe(1);
    expect(r.v).toBe(1); // same cached value
  });

  it("maxAge: 0 forces a fresh fetch every time", async () => {
    const b = new ProbeBundle();
    await b.probe({ maxAge: 0 });
    const r = await b.probe({ maxAge: 0 });
    expect(r.freshness).toBe("LIVE");
    expect(b.fetchCount).toBe(2);
  });

  it("throws StaleData (with lastFetchedAt/oldestAcceptable) when the fetch fails and cache is too old", async () => {
    let now = 1_000_000;
    const cache = new MemoryCache({ now: () => now });
    const b = new ProbeBundle({ cache });
    await b.probe({ maxAgeSec: 120 }); // cached at t=1_000_000
    now += 200_000; // 200s later — older than maxAge=120s
    b.failNext = true;
    const err = await b.probe({ maxAgeSec: 120 }).catch((e) => e);
    expect(err).toBeInstanceOf(StaleData);
    const stale = err as StaleData;
    expect(stale.lastFetchedAt).toBe(new Date(1_000_000).toISOString());
    expect(stale.oldestAcceptable).toBe(new Date(1_200_000 - 120_000).toISOString());
    expect(stale.code).toBe("StaleData");
  });

  it("propagates the original error when the fetch fails with no cache at all", async () => {
    const b = new ProbeBundle();
    b.failNext = true;
    const err = await b.probe().catch((e) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(err).not.toBeInstanceOf(StaleData);
  });

  it("never converts auth failures into StaleData", async () => {
    const b = new ProbeBundle();
    const err = await b.probeAuthFail().catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamAuthRequired);
  });

  it("larger maxAge is explicit and honored (caller opts into older data)", async () => {
    let now = 1_000_000;
    const cache = new MemoryCache({ now: () => now });
    const b = new ProbeBundle({ cache });
    await b.probe({ maxAgeSec: 120 });
    now += 200_000;
    const r = await b.probe({ maxAge: 900 }); // explicit opt-in
    expect(r.freshness).toBe("CACHED");
    expect(b.fetchCount).toBe(1);
  });

  it("Infinity allows any cached value", async () => {
    let now = 1_000_000;
    const cache = new MemoryCache({ now: () => now });
    const b = new ProbeBundle({ cache });
    await b.probe({ maxAgeSec: 120, ttlSec: 20_000 }); // keep the entry retained past the jump
    now += 10_000_000;
    const r = await b.probe({ maxAge: Infinity });
    expect(r.freshness).toBe("CACHED");
  });
});
