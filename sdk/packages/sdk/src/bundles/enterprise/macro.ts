/**
 * Enterprise macro bundle (`enterprise.macro`) — labor stats, demographics,
 * macro series.
 *
 * Sources:
 *   - BLS Public Data API   https://api.bls.gov/publicAPI/v2
 *     KEYLESS v1 (25 queries/day/IP) / FREE-KEY v2 (500/day; end user's own key)
 *   - US Census API         https://api.census.gov/data/{year}/{dataset}  KEYLESS
 *   - FRED                  https://api.stlouisfed.org/fred/               FREE-KEY
 *     (end user's own key — the macro anchor, cross-listed from §2.5)
 *
 * Macro series are cached until the next scheduled release (spec §2.2):
 * default maxAge 86400s (1d), labeled CACHED with the release/observation date.
 */
import { BundleBase, type BundleSharedOptions } from "../base.js";
import { UpstreamAuthRequired } from "../../core/errors.js";
import { expectArray, expectRecord, guardShape, num, optString } from "../../core/schema.js";
import type { MacroSeries, ReadOptions, TabularData } from "../../types/index.js";

export const MACRO_BUNDLE_ID = "enterprise.macro";

export interface MacroBundleOptions extends BundleSharedOptions {
  /** End user's own BLS registration key (lifts v1 quotas; FREE-KEY). */
  blsApiKey?: string;
  /** End user's own FRED API key (FREE-KEY). */
  fredApiKey?: string;
  /** End user's own Census key (lifts the 500/day/IP cap; optional). */
  censusApiKey?: string;
}

type BareSeries = Omit<MacroSeries, "source" | "fetchedAt" | "freshness">;

function guardBlsSeries(raw: unknown): BareSeries[] {
  return guardShape("bls-timeseries", raw, (v) => {
    const o = expectRecord(v);
    const results = expectRecord(o["Results"] ?? {});
    return expectArray(results["series"] ?? []).map((s) => {
      const series = expectRecord(s);
      const observations = expectArray(series["data"] ?? []).map((d) => {
        const r = expectRecord(d);
        const year = String(r["year"] ?? "");
        const period = String(r["period"] ?? ""); // "M01".."M12", "Q01".., "A01"
        const date = period.startsWith("M")
          ? `${year}-${period.slice(1)}-01`
          : period.startsWith("Q")
            ? `${year}-Q${period.slice(1)}`
            : year;
        const rawVal = String(r["value"] ?? "").replace(/,/g, "");
        return { date, value: rawVal === "" || rawVal === "-" ? null : num(rawVal) };
      });
      return {
        seriesId: String(series["seriesID"] ?? ""),
        name: String(series["seriesID"] ?? ""),
        unit: "",
        observations,
      };
    });
  }, "bls");
}

function guardFredObservations(raw: unknown, seriesId: string): BareSeries {
  return guardShape("fred-observations", raw, (v) => {
    const o = expectRecord(v);
    const observations = expectArray(o["observations"] ?? []).map((d) => {
      const r = expectRecord(d);
      const rawVal = String(r["value"] ?? "");
      return { date: String(r["date"] ?? ""), value: rawVal === "." || rawVal === "" ? null : num(rawVal) };
    });
    return { seriesId, name: seriesId, unit: "", observations };
  }, "fred");
}

export class MacroBundle extends BundleBase {
  private readonly blsApiKey?: string;
  private readonly fredApiKey?: string;
  private readonly censusApiKey?: string;

  constructor(opts: MacroBundleOptions = {}) {
    super(opts);
    this.blsApiKey = opts.blsApiKey;
    this.fredApiKey = opts.fredApiKey;
    this.censusApiKey = opts.censusApiKey;
  }

  /**
   * BLS time series (KEYLESS v1; pass blsApiKey for v2 quotas).
   * Example series: "CUUR0000SA0" (CPI-U), "LNS14000000" (unemployment rate).
   */
  async blsSeries(
    args: { seriesIds: string[]; startYear: string; endYear: string },
    options?: ReadOptions,
  ): Promise<MacroSeries[]> {
    return this.readMany({
      bundleId: MACRO_BUNDLE_ID,
      source: "bls",
      cacheKey: this.key(MACRO_BUNDLE_ID, "bls", args.seriesIds.join(","), args.startYear, args.endYear),
      defaultMaxAgeSec: 86_400,
      ttlSec: 7 * 86400,
      options,
      fetch: async () => {
        const t = this.transport("https://api.bls.gov/publicAPI/v2", "bls");
        const body: Record<string, unknown> = {
          seriesid: args.seriesIds,
          startyear: args.startYear,
          endyear: args.endYear,
        };
        if (this.blsApiKey) body["registrationkey"] = this.blsApiKey;
        const { data } = await t.request({
          method: "POST",
          path: "/timeseries/data/",
          body,
          guard: guardBlsSeries,
        });
        return data;
      },
    });
  }

