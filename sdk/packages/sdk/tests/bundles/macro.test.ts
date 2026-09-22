import { describe, expect, it } from "vitest";
import { MacroBundle } from "../../src/bundles/enterprise/macro.js";
import { UpstreamAuthRequired } from "../../src/core/errors.js";
import { jsonResponse, mockFetch, route } from "../helpers.js";

function macroFetch() {
  return mockFetch([
    route("api.bls.gov/publicAPI/v2/timeseries/data", () =>
      jsonResponse({
        Results: { series: [{
          seriesID: "CUUR0000SA0",
          data: [
            { year: "2024", period: "M01", periodName: "January", value: "310.2" },
            { year: "2024", period: "M02", periodName: "February", value: "-" },
          ],
        }] },
      }),
      "POST",
    ),
    route("api.census.gov/data/2023/acs/acs5", () =>
      jsonResponse([["NAME", "B19013_001E", "state"], ["Alabama", "59000", "01"], ["Alaska", "78000", "02"]]),
    ),
    route("api.stlouisfed.org/fred/series/observations", () =>
      jsonResponse({ observations: [{ date: "2024-01-01", value: "21000.5" }, { date: "2023-10-01", value: "." }] }),
    ),
    route("api.stlouisfed.org/fred/series?", () =>
      jsonResponse({ seriess: [{ id: "GDP", title: "Gross Domestic Product", units: "Billions of Dollars" }] }),
    ),
  ]);
}

describe("MacroBundle", () => {
  it("blsSeries POSTs series ids and normalizes observations", async () => {
    const fetch = macroFetch();
    const b = new MacroBundle({ fetch });
    const series = await b.blsSeries({ seriesIds: ["CUUR0000SA0"], startYear: "2024", endYear: "2024" });
    expect(series).toHaveLength(1);
    expect(series[0].seriesId).toBe("CUUR0000SA0");
    expect(series[0].observations[0]).toEqual({ date: "2024-01-01", value: 310.2 });
    expect(series[0].observations[1].value).toBeNull(); // "-" → null
    expect(series[0].source).toBe("bls");
    const call = fetch.captured.find((c) => c.url.includes("api.bls.gov"));
    expect(call?.method).toBe("POST");
    expect(call?.bodyText).toContain("CUUR0000SA0");
  });

  it("censusQuery returns tabular data", async () => {
    const b = new MacroBundle({ fetch: macroFetch() });
    const table = await b.censusQuery({ year: "2023", dataset: "acs/acs5", get: ["NAME", "B19013_001E"], forClause: "state:*" });
    expect(table.columns).toEqual(["NAME", "B19013_001E", "state"]);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0]).toEqual(["Alabama", "59000", "01"]);
    expect(table.source).toBe("census");
  });

  it("fredObservations without the end user's key → UpstreamAuthRequired", async () => {
    const b = new MacroBundle({ fetch: macroFetch() });
    await expect(b.fredObservations({ seriesId: "GDP" })).rejects.toBeInstanceOf(UpstreamAuthRequired);
    await expect(b.fredSeriesInfo({ seriesId: "GDP" })).rejects.toBeInstanceOf(UpstreamAuthRequired);
  });

  it("fredObservations with key normalizes macro series ('.' → null)", async () => {
    const b = new MacroBundle({ fetch: macroFetch(), fredApiKey: "user-fred-key" });
    const s = await b.fredObservations({ seriesId: "GDP" });
    expect(s.seriesId).toBe("GDP");
    expect(s.observations[0]).toEqual({ date: "2024-01-01", value: 21000.5 });
    expect(s.observations[1].value).toBeNull();
    expect(s.source).toBe("fred");
  });
});
