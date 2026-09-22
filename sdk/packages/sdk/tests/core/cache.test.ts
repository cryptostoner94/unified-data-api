import { describe, expect, it } from "vitest";
import { MemoryCache } from "../../src/core/cache.js";

describe("MemoryCache TTLs", () => {
  it("returns entries within TTL and expires them after", () => {
    let now = 1_000_000;
    const cache = new MemoryCache({ now: () => now });
    cache.set("k", { v: 1 }, 60_000);
    expect(cache.get("k")?.value).toEqual({ v: 1 });
    now += 59_999;
    expect(cache.get("k")?.value).toEqual({ v: 1 });
    now += 1;
    expect(cache.get("k")).toBeUndefined();
  });

  it("getFresh enforces maxAge independently of TTL (§7.3)", () => {
    let now = 1_000_000;
    const cache = new MemoryCache({ now: () => now });
    cache.set("price", { v: 1 }, 3_600_000); // TTL 1h
    now += 121_000; // 121s old
    expect(cache.get("price")?.value).toEqual({ v: 1 }); // still in cache
    expect(cache.getFresh("price", 120_000)).toBeUndefined(); // but too old for maxAge=120s
    expect(cache.getFresh("price", 900_000)?.value).toEqual({ v: 1 }); // fine for maxAge=900s
    expect(cache.getFresh("price", Infinity)?.value).toEqual({ v: 1 });
  });

  it("evicts oldest-first past maxEntries", () => {
    const cache = new MemoryCache({ maxEntries: 2 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")?.value).toBe(2);
    expect(cache.get("c")?.value).toBe(3);
  });

  it("swr returns cached value immediately and revalidates in background", async () => {
    let now = 1_000_000;
    const cache = new MemoryCache({ now: () => now });
    cache.set("k", "old", 3_600_000);
    now += 200_000;
    let fetched = false;
    const result = await cache.swr("k", 60_000, 3_600_000, async () => {
      fetched = true;
      return "new";
    });
    expect(result.value).toBe("old");
    expect(result.freshness).toBe("CACHED");
    // Background refresh completes…
    await new Promise((r) => setTimeout(r, 20));
    expect(fetched).toBe(true);
    expect(cache.getFresh("k", 60_000)?.value).toBe("new");
  });

  it("swr fetches live on a cold cache", async () => {
    const cache = new MemoryCache();
    const result = await cache.swr("k", 60_000, 60_000, async () => "fresh");
    expect(result.value).toBe("fresh");
    expect(result.freshness).toBe("LIVE");
  });

  it("keeps ETag validators on entries for conditional GET", () => {
    const cache = new MemoryCache();
    const entry = cache.set("feed", [1, 2], 60_000, { etag: '"abc"', lastModified: "Wed, 01 Jan 2026 00:00:00 GMT" });
    expect(entry.etag).toBe('"abc"');
    expect(cache.get("feed")?.etag).toBe('"abc"');
  });

  it("invalidate and clear work", () => {
    const cache = new MemoryCache();
    cache.set("a", 1);
    cache.set("b", 2);
    cache.invalidate("a");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size()).toBe(1);
    cache.clear();
    expect(cache.size()).toBe(0);
  });
});
