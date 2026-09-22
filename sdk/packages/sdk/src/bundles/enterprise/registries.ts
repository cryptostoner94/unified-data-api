/**
 * Enterprise registries bundle (`enterprise.registries`) — company identity.
 *
 * Sources:
 *   - UK Companies House  https://api.company-information.service.gov.uk
 *     FREE-KEY (HTTP Basic, key as username; 600 req/5-min window) — GATED,
 *     end user's own key. Data under the Open Government Licence (attribution).
 *   - GLEIF LEI            https://api.gleif.org/api/v1  KEYLESS
 *     CC0 public domain — explicitly commercial-OK; data updates daily.
 *   - OpenCorporates       https://api.opencorporates.com/v0.4/
 *     FREE-KEY (token; key must stay confidential per their terms) — GATED.
 *   - EPO OPS              https://ops.epo.org/3.2/rest-services
 *     FREE-KEY (OAuth; end user supplies their own access token) — GATED.
 *
 * Freshness (spec §2.2): company registries revalidated daily (maxAge 86400s).
 */
import { BundleBase, type BundleSharedOptions } from "../base.js";
import { UpstreamAuthRequired } from "../../core/errors.js";
import { expectArray, expectRecord, guardShape, optString } from "../../core/schema.js";
import type { CompanyRecord, LeiRecord, Patent, ReadOptions } from "../../types/index.js";

export const REGISTRIES_BUNDLE_ID = "enterprise.registries";

export interface RegistriesBundleOptions extends BundleSharedOptions {
  /** End user's own Companies House API key (FREE-KEY). */
  companiesHouseApiKey?: string;
  /** End user's own OpenCorporates token (FREE-KEY). */
  openCorporatesToken?: string;
  /** End user's own EPO OPS OAuth access token (FREE-KEY). */
  epoAccessToken?: string;
}

type BareCompany = Omit<CompanyRecord, "source" | "fetchedAt" | "freshness">;
type BareLei = Omit<LeiRecord, "source" | "fetchedAt" | "freshness">;

