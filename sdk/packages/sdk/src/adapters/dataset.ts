/**
 * Dataset adapter (§2.7): keyless JSON datasets (USGS, NVD, World Bank, …)
 * with pagination helpers and item-level normalization.
 */
import { Transport } from "../core/transport.js";
import { guardShape } from "../core/schema.js";

export interface DatasetAdapterOptions {
  transport: Transport;
  source: string;
}

export interface PageResult<T> {
  items: T[];
  /** Cursor for the next page; undefined when exhausted. */
  nextCursor?: string;
}

export class DatasetAdapter {
  private readonly transport: Transport;
  readonly source: string;

  constructor(opts: DatasetAdapterOptions) {
    this.transport = opts.transport;
    this.source = opts.source;
  }

  /** Single JSON GET with a shape guard. */
  async getJson<T>(path: string, opts: {
    query?: Record<string, string | number | boolean | undefined | null>;
    headers?: Record<string, string>;
    guard: (raw: unknown) => T;
    signal?: AbortSignal;
  }): Promise<T> {
    const { data } = await this.transport.request<T>({ path, query: opts.query, headers: opts.headers, guard: opts.guard, signal: opts.signal });
    return data;
  }

  /**
   * Follow cursor pagination until `nextCursor` is undefined or `maxPages`
   * is reached. The caller owns the page→{items,nextCursor} mapping.
   */
  async fetchAllPages<T>(
    fetchPage: (cursor: string | undefined, page: number) => Promise<PageResult<T>>,
    maxPages = 10,
  ): Promise<T[]> {
    const all: T[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const { items, nextCursor } = await fetchPage(cursor, page);
      all.push(...items);
      if (nextCursor == null) break;
      cursor = nextCursor;
    }
    return all;
  }

  /**
   * GeoJSON FeatureCollection → flat items. Used by USGS-style feeds.
   * (Provided as a helper; Phase-1 bundles don't ship feed verticals.)
   */
  static geoJsonFeatures<T>(raw: unknown, map: (feature: Record<string, unknown>) => T): T[] {
    return guardShape("geojson", raw, (v) => {
      const obj = v as Record<string, unknown>;
      const features = obj["features"];
      if (!Array.isArray(features)) throw new Error("expected features array");
      return (features as Record<string, unknown>[]).map(map);
    });
  }
}
