/**
 * Enterprise patents bundle (`enterprise.patents`).
 *
 * Sources (both FREE-KEY — end user's own key; USPTO = US public data):
 *   - USPTO Open Data Portal  https://api.uspto.gov   (X-API-KEY header)
 *     Patent application search: POST /api/v1/patent/applications/search
 *     (documented in the ODP OpenAPI at https://data.uspto.gov/swagger/ —
 *     response `patentFileWrapperDataBag[]` of `{ applicationNumberText,
 *     applicationMetaData: { inventionTitle, patentNumber, filingDate,
 *     grantDate, applicationStatusDescriptionText, inventorBag,
 *     cpcClassificationBag, ... }, assignmentBag, ... }`).
 *   - USPTO TSDR              https://tsdrapi.uspto.gov (USPTO-API-KEY header)
 *     Trademark case status: GET /ts/cd/casestatus/sn{serial}/info.json
 *     (the serial number carries the `sn` prefix per the TSDR API docs;
 *     shape guards flag any drift)
 *
 * Freshness (spec §2.2): patent status on-demand; search-result caches 1d.
 */
import { BundleBase, type BundleSharedOptions } from "../base.js";
import { UpstreamAuthRequired } from "../../core/errors.js";
import { expectArray, expectRecord, guardShape, optString } from "../../core/schema.js";
import type { Patent, ReadOptions, Trademark } from "../../types/index.js";

export const PATENTS_BUNDLE_ID = "enterprise.patents";

export interface PatentsBundleOptions extends BundleSharedOptions {
  /** End user's own USPTO ODP API key (FREE-KEY). */
  usptoApiKey?: string;
  /** End user's own USPTO TSDR API key (FREE-KEY). */
  tsdrApiKey?: string;
}

type BarePatent = Omit<Patent, "source" | "fetchedAt" | "freshness">;
type BareTrademark = Omit<Trademark, "source" | "fetchedAt" | "freshness">;

/** Extract display names from a bag whose item shape may vary (inventorBag, assignmentBag). */
function nameList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((e) => {
    if (typeof e === "string") return e;
    if (e && typeof e === "object") {
      const r = e as Record<string, unknown>;
      const name =
        r["inventorNameText"] ?? r["assigneeName"] ?? r["name"] ?? r["inventorName"] ?? r["ownerName"];
      return typeof name === "string" ? name : "";
    }
    return "";
  }).filter(Boolean);
}

/** CPC symbols from a bag of strings or `{ cpcSymbolText }`-ish objects. */
function cpcList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((e) => {
    if (typeof e === "string") return e;
    if (e && typeof e === "object") {
      const r = e as Record<string, unknown>;
      const sym = r["cpcSymbolText"] ?? r["symbol"] ?? r["cpc"];
      return typeof sym === "string" ? sym : "";
    }
    return "";
  }).filter(Boolean);
}

function guardUsptoSearch(raw: unknown): BarePatent[] {
  return guardShape("uspto-patent-search", raw, (v) => {
    // Documented PatentDataResponse: { count, patentFileWrapperDataBag: [...], requestIdentifier }.
    const o = expectRecord(v);
    const bag = expectArray(o["patentFileWrapperDataBag"], "patentFileWrapperDataBag");
    return bag.map((p) => {
      const r = expectRecord(p);
      const appNo = optString(r, "applicationNumberText");
      const md = r["applicationMetaData"] != null ? expectRecord(r["applicationMetaData"]) : {};
      const patentNumber = optString(md, "patentNumber") ?? appNo ?? "";
      if (!patentNumber) throw new Error("missing patentNumber/applicationNumberText");
      return {
        patentNumber,
        title: optString(md, "inventionTitle") ?? "",
        assignees: nameList(r["assignmentBag"]),
        inventors: nameList(md["inventorBag"]),
        filingDate: optString(md, "filingDate"),
        grantDate: optString(md, "grantDate"),
        status: optString(md, "applicationStatusDescriptionText"),
        cpcCodes: cpcList(md["cpcClassificationBag"]),
      };
    });
  }, "uspto");
}

function guardTsdrStatus(raw: unknown): BareTrademark {
  return guardShape("tsdr-casestatus", raw, (v) => {
    const r = expectRecord(v);
    const serialNumber =
      optString(r, "serialNumber") ?? optString(r, "serial_number") ?? optString(r, "applicationNumber") ?? "";
    if (!serialNumber) throw new Error("missing serialNumber");
    return {
      serialNumber,
      mark: optString(r, "markVerbalElementText") ?? optString(r, "mark") ?? "",
      owner: optString(r, "ownerName") ?? "",
      status: optString(r, "statusCode") ?? optString(r, "status") ?? "",
      filingDate: optString(r, "filingDate") ?? optString(r, "applicationDate"),
    };
  }, "tsdr");
}

export class PatentsBundle extends BundleBase {
  private readonly usptoApiKey?: string;
  private readonly tsdrApiKey?: string;

  constructor(opts: PatentsBundleOptions = {}) {
    super(opts);
    this.usptoApiKey = opts.usptoApiKey;
    this.tsdrApiKey = opts.tsdrApiKey;
  }

  /**
   * Full-text patent search (USPTO ODP, GATED). Bulk caches 1d
   * (default maxAge 86400s).
   */
  async searchPatents(args: { query: string; limit?: number }, options?: ReadOptions): Promise<Patent[]> {
    if (!this.usptoApiKey) throw new UpstreamAuthRequired("uspto", undefined, { source: "uspto" });
    const key = this.usptoApiKey;
    const limit = args.limit ?? 25;
    return this.readMany({
      bundleId: PATENTS_BUNDLE_ID,
      source: "uspto",
      cacheKey: this.key(PATENTS_BUNDLE_ID, "patent-search", args.query, limit),
      defaultMaxAgeSec: 86_400,
      ttlSec: 7 * 86400,
      options,
      fetch: async () => {
        const t = this.transport("https://api.uspto.gov", "uspto");
        const { data } = await t.request({
          method: "POST",
          path: "/api/v1/patent/applications/search",
          headers: { "X-API-KEY": key },
          body: { q: args.query, pagination: { offset: 0, limit } },
          guard: guardUsptoSearch,
        });
        return data;
      },
    });
  }

  /** Trademark case status (TSDR, GATED). Status on-demand → maxAge 3600s. */
  async trademarkStatus(args: { serialNumber: string }, options?: ReadOptions): Promise<Trademark> {
    if (!this.tsdrApiKey) throw new UpstreamAuthRequired("uspto-tsdr", undefined, { source: "uspto-tsdr" });
    const key = this.tsdrApiKey;
    return this.readOne({
      bundleId: PATENTS_BUNDLE_ID,
      source: "uspto-tsdr",
      cacheKey: this.key(PATENTS_BUNDLE_ID, "trademark", args.serialNumber),
      defaultMaxAgeSec: 3600,
      ttlSec: 86_400,
      options,
      fetch: async () => {
        const t = this.transport("https://tsdrapi.uspto.gov", "uspto-tsdr");
        // TSDR case-status route: the serial number carries the `sn` prefix.
        const { data } = await t.request({
          path: `/ts/cd/casestatus/sn${encodeURIComponent(args.serialNumber)}/info.json`,
          headers: { "USPTO-API-KEY": key },
          guard: guardTsdrStatus,
        });
        return data;
      },
    });
  }
}
