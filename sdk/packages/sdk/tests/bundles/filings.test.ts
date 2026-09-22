import { describe, expect, it } from "vitest";
import { FilingsBundle } from "../../src/bundles/enterprise/filings.js";
import { jsonResponse, mockFetch, route } from "../helpers.js";

function filingsFetch() {
  return mockFetch([
    route("www.sec.gov/files/company_tickers.json", () =>
      jsonResponse({ "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." } }),
    ),
    route("data.sec.gov/submissions/CIK0000320193.json", () =>
      jsonResponse({
        cik: "0000320193", name: "Apple Inc.",
        filings: { recent: {
          form: ["10-K", "10-Q"],
          filingDate: ["2024-11-01", "2024-08-01"],
          accessionNumber: ["0000320193-24-000123", "0000320193-24-000100"],
          primaryDocument: ["aapl-20240928.htm", "aapl-20240629.htm"],
        } },
      }),
    ),
    route("data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json", () =>
      jsonResponse({
        cik: "0000320193", entityName: "Apple Inc.",
        facts: { "us-gaap": { Revenues: {
          label: "Revenues",
          units: { USD: [{ start: "2023-10-01", end: "2024-09-28", val: 391_035_000_000, accn: "x", fy: 2024, fp: "FY", form: "10-K", filed: "2024-11-01" }] },
        } } },
      }),
    ),
    route("data.sec.gov/api/xbrl/companyconcept/CIK0000320193/us-gaap/Revenues.json", () =>
      jsonResponse({
        taxonomy: "us-gaap", tag: "Revenues",
        units: { USD: [{ start: "2023-10-01", end: "2024-09-28", val: 391_035_000_000, form: "10-K", filed: "2024-11-01" }] },
      }),
    ),
  ]);
}

describe("FilingsBundle", () => {
  it("companyTickers returns the ticker→CIK directory", async () => {
    const b = new FilingsBundle({ fetch: filingsFetch() });
    const tickers = await b.companyTickers();
    expect(tickers[0]).toMatchObject({ ticker: "AAPL", cik: "320193", companyName: "Apple Inc." });
    expect(tickers[0].source).toBe("sec-edgar");
  });

  it("submissions normalizes recent filings with document URLs", async () => {
    const b = new FilingsBundle({ fetch: filingsFetch() });
    const filings = await b.submissions({ cik: "320193", limit: 10 });
    expect(filings).toHaveLength(2);
    expect(filings[0]).toMatchObject({
      cik: "320193", companyName: "Apple Inc.", form: "10-K", filingDate: "2024-11-01",
      accessionNumber: "0000320193-24-000123",
    });
    expect(filings[0].documentUrl).toBe("https://www.sec.gov/Archives/edgar/data/320193/000032019324000123/aapl-20240928.htm");
    expect(filings[0].freshness).toBe("LIVE");
  });

  it("submissions filters by form", async () => {
    const b = new FilingsBundle({ fetch: filingsFetch() });
    const filings = await b.submissions({ cik: 320193, form: "10-Q" });
    expect(filings).toHaveLength(1);
    expect(filings[0].form).toBe("10-Q");
  });

  it("companyFacts flattens XBRL facts", async () => {
    const b = new FilingsBundle({ fetch: filingsFetch() });
    const facts = await b.companyFacts({ cik: "320193", concept: "us-gaap.Revenues" });
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      cik: "320193", concept: "us-gaap:Revenues", value: 391_035_000_000, unit: "USD",
      period: "2024-09-28", form: "10-K",
    });
  });

  it("companyConcept returns one concept series", async () => {
    const b = new FilingsBundle({ fetch: filingsFetch() });
    const facts = await b.companyConcept({ cik: 320193, tag: "Revenues" });
    expect(facts[0].concept).toBe("us-gaap:Revenues");
    expect(facts[0].value).toBe(391_035_000_000);
  });

  it("sends a descriptive User-Agent (SEC requirement)", async () => {
    const fetch = filingsFetch();
    const b = new FilingsBundle({ fetch, contactEmail: "ops@example.com" });
    await b.companyTickers();
    const ua = fetch.captured[0].headers["user-agent"];
    expect(ua).toContain("unified-data-sdk");
    expect(ua).toContain("ops@example.com");
  });
});
