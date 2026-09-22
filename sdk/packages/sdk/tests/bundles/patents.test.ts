import { describe, expect, it } from "vitest";
import { PatentsBundle } from "../../src/bundles/enterprise/patents.js";
import { UpstreamAuthRequired } from "../../src/core/errors.js";
import { jsonResponse, mockFetch, route } from "../helpers.js";

function patentsFetch() {
  return mockFetch([
    // Documented ODP shape: { count, patentFileWrapperDataBag: [{ applicationNumberText, applicationMetaData, assignmentBag, ... }] }
    route("api.uspto.gov/api/v1/patent/applications/search", () =>
      jsonResponse({
        count: 1,
        patentFileWrapperDataBag: [{
          applicationNumberText: "16123456",
          applicationMetaData: {
            inventionTitle: "Widget apparatus",
            patentNumber: "US1234567B2",
            filingDate: "2020-01-15",
            grantDate: "2022-06-01",
            applicationStatusDescriptionText: "Patented Case",
            inventorBag: [{ inventorNameText: "Jane Smith" }],
            cpcClassificationBag: [{ cpcSymbolText: "H04L12" }],
          },
          assignmentBag: [{ assigneeName: "Acme Corp" }],
        }],
        requestIdentifier: "req-1",
      }),
      "POST",
    ),
    route("tsdrapi.uspto.gov/ts/cd/casestatus", () =>
      jsonResponse({
        serialNumber: "88442211", markVerbalElementText: "ACME", ownerName: "Acme Corp",
        statusCode: "REGISTERED", filingDate: "2019-03-01",
      }),
    ),
  ]);
}

describe("PatentsBundle", () => {
  it("searchPatents without the end user's key → UpstreamAuthRequired", async () => {
    const b = new PatentsBundle({ fetch: patentsFetch() });
    await expect(b.searchPatents({ query: "widget" })).rejects.toBeInstanceOf(UpstreamAuthRequired);
  });

  it("searchPatents sends X-API-KEY and normalizes patents", async () => {
    const fetch = patentsFetch();
    const b = new PatentsBundle({ fetch, usptoApiKey: "user-uspto-key" });
    const patents = await b.searchPatents({ query: "widget", limit: 10 });
    expect(patents).toHaveLength(1);
    expect(patents[0]).toMatchObject({
      patentNumber: "US1234567B2", title: "Widget apparatus",
      assignees: ["Acme Corp"], inventors: ["Jane Smith"], cpcCodes: ["H04L12"],
      status: "Patented Case",
    });
    expect(patents[0].source).toBe("uspto");
    expect(patents[0].freshness).toBe("LIVE");
    const call = fetch.captured.find((c) => c.url.includes("api.uspto.gov"));
    expect(call?.url).toContain("/api/v1/patent/applications/search");
    expect(call?.headers["x-api-key"]).toBe("user-uspto-key");
    expect(call?.method).toBe("POST");
  });

  it("trademarkStatus without the end user's key → UpstreamAuthRequired", async () => {
    const b = new PatentsBundle({ fetch: patentsFetch() });
    await expect(b.trademarkStatus({ serialNumber: "88442211" })).rejects.toBeInstanceOf(UpstreamAuthRequired);
  });

  it("trademarkStatus normalizes TSDR case status", async () => {
    const fetch = patentsFetch();
    const b = new PatentsBundle({ fetch, tsdrApiKey: "user-tsdr-key" });
    const tm = await b.trademarkStatus({ serialNumber: "88442211" });
    expect(tm).toMatchObject({
      serialNumber: "88442211", mark: "ACME", owner: "Acme Corp", status: "REGISTERED",
    });
    expect(tm.source).toBe("uspto-tsdr");
    const call = fetch.captured.find((c) => c.url.includes("tsdrapi.uspto.gov"));
    expect(call?.url).toContain("/ts/cd/casestatus/sn88442211/info.json");
    expect(call?.headers["uspto-api-key"]).toBe("user-tsdr-key");
  });
});
