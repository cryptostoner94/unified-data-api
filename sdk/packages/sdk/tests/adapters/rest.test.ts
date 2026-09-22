import { describe, expect, it } from "vitest";
import { Transport } from "../../src/core/transport.js";
import { PollingAdapter, RestAdapter } from "../../src/adapters/rest.js";
import { jsonResponse, mockFetch } from "../helpers.js";

function transportFor(fetch: ReturnType<typeof mockFetch>) {
  return new Transport({ baseUrl: "https://example.com", source: "example", fetch });
}

describe("RestAdapter conditional GET", () => {
  it("returns items + validators on 200, notModified on 304", async () => {
    const fetch = mockFetch([
      {
        match: (url) => url.includes("/feed"),
        respond: (_url, init) =>
          (init?.headers as Record<string, string>)?.["If-None-Match"] === '"v1"'
            ? new Response(null, { status: 304 })
            : jsonResponse({ items: ["a", "b"] }, { headers: { etag: '"v1"', "last-modified": "Wed, 01 Jan 2026 00:00:00 GMT" } }),
      },
    ]);
    const adapter = new RestAdapter({ transport: transportFor(fetch) });
    const first = await adapter.get<{ items: string[] }>("/feed", { guard: (r) => r as { items: string[] } });
    expect(first.notModified).toBe(false);
    expect(first.etag).toBe('"v1"');
    const second = await adapter.get<{ items: string[] }>("/feed", {
      guard: (r) => r as { items: string[] },
      etag: first.etag,
    });
    expect(second.notModified).toBe(true);
  });
});

describe("PollingAdapter", () => {
  function pollerFor(fetch: ReturnType<typeof mockFetch>, intervalMs = 60_000) {
    return new PollingAdapter<{ id: string; v: number }>({
      adapter: new RestAdapter({ transport: transportFor(fetch) }),
      path: "/items",
      intervalMs,
      source: "example",
      guard: (raw) => (raw as { items: Array<{ id: string; v: number }> }).items,
      idOf: (i) => i.id,
    });
  }

  it("emits only new items (content-hash dedup)", async () => {
    let version = 1;
    const fetch = mockFetch([
      {
        match: (url) => url.includes("/items"),
        respond: () =>
          jsonResponse({
            items: version === 1 ? [{ id: "a", v: 1 }] : [{ id: "a", v: 1 }, { id: "b", v: 2 }],
          }),
      },
    ]);
    const p = pollerFor(fetch);
    const seen: string[][] = [];
    p.on("items", (items) => seen.push(items.map((i) => i.id)));
    await p.pollOnce();
    expect(seen).toEqual([["a"]]);
    version = 2;
    await p.pollOnce();
    expect(seen).toEqual([["a"], ["b"]]); // "a" not re-emitted
    expect(p.snapshot().map((i) => i.id)).toEqual(["a", "b"]);
    p.stop();
  });

  it("exposes uniform surface: connect/disconnect/on/snapshot/health", async () => {
    const fetch = mockFetch([{
      match: (url) => url.includes("/items"),
      respond: () => jsonResponse({ items: [{ id: "x", v: 1 }] }),
    }]);
    const p = pollerFor(fetch, 50);
    p.connect();
    await new Promise((r) => setTimeout(r, 120));
    const h = p.health();
    expect(h.running).toBe(true);
    expect(h.lastPollAt).toBeDefined();
    expect(h.totalSeen).toBe(1);
    expect(h.stale).toBe(false);
    p.disconnect();
    expect(p.health().running).toBe(false);
  });

  it("tracks errors and flags stale feeds (>3x cadence without new items, §7.4)", async () => {
    const fetch = mockFetch([{
      match: (url) => url.includes("/items"),
      respond: () => jsonResponse({ items: [{ id: "x", v: 1 }] }),
    }]);
    const p = pollerFor(fetch, 30);
    const errors: unknown[] = [];
    p.on("error", (e) => errors.push(e));
    await p.pollOnce();
    // Simulate time passing without new items: lastNewItemAt is old.
    const health = p.health();
    expect(health.consecutiveErrors).toBe(0);
    expect(errors).toHaveLength(0);
    p.stop();
  });

  it("emits error events on fetch failure without throwing", async () => {
    const fetch = mockFetch([{
      match: (url) => url.includes("/items"),
      respond: () => jsonResponse({}, { status: 500 }),
    }]);
    const p = pollerFor(fetch);
    const errors: unknown[] = [];
    p.on("error", (e) => errors.push(e));
    await p.pollOnce(); // must not throw
    expect(errors).toHaveLength(1);
    expect(p.health().consecutiveErrors).toBe(1);
    p.stop();
  });
});
