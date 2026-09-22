import { describe, expect, it } from "vitest";
import { RegistriesBundle } from "../../src/bundles/enterprise/registries.js";
import { UpstreamAuthRequired } from "../../src/core/errors.js";
import { jsonResponse, mockFetch, route } from "../helpers.js";

function registriesFetch() {
  return mockFetch([
    route("api.company-information.service.gov.uk/company/12345678", () =>
      jsonResponse({
        company_number: "12345678", company_name: "ACME LTD", company_status: "active",
        date_of_creation: "2010-05-01",
        registered_office_address: { address_line_1: "1 Main St", locality: "London", postal_code: "E1 1AA", country: "England" },
      }),
    ),
    route("api.gleif.org/api/v1/lei-records/984500", () =>
      jsonResponse({
        data: { id: "984500ABCDEF", attributes: {
          entity: { legalName: { name: "Acme Ltd" }, legalJurisdiction: "GB", legalForm: { id: "XXXX" } },
          registration: { status: "ISSUED" },
        } },
      }),
    ),
    route("api.gleif.org/api/v1/lei-records?", () =>
      jsonResponse({
        data: [{ id: "984500ABCDEF", attributes: {
          entity: { legalName: { name: "Acme Ltd" }, legalJurisdiction: "GB", legalForm: { id: "XXXX" } },
          registration: { status: "ISSUED" },
        } }],
      }),
    ),
    route("api.opencorporates.com/v0.4/companies/search", () =>
      jsonResponse({
        results: { companies: [{ company: {
          name: "Acme Ltd", company_number: "12345678", jurisdiction_code: "gb",
          current_status: "Active", incorporation_date: "2010-05-01", registered_address_in_full: "1 Main St, London",
        } }] },
      }),
    ),
    route("ops.epo.org/3.2/rest-services/published-data/search/biblio", () =>
      jsonResponse({
        "ops:world-patent-data": { "ops:biblio-search": { "ops:search-result": {
          "ops:publication-reference": [{
            "document-id": { country: "EP", "doc-number": "1234567" },
            biblio: { "invention-title": { $: "Widget apparatus" } },
          }],
        } } },
      }),
    ),
  ]);
}

describe("RegistriesBundle", () => {
  it("ukCompany without the end user's key → UpstreamAuthRequired", async () => {
    const b = new RegistriesBundle({ fetch: registriesFetch() });
    await expect(b.ukCompany({ companyNumber: "12345678" })).rejects.toBeInstanceOf(UpstreamAuthRequired);
    await expect(b.ukCompanySearch({ q: "acme" })).rejects.toBeInstanceOf(UpstreamAuthRequired);
  });

  it("ukCompany normalizes Companies House profile (Basic auth)", async () => {
    const fetch = registriesFetch();
    const b = new RegistriesBundle({ fetch, companiesHouseApiKey: "user-ch-key" });
    const c = await b.ukCompany({ companyNumber: "12345678" });
    expect(c).toMatchObject({
      registry: "uk-companies-house", companyNumber: "12345678",
      legalName: "ACME LTD", status: "active", incorporationDate: "2010-05-01",
    });
    expect(c.registeredAddress).toContain("1 Main St");
    const call = fetch.captured.find((u) => u.url.includes("company-information.service.gov.uk/company/"));
    expect(call?.headers["authorization"]).toMatch(/^Basic /);
  });

  it("leiRecord normalizes GLEIF data (KEYLESS)", async () => {
    const b = new RegistriesBundle({ fetch: registriesFetch() });
    const lei = await b.leiRecord({ lei: "984500ABCDEF" });
    expect(lei).toMatchObject({
      lei: "984500ABCDEF", legalName: "Acme Ltd", jurisdiction: "GB", status: "ISSUED",
    });
    expect(lei.source).toBe("gleif");
  });

  it("leiSearch returns LEI records", async () => {
    const b = new RegistriesBundle({ fetch: registriesFetch() });
    const results = await b.leiSearch({ name: "Acme" });
    expect(results).toHaveLength(1);
    expect(results[0].legalName).toBe("Acme Ltd");
  });

  it("openCorporatesSearch without token → UpstreamAuthRequired; with token works", async () => {
    const b = new RegistriesBundle({ fetch: registriesFetch() });
    await expect(b.openCorporatesSearch({ q: "acme" })).rejects.toBeInstanceOf(UpstreamAuthRequired);
    const b2 = new RegistriesBundle({ fetch: registriesFetch(), openCorporatesToken: "oc-token" });
    const results = await b2.openCorporatesSearch({ q: "acme", jurisdictionCode: "gb" });
    expect(results[0].registry).toBe("opencorporates");
    expect(results[0].legalName).toBe("Acme Ltd");
  });

  it("epoSearch without token → UpstreamAuthRequired; with token works", async () => {
    const b = new RegistriesBundle({ fetch: registriesFetch() });
    await expect(b.epoSearch({ q: "widget" })).rejects.toBeInstanceOf(UpstreamAuthRequired);
    const fetch = registriesFetch();
    const b2 = new RegistriesBundle({ fetch, epoAccessToken: "epo-token" });
    const patents = await b2.epoSearch({ q: "widget" });
    expect(patents[0].patentNumber).toBe("EP1234567");
    expect(patents[0].title).toBe("Widget apparatus");
    expect(patents[0].source).toBe("epo");
    const call = fetch.captured.find((c) => c.url.includes("ops.epo.org"));
    expect(call?.url).toContain("/published-data/search/biblio");
    expect(call?.headers["authorization"]).toBe("Bearer epo-token");
  });
});