  /**
   * US Census API query (KEYLESS; censusApiKey lifts the per-IP cap).
   * Example: { year: "2023", dataset: "acs/acs5", get: ["NAME","B19013_001E"], forClause: "state:*" }
   */
  async censusQuery(
    args: { year: string; dataset: string; get: string[]; forClause: string; inClause?: string },
    options?: ReadOptions,
  ): Promise<TabularData> {
    return this.readOne({
      bundleId: MACRO_BUNDLE_ID,
      source: "census",
      cacheKey: this.key(MACRO_BUNDLE_ID, "census", args.year, args.dataset, args.get.join(","), args.forClause, args.inClause ?? ""),
      defaultMaxAgeSec: 86_400,
      ttlSec: 7 * 86400,
      options,
      fetch: async () => {
        const t = this.transport("https://api.census.gov", "census");
        const query: Record<string, string | undefined> = {
          get: args.get.join(","),
          for: args.forClause,
          in: args.inClause,
          key: this.censusApiKey,
        };
        const { data } = await t.request({
          path: `/data/${args.year}/${args.dataset}`,
          query,
          guard: (raw) =>
            guardShape("census", raw, (v) => {
              const rows = expectArray(v);
              if (rows.length === 0) return { columns: [] as string[], rows: [] as string[][] };
              const columns = expectArray(rows[0]).map(String);
              return { columns, rows: rows.slice(1).map((r) => expectArray(r).map(String)) };
            }, "census"),
        });
        return data;
      },
    });
  }

  /**
   * FRED series observations (FREE-KEY — end user's own key required).
   * Example series: "GDP", "CPIAUCSL", "UNRATE", "FEDFUNDS".
   */
  async fredObservations(
    args: { seriesId: string; limit?: number; sortOrder?: "asc" | "desc" },
    options?: ReadOptions,
  ): Promise<MacroSeries> {
    if (!this.fredApiKey) throw new UpstreamAuthRequired("fred", undefined, { source: "fred" });
    const key = this.fredApiKey;
    return this.readOne({
      bundleId: MACRO_BUNDLE_ID,
      source: "fred",
      cacheKey: this.key(MACRO_BUNDLE_ID, "fred", args.seriesId, args.limit ?? 100, args.sortOrder ?? "desc"),
      defaultMaxAgeSec: 86_400,
      ttlSec: 7 * 86400,
      options,
      fetch: async () => {
        const t = this.transport("https://api.stlouisfed.org/fred", "fred");
        const { data } = await t.request({
          path: "/series/observations",
          query: {
            series_id: args.seriesId,
            api_key: key,
            file_type: "json",
            limit: args.limit ?? 100,
            sort_order: args.sortOrder ?? "desc",
          },
          guard: (raw) => guardFredObservations(raw, args.seriesId),
        });
        return data;
      },
    });
  }

  /** FRED series metadata (same key requirement as observations). */
  async fredSeriesInfo(args: { seriesId: string }, options?: ReadOptions): Promise<MacroSeries> {
    if (!this.fredApiKey) throw new UpstreamAuthRequired("fred", undefined, { source: "fred" });
    const key = this.fredApiKey;
    return this.readOne({
      bundleId: MACRO_BUNDLE_ID,
      source: "fred",
      cacheKey: this.key(MACRO_BUNDLE_ID, "fred-info", args.seriesId),
      defaultMaxAgeSec: 86_400,
      ttlSec: 7 * 86400,
      options,
      fetch: async () => {
        const t = this.transport("https://api.stlouisfed.org/fred", "fred");
        const { data } = await t.request({
          path: "/series",
          query: { series_id: args.seriesId, api_key: key, file_type: "json" },
          guard: (raw) =>
            guardShape("fred-series", raw, (v) => {
              const o = expectRecord(v);
              const s = expectRecord(expectArray(o["seriess"] ?? [])[0] ?? {});
              return {
                seriesId: String(s["id"] ?? args.seriesId),
                name: String(s["title"] ?? args.seriesId),
                unit: optString(s, "units") ?? "",
                observations: [],
              } as BareSeries;
            }, "fred"),
        });
        return data;
      },
    });
  }
}