function addressLines(addr: Record<string, unknown>): string | undefined {
  const parts = ["address_line_1", "address_line_2", "locality", "region", "postal_code", "country"]
    .map((k) => optString(addr, k))
    .filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function guardCompaniesHouseCompany(raw: unknown): BareCompany {
  return guardShape("companies-house-company", raw, (v) => {
    const o = expectRecord(v);
    const addr = o["registered_office_address"] != null ? expectRecord(o["registered_office_address"]) : undefined;
    return {
      registry: "uk-companies-house",
      companyNumber: optString(o, "company_number") ?? "",
      legalName: optString(o, "company_name") ?? "",
      status: optString(o, "company_status") ?? "",
      incorporationDate: optString(o, "date_of_creation"),
      registeredAddress: addr ? addressLines(addr) : undefined,
    };
  }, "uk-companies-house");
}

function guardCompaniesHouseSearch(raw: unknown): BareCompany[] {
  return guardShape("companies-house-search", raw, (v) => {
    const o = expectRecord(v);
    return expectArray(o["items"] ?? []).map((i) => {
      const r = expectRecord(i);
      const addr = r["address"] != null ? expectRecord(r["address"]) : undefined;
      return {
        registry: "uk-companies-house",
        companyNumber: optString(r, "company_number") ?? "",
        legalName: optString(r, "title") ?? "",
        status: optString(r, "company_status") ?? "",
        incorporationDate: optString(r, "date_of_creation"),
        registeredAddress: addr ? addressLines(addr) : undefined,
      };
    });
  }, "uk-companies-house");
}

function guardGleifRecord(raw: unknown): BareLei {
  return guardShape("gleif-lei-record", raw, (v) => {
    const o = expectRecord(v);
    const data = expectRecord(o["data"] ?? {});
    const attr = expectRecord(data["attributes"] ?? {});
    const entity = expectRecord(attr["entity"] ?? {});
    const legalName = expectRecord(entity["legalName"] ?? {});
    const registration = expectRecord(attr["registration"] ?? {});
    return {
      lei: String(data["id"] ?? ""),
      legalName: optString(legalName, "name") ?? "",
      jurisdiction: optString(entity, "legalJurisdiction") ?? "",
      legalForm: optString(expectRecord(entity["legalForm"] ?? {}), "id") ?? "",
      status: optString(registration, "status") ?? "",
    };
  }, "gleif");
}

function guardGleifSearch(raw: unknown): BareLei[] {
  return guardShape("gleif-search", raw, (v) => {
    const o = expectRecord(v);
    return expectArray(o["data"] ?? []).map((d) => guardGleifRecord({ data: d }));
  }, "gleif");
}

function guardOpenCorporatesSearch(raw: unknown): BareCompany[] {
  return guardShape("opencorporates-search", raw, (v) => {
    const o = expectRecord(v);
    const results = expectRecord(o["results"] ?? {});
    return expectArray(results["companies"] ?? []).map((c) => {
      const company = expectRecord(expectRecord(c)["company"] ?? {});
      return {
        registry: "opencorporates",
        companyNumber: optString(company, "company_number") ?? "",
        legalName: optString(company, "name") ?? "",
        status: optString(company, "current_status") ?? "",
        incorporationDate: optString(company, "incorporation_date"),
        registeredAddress: optString(company, "registered_address_in_full"),
      };
    });
  }, "opencorporates");
}

function guardEpoSearch(raw: unknown): Array<Omit<Patent, "source" | "fetchedAt" | "freshness">> {
  return guardShape("epo-search", raw, (v) => {
    const o = expectRecord(v);
    const root = expectRecord(o["ops:world-patent-data"] ?? o);
    const biblio = expectRecord(root["ops:biblio-search"] ?? {});
    const result = expectRecord(biblio["ops:search-result"] ?? {});
    const pubs = result["ops:publication-reference"];
    const list = Array.isArray(pubs) ? pubs : pubs ? [pubs] : [];
    return list.map((p) => {
      const r = expectRecord(p);
      const docId = expectRecord(r["document-id"] ?? {});
      const country = optString(docId, "country") ?? "";
      const docNumber = optString(docId, "doc-number") ?? "";
      const bib = expectRecord(r["biblio"] ?? {});
      const title = optString(expectRecord(bib["invention-title"] ?? {}), "$") ?? "";
      return {
        patentNumber: `${country}${docNumber}`,
        title,
        assignees: [],
        inventors: [],
        cpcCodes: [],
      };
    });
  }, "epo");
}

export class RegistriesBundle extends BundleBase {
  private readonly companiesHouseApiKey?: string;
  private readonly openCorporatesToken?: string;
  private readonly epoAccessToken?: string;

  constructor(opts: RegistriesBundleOptions = {}) {
    super(opts);
    this.companiesHouseApiKey = opts.companiesHouseApiKey;
    this.openCorporatesToken = opts.openCorporatesToken;
    this.epoAccessToken = opts.epoAccessToken;
  }

  private basicAuth(key: string): string {
    const bytes = new TextEncoder().encode(`${key}:`);
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    const g = globalThis as { btoa?: (s: string) => string; Buffer?: { from(s: string): { toString(e: string): string } } };
    const b64 = g.btoa ? g.btoa(binary) : g.Buffer!.from(`${key}:`).toString("base64");
    return `Basic ${b64}`;
  }

  /** UK company profile (Companies House, GATED). */
  async ukCompany(args: { companyNumber: string }, options?: ReadOptions): Promise<CompanyRecord> {
    if (!this.companiesHouseApiKey) throw new UpstreamAuthRequired("uk-companies-house", undefined, { source: "uk-companies-house" });
    const key = this.companiesHouseApiKey;
    return this.readOne({
      bundleId: REGISTRIES_BUNDLE_ID,
      source: "uk-companies-house",
      cacheKey: this.key(REGISTRIES_BUNDLE_ID, "uk-company", args.companyNumber),
      defaultMaxAgeSec: 86_400,
      ttlSec: 7 * 86400,
      options,
      fetch: async () => {
        const t = this.transport("https://api.company-information.service.gov.uk", "uk-companies-house");
        const { data } = await t.request({
          path: `/company/${encodeURIComponent(args.companyNumber)}`,
          headers: { Authorization: this.basicAuth(key) },
          guard: guardCompaniesHouseCompany,
        });
        return data;
      },
    });
  }

  /** UK company search (Companies House, GATED). */
  async ukCompanySearch(args: { q: string }, options?: ReadOptions): Promise<CompanyRecord[]> {
    if (!this.companiesHouseApiKey) throw new UpstreamAuthRequired("uk-companies-house", undefined, { source: "uk-companies-house" });
    const key = this.companiesHouseApiKey;
    return this.readMany({
      bundleId: REGISTRIES_BUNDLE_ID,
      source: "uk-companies-house",
      cacheKey: this.key(REGISTRIES_BUNDLE_ID, "uk-search", args.q),
      defaultMaxAgeSec: 86_400,
      ttlSec: 7 * 86400,
      options,
      fetch: async () => {
        const t = this.transport("https://api.company-information.service.gov.uk", "uk-companies-house");
        const { data } = await t.request({
          path: "/search/companies",
          query: { q: args.q },
          headers: { Authorization: this.basicAuth(key) },
          guard: guardCompaniesHouseSearch,
        });
        return data;
      },
    });
  }

  /** LEI record by LEI code (GLEIF, KEYLESS, CC0). */
  async leiRecord(args: { lei: string }, options?: ReadOptions): Promise<LeiRecord> {
    return this.readOne({
      bundleId: REGISTRIES_BUNDLE_ID,
      source: "gleif",
      cacheKey: this.key(REGISTRIES_BUNDLE_ID, "lei", args.lei),
      defaultMaxAgeSec: 86_400,
      ttlSec: 7 * 86400,
      options,
      fetch: async () => {
        const t = this.transport("https://api.gleif.org/api/v1", "gleif");
        const { data } = await t.request({ path: `/lei-records/${encodeURIComponent(args.lei)}`, guard: guardGleifRecord });
        return data;
      },
    });
  }

  /** Fuzzy LEI search by legal name (GLEIF, KEYLESS, CC0). */
  async leiSearch(args: { name: string; limit?: number }, options?: ReadOptions): Promise<LeiRecord[]> {
    return this.readMany({
      bundleId: REGISTRIES_BUNDLE_ID,
      source: "gleif",
      cacheKey: this.key(REGISTRIES_BUNDLE_ID, "lei-search", args.name, args.limit ?? 10),
      defaultMaxAgeSec: 86_400,
      ttlSec: 7 * 86400,
      options,
      fetch: async () => {
        const t = this.transport("https://api.gleif.org/api/v1", "gleif");
        const { data } = await t.request({
          path: "/lei-records",
          query: { "filter[entity.legalName]": args.name, "page[size]": args.limit ?? 10 },
          guard: guardGleifSearch,
        });
        return data;
      },
    });
  }

  /** Company search across 130+ jurisdictions (OpenCorporates, GATED). */
  async openCorporatesSearch(
    args: { q: string; jurisdictionCode?: string },
    options?: ReadOptions,
  ): Promise<CompanyRecord[]> {
    if (!this.openCorporatesToken) throw new UpstreamAuthRequired("opencorporates", undefined, { source: "opencorporates" });
    const token = this.openCorporatesToken;
    return this.readMany({
      bundleId: REGISTRIES_BUNDLE_ID,
      source: "opencorporates",
      cacheKey: this.key(REGISTRIES_BUNDLE_ID, "oc-search", args.q, args.jurisdictionCode ?? ""),
      defaultMaxAgeSec: 86_400,
      ttlSec: 7 * 86400,
      options,
      fetch: async () => {
        const t = this.transport("https://api.opencorporates.com/v0.4", "opencorporates", { minIntervalMs: 200 });
        const { data } = await t.request({
          path: "/companies/search",
          query: { q: args.q, jurisdiction_code: args.jurisdictionCode, api_token: token },
          guard: guardOpenCorporatesSearch,
        });
        return data;
      },
    });
  }

  /**
   * EPO OPS patent search (GATED — end user's own OPS OAuth access token).
   * Uses the `/published-data/search/biblio` constituent so title/parties/CPC
   * come back inline in the search response (documented OPS v3.2 service;
   * plain `/search` returns references only).
   * Requests JSON (`Accept: application/json`); OPS also serves XML.
   */
  async epoSearch(args: { q: string }, options?: ReadOptions): Promise<Patent[]> {
    if (!this.epoAccessToken) throw new UpstreamAuthRequired("epo", undefined, { source: "epo" });
    const token = this.epoAccessToken;
    return this.readMany({
      bundleId: REGISTRIES_BUNDLE_ID,
      source: "epo",
      cacheKey: this.key(REGISTRIES_BUNDLE_ID, "epo-search", args.q),
      defaultMaxAgeSec: 86_400,
      ttlSec: 7 * 86400,
      options,
      fetch: async () => {
        const t = this.transport("https://ops.epo.org/3.2/rest-services", "epo");
        const { data } = await t.request({
          path: "/published-data/search/biblio",
          query: { q: args.q },
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          guard: guardEpoSearch,
        });
        return data;
      },
    });
  }
}
