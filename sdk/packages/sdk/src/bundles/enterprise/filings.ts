/**
 * Enterprise filings bundle (`enterprise.filings`) — SEC EDGAR.
 *
 * Sources (all KEYLESS; US public-domain data; no commercial restriction found):
 *   - https://data.sec.gov/submissions/CIK{cik}.json
 *   - https://www.sec.gov/files/company_tickers.json
 *   - https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json
 *   - https://data.sec.gov/api/xbrl/companyconcept/CIK{cik}/us-gaap/{tag}.json
 *
 * SEC requirements honored: descriptive User-Agent (name + contact email,
 * set on every transport) and ≤10 req/sec per IP (100ms minimum gap).
 */
import { BundleBase, type BundleSharedOptions } from "../base.js";
import { expectArray, expectRecord, guardShape, num, optString } from "../../core/schema.js";
import type { Filing, FinancialFact, ReadOptions } from "../../types/index.js";

export const FILINGS_BUNDLE_ID = "enterprise.filings";

export interface TickerEntry {
  ticker: string;
  cik: string;
  companyName: string;
}

type BareFiling = Omit<Filing, "source" | "fetchedAt" | "freshness">;
type BareFact = Omit<FinancialFact, "source" | "fetchedAt" | "freshness">;

function padCik(cik: string | number): string {
  return String(cik).padStart(10, "0");
}

function guardCompanyTickers(raw: unknown): TickerEntry[] {
  return guardShape("sec-company-tickers", raw, (v) => {
    const o = expectRecord(v);
    return Object.values(o).map((e) => {
      const r = expectRecord(e);
      return {
        ticker: String(r["ticker"] ?? ""),
        cik: String(r["cik_str"] ?? ""),
        companyName: String(r["title"] ?? ""),
      };
    });
  }, "sec-edgar");
}

function guardSubmissions(raw: unknown): BareFiling[] {
  return guardShape("sec-submissions", raw, (v) => {
    const o = expectRecord(v);
    const cik = String(o["cik"] ?? "");
    const companyName = String(o["name"] ?? "");
    const recent = expectRecord(expectRecord(o["filings"] ?? {})["recent"] ?? {});
    const forms = expectArray(recent["form"] ?? []);
    const dates = expectArray(recent["filingDate"] ?? []);
    const accns = expectArray(recent["accessionNumber"] ?? []);
    const docs = expectArray(recent["primaryDocument"] ?? []);
    const out: BareFiling[] = [];
    for (let i = 0; i < forms.length; i++) {
      const acc = String(accns[i] ?? "").replace(/-/g, "");
      const cikNoPad = String(Number(cik));
      out.push({
        cik: String(Number(cik)),
        companyName,
        form: String(forms[i] ?? ""),
        filingDate: String(dates[i] ?? ""),
        accessionNumber: String(accns[i] ?? ""),
        documentUrl: `https://www.sec.gov/Archives/edgar/data/${cikNoPad}/${acc}/${String(docs[i] ?? "")}`,
      });
    }
    return out;
  }, "sec-edgar");
}

function guardCompanyFacts(raw: unknown, cik: string, conceptFilter?: string, limit = 500): BareFact[] {
  return guardShape("sec-companyfacts", raw, (v) => {
    const o = expectRecord(v);
    const facts = expectRecord(o["facts"] ?? {});
    const out: BareFact[] = [];
    for (const [taxonomy, concepts] of Object.entries(facts)) {
      for (const [concept, def] of Object.entries(expectRecord(concepts))) {
        if (conceptFilter && `${taxonomy}.${concept}`.toLowerCase() !== conceptFilter.toLowerCase() && concept.toLowerCase() !== conceptFilter.toLowerCase()) continue;
        const units = expectRecord(expectRecord(def)["units"] ?? {});
        for (const [unit, observations] of Object.entries(units)) {
          for (const obs of expectArray(observations)) {
            const r = expectRecord(obs);
            out.push({
              cik,
              concept: `${taxonomy}:${concept}`,
              value: num(r["val"]),
              unit,
              period: String(r["end"] ?? r["fy"] ?? ""),
              form: optString(r, "form"),
              filedDate: optString(r, "filed"),
            });
            if (out.length >= limit) return out;
          }
        }
      }
    }
    return out;
  }, "sec-edgar");
}

export class FilingsBundle extends BundleBase {
  constructor(opts: BundleSharedOptions = {}) {
    super(opts);
  }

