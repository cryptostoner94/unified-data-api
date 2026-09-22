import { describe, expect, it } from "vitest";
import { BinaryAdapter, unconfiguredDecoder, type GtfsRtEntity } from "../../src/adapters/gtfs.js";
import { DatasetAdapter } from "../../src/adapters/dataset.js";
import { Transport } from "../../src/core/transport.js";
import { UpstreamSchemaDrift } from "../../src/core/errors.js";
import { jsonResponse, mockFetch } from "../helpers.js";

const fakeDecode = (bytes: Uint8Array): GtfsRtEntity[] => {
  const text = new TextDecoder().decode(bytes);
  return text
    .split("\n")
    .filter(Boolean)
    .map((line, i) => ({ id: `e${i}`, type: "vehicle" as const, data: { raw: line } }));
};

describe("BinaryAdapter (GTFS-RT working stub)", () => {
  it("polls, decodes, and snapshots entities", async () => {
    const fetch = mockFetch([
      {
        match: (u) => u.includes("/vehiclePositions"),
        respond: () => new Response("v1\nv2", { status: 200, headers: { etag: '"f1"' } }),
      },
    ]);
    const adapter = new BinaryAdapter({ decode: fakeDecode, fetch });
    const res = await adapter.pollOnce("https://example.com/gtfs-rt/vehiclePositions");
    expect(res.notModified).toBe(false);
    expect(res.entityCount).toBe(2);
    expect(adapter.snapshot().map((e) => e.id)).toEqual(["e0", "e1"]);
    const h = adapter.health();
    expect(h.entityCount).toBe(2);
    expect(h.lastEntityAt).toBeDefined();
    expect(h.stale).toBe(false);
    adapter.disconnect();
  });

  it("uses ETag conditional GET (304 → notModified)", async () => {
    const fetch = mockFetch([
      {
        match: (u) => u.includes("/tripUpdates"),
        respond: (_u, init) =>
          (init?.headers as Record<string, string>)?.["If-None-Match"] === '"f1"'
            ? new Response(null, { status: 304 })
            : new Response("t1", { status: 200, headers: { etag: '"f1"' } }),
      },
    ]);
    const adapter = new BinaryAdapter({ decode: fakeDecode, fetch });
    await adapter.pollOnce("https://example.com/gtfs-rt/tripUpdates");
    const second = await adapter.pollOnce("https://example.com/gtfs-rt/tripUpdates");
    expect(second.notModified).toBe(true);
    expect(adapter.snapshot()).toHaveLength(1); // unchanged
    adapter.disconnect();
  });

  it("emits error events and rethrows on decode failure", async () => {
    const fetch = mockFetch([
      { match: (u) => u.includes("/bad"), respond: () => new Response("zzz", { status: 200 }) },
    ]);
    const adapter = new BinaryAdapter({
      decode: () => {
        throw new Error("protobuf boom");
      },
      fetch,
    });
    const errors: unknown[] = [];
    adapter.on("error", (e) => errors.push(e));
    await expect(adapter.pollOnce("https://example.com/gtfs-rt/bad")).rejects.toThrow("protobuf boom");
    expect(errors).toHaveLength(1);
    expect(adapter.health().consecutiveErrors).toBe(1);
    adapter.disconnect();
  });

  it("default decoder explains the wiring (UpstreamSchemaDrift)", () => {
    expect(() => unconfiguredDecoder(new Uint8Array([1, 2, 3]))).toThrow(UpstreamSchemaDrift);
  });
});

describe("DatasetAdapter", () => {
  it("getJson applies the shape guard", async () => {
    const fetch = mockFetch([
      { match: (u) => u.includes("/cves"), respond: () => jsonResponse({ results: [{ id: "CVE-1" }] }) },
    ]);
    const adapter = new DatasetAdapter({
      transport: new Transport({ baseUrl: "https://example.com", source: "nvd", fetch }),
      source: "nvd",
    });
    const data = await adapter.getJson<{ results: Array<{ id: string }> }>("/cves", {
      guard: (raw) => raw as { results: Array<{ id: string }> },
    });
    expect(data.results[0].id).toBe("CVE-1");
  });

  it("fetchAllPages follows cursors until exhausted", async () => {
    const fetch = mockFetch([]);
    const adapter = new DatasetAdapter({
      transport: new Transport({ baseUrl: "https://example.com", source: "x", fetch }),
      source: "x",
    });
    const pages: Record<string, { items: number[]; next?: string }> = {
      start: { items: [1, 2], next: "p2" },
      p2: { items: [3], next: undefined },
    };
    const all = await adapter.fetchAllPages<number>(async (cursor) => {
      const p = pages[cursor ?? "start"];
      return { items: p.items, nextCursor: p.next };
    });
    expect(all).toEqual([1, 2, 3]);
  });

  it("geoJsonFeatures flattens FeatureCollections", () => {
    const items = DatasetAdapter.geoJsonFeatures(
      { type: "FeatureCollection", features: [{ properties: { mag: 5.1 } }, { properties: { mag: 4.2 } }] },
      (f) => (f["properties"] as { mag: number }).mag,
    );
    expect(items).toEqual([5.1, 4.2]);
    expect(() => DatasetAdapter.geoJsonFeatures({ type: "nope" }, (f) => f)).toThrow(UpstreamSchemaDrift);
  });
});
