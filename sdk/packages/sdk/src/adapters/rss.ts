/**
 * RSS/Atom adapter (§2.7): fetches RSS/Atom feeds (news, deals, status pages)
 * and normalizes every feed item → NewsItem via PollingAdapter.
 *
 * Dependency-free minimal XML parsing: handles RSS 2.0 `<item>` and Atom
 * `<entry>` with title/link/guid/pubDate/updated. CDATA and the common
 * entities are decoded. This is a feed-item extractor, not a validating
 * parser — exotic feeds should go through a full XML library.
 */
import { Transport } from "../core/transport.js";
import { PollingAdapter, RestAdapter } from "./rest.js";
import type { NewsItem } from "../types/index.js";

export interface RssAdapterOptions {
  transport: Transport;
  /** Poll cadence ms (news: 5–15 min; status pages: 1–5 min). */
  intervalMs?: number;
  source: string;
}

export interface RawFeedItem {
  id?: string;
  title?: string;
  link?: string;
  publishedAt?: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .trim();
}

function extractTag(block: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(block);
  return m ? decodeEntities(m[1]) : undefined;
}

function extractAtomLink(block: string): string | undefined {
  // Prefer <link rel="alternate" href="...">, else any <link href="...">.
  const links = [...block.matchAll(/<link\b([^>]*)\/?>/gi)];
  for (const l of links) {
    const attrs = l[1];
    if (/rel=["']alternate["']/i.test(attrs) || !/rel=/i.test(attrs)) {
      const href = /href=["']([^"']+)["']/i.exec(attrs);
      if (href) return decodeEntities(href[1]);
    }
  }
  return undefined;
}

/** Parse RSS 2.0 / Atom XML → raw items. Exported for tests. */
export function parseFeedXml(xml: string): RawFeedItem[] {
  const items: RawFeedItem[] = [];
  const itemBlocks = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)];
  for (const b of itemBlocks) {
    const block = b[1];
    items.push({
      id: extractTag(block, "guid") ?? extractTag(block, "link"),
      title: extractTag(block, "title"),
      link: extractTag(block, "link"),
      publishedAt: extractTag(block, "pubDate") ?? extractTag(block, "dc:date"),
    });
  }
  const entryBlocks = [...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)];
  for (const b of entryBlocks) {
    const block = b[1];
    items.push({
      id: extractTag(block, "id"),
      title: extractTag(block, "title"),
      link: extractAtomLink(block),
      publishedAt: extractTag(block, "published") ?? extractTag(block, "updated"),
    });
  }
  return items;
}

/** Normalize raw feed items → NewsItem (drops items without id/title). */
export function normalizeFeedItems(raw: RawFeedItem[], source: string, fetchedAt: string): NewsItem[] {
  const out: NewsItem[] = [];
  for (const r of raw) {
    if (!r.title) continue;
    const id = r.id ?? r.link ?? r.title;
    let publishedAt = fetchedAt;
    if (r.publishedAt) {
      const t = Date.parse(r.publishedAt);
      if (Number.isFinite(t)) publishedAt = new Date(t).toISOString();
    }
    out.push({ id, title: r.title, url: r.link ?? "", publishedAt, source, fetchedAt, freshness: "LIVE" });
  }
  return out;
}

export class RssAdapter {
  private readonly transport: Transport;
  readonly source: string;
  private readonly intervalMs: number;

  constructor(opts: RssAdapterOptions) {
    this.transport = opts.transport;
    this.source = opts.source;
    this.intervalMs = opts.intervalMs ?? 10 * 60 * 1000;
  }

  /** One-shot fetch → normalized NewsItem list (freshness LIVE). */
  async fetchItems(path: string): Promise<NewsItem[]> {
    const { data } = await this.transport.request<string>({ path, response: "text" });
    return normalizeFeedItems(parseFeedXml(data), this.source, new Date().toISOString());
  }

  /**
   * Continuous polling variant with the uniform adapter surface
   * (connect/disconnect/on/snapshot/health), ETag-aware via conditional GET.
   */
  poller(path: string, intervalMs?: number): PollingAdapter<NewsItem> {
    const rest = new RestAdapter({ transport: this.transport });
    const source = this.source;
    return new PollingAdapter<NewsItem>({
      adapter: rest,
      path,
      intervalMs: intervalMs ?? this.intervalMs,
      source,
      response: "text",
      guard: (raw) => {
        if (typeof raw !== "string") throw new Error("expected feed XML text");
        return normalizeFeedItems(parseFeedXml(raw), source, new Date().toISOString());
      },
      idOf: (item) => item.id,
    });
  }
}