  private sec(host: "data" | "www") {
    return this.transport(
      host === "data" ? "https://data.sec.gov" : "https://www.sec.gov",
      "sec-edgar",
      { minIntervalMs: 100 }, // SEC guidance: ≤10 req/sec per IP
    );
  }

  /**
   * Full ticker → CIK directory. Reference data → default maxAge 7d.
   * Pass `{ form }` to filter recent filings by form type (e.g. "10-K").
   */
  async companyTickers(options?: ReadOptions): Promise<Array<TickerEntry & { source: string; fetchedAt: string; freshness: "LIVE" | "CACHED" | "ESTIMATE" }>> {
    return this.readMany({
      bundleId: FILINGS_BUNDLE_ID,
      source: "sec-edgar",
      cacheKey: this.key(FILINGS_BUNDLE_ID, "company-tickers"),
      defaultMaxAgeSec: 604_800,
      ttlSec: 14 * 86400,
      options,
      fetch: async () => {
        const { data } = await this.sec("www").request({ path: "/files/company_tickers.json", guard: guardCompanyTickers });
        return data;
      },
    });
  }

  /** Recent filings for a company (by CIK). Poll-style → default maxAge 900s. */
  async submissions(args: { cik: string | number; form?: string; limit?: number }, options?: ReadOptions): Promise<Filing[]> {
    const cik = String(args.cik);
    return this.readMany({
      bundleId: FILINGS_BUNDLE_ID,
      source: "sec-edgar",
      cacheKey: this.key(FILINGS_BUNDLE_ID, "submissions", cik, args.form ?? "all", args.limit ?? 40),
      defaultMaxAgeSec: 900,
      ttlSec: 3600,
      options,
      fetch: async () => {
        const { data } = await this.sec("data").request({
          path: `/submissions/CIK${padCik(cik)}.json`,
          guard: guardSubmissions,
        });
        const filtered = args.form ? data.filter((f) => f.form === args.form) : data;
        return filtered.slice(0, args.limit ?? 40);
      },
    });
  }

  /**
   * All XBRL company facts (flattened). Financials change quarterly —
   * revalidated daily (maxAge 86400s), cached 7d.
   */
  async companyFacts(
    args: { cik: string | number; concept?: string; limit?: number },
    options?: ReadOptions,
  ): Promise<FinancialFact[]> {
    const cik = String(Number(args.cik));
    return this.readMany({
      bundleId: FILINGS_BUNDLE_ID,
      source: "sec-edgar",
      cacheKey: this.key(FILINGS_BUNDLE_ID, "companyfacts", cik, args.concept ?? "all", args.limit ?? 500),
      defaultMaxAgeSec: 86_400,
      ttlSec: 7 * 86400,
      options,
      fetch: async () => {
        const { data } = await this.sec("data").request({
          path: `/api/xbrl/companyfacts/CIK${padCik(cik)}.json`,
          guard: (raw) => guardCompanyFacts(raw, cik, args.concept, args.limit ?? 500),
        });
        return data;
      },
    });
  }

  /** One XBRL concept time series (e.g. us-gaap / Revenues). */
  async companyConcept(
    args: { cik: string | number; taxonomy?: string; tag: string },
    options?: ReadOptions,
  ): Promise<FinancialFact[]> {
    const cik = String(Number(args.cik));
    const taxonomy = args.taxonomy ?? "us-gaap";
    return this.readMany({
      bundleId: FILINGS_BUNDLE_ID,
      source: "sec-edgar",
      cacheKey: this.key(FILINGS_BUNDLE_ID, "companyconcept", cik, taxonomy, args.tag),
      defaultMaxAgeSec: 86_400,
      ttlSec: 7 * 86400,
      options,
      fetch: async () => {
        const { data } = await this.sec("data").request({
          path: `/api/xbrl/companyconcept/CIK${padCik(cik)}/${taxonomy}/${args.tag}.json`,
          guard: (raw) =>
            guardShape("sec-companyconcept", raw, (v) => {
              const o = expectRecord(v);
              const units = expectRecord(o["units"] ?? {});
              const out: BareFact[] = [];
              for (const [unit, observations] of Object.entries(units)) {
                for (const obs of expectArray(observations)) {
                  const r = expectRecord(obs);
                  out.push({
                    cik,
                    concept: `${taxonomy}:${args.tag}`,
                    value: num(r["val"]),
                    unit,
                    period: String(r["end"] ?? r["fy"] ?? ""),
                    form: optString(r, "form"),
                    filedDate: optString(r, "filed"),
                  });
                }
              }
              return out;
            }, "sec-edgar"),
        });
        return data;
      },
    });
  }
}
