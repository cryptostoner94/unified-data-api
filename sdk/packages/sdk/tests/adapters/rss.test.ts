import { describe, expect, it } from "vitest";
import { RssAdapter, normalizeFeedItems, parseFeedXml } from "../../src/adapters/rss.js";
import { Transport } from "../../src/core/transport.js";
import { mockFetch, textResponse } from "../helpers.js";
const RSS_SAMPLE = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Example</title>
<item><title>First post</title><link>https://example.com/1</link><guid>1</guid>
<pubDate>Mon, 21 Sep 2026 10:00:00 GMT</pubDate></item>
<item><title><![CDATA[Second & post]]></title><link>https://example.com/2</link><guid>2</guid>
<pubDate>Mon, 21 Sep 2026 11:00:00 GMT</pubDate></item>
</channel></rss>`;

const ATOM_SAMPLE = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Example</title>
<entry><title>Atom entry</title><id>urn:1</id><updated>2026-09-21T12:00:00Z</updated>
<link rel="alternate" href="https://example.com/a1"/></entry>
</feed>`;

describe("parseFeedXml", () => {
  it("parses RSS 2.0 items with CDATA + entities", () => {
    const items = parseFeedXml(RSS_SAMPLE);
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe("First post");
    expect(items[0].link).toBe("https://example.com/1");
    expect(items[1].title).toBe("Second & post");
  });

  it("parses Atom entries with href links", () => {
    const items = parseFeedXml(ATOM_SAMPLE);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Atom entry");
    expect(items[0].link).toBe("https://example.com/a1");
    expect(items[0].id).toBe("urn:1");
  });
});

describe("normalizeFeedItems", () => {
  it("normalizes to NewsItem with provenance", () => {
    const items = normalizeFeedItems(parseFeedXml(RSS_SAMPLE), "example", "2026-09-22T00:00:00.000Z");
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      id: "1",
      title: "First post",
      url: "https://example.com/1",
      source: "example",
      freshness: "LIVE",
    });
    expect(items[0].publishedAt).toBe(new Date("Mon, 21 Sep 2026 10:00:00 GMT").toISOString());
  });

  it("drops items without titles", () => {
    expect(normalizeFeedItems([{ id: "x" }], "s", "2026-09-22T00:00:00.000Z")).toHaveLength(0);
  });
});

describe("RssAdapter", () => {
  it("fetchItems returns normalized NewsItems", async () => {
    const fetch = mockFetch([{ match: (u) => u.includes("/rss"), respond: () => textResponse(RSS_SAMPLE) }]);
    const adapter = new RssAdapter({
      transport: new Transport({ baseUrl: "https://example.com", source: "example", fetch }),
      source: "example",
    });
    const items = await adapter.fetchItems("/rss");
    expect(items).toHaveLength(2);
    expect(items[0].freshness).toBe("LIVE");
    // Sent as text — the XML must not go through JSON parsing.
    expect(fetch.captured[0].url).toContain("/rss");
  });

  it("poller dedupes by id and is ETag-aware", async () => {
    const fetch = mockFetch([
      {
        match: (u) => u.includes("/rss"),
        respond: (_u, init) =>
          (init?.headers as Record<string, string>)?.["If-None-Match"] === '"rss1"'
            ? new Response(null, { status: 304 })
            : textResponse(RSS_SAMPLE, { headers: { etag: '"rss1"' } }),
      },
    ]);
    const adapter = new RssAdapter({
      transport: new Transport({ baseUrl: "https://example.com", source: "example", fetch }),
      source: "example",
    });
    const poller = adapter.poller("/rss", 60_000);
    const batches: string[][] = [];
    poller.on("items", (items) => batches.push(items.map((i) => i.id)));
    await poller.pollOnce();
    await poller.pollOnce(); // 304 → nothing new
    expect(batches).toEqual([["1", "2"]]);
    expect(poller.snapshot()).toHaveLength(2);
    poller.stop();
  });
});
