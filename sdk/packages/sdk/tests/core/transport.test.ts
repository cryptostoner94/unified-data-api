import { describe, expect, it, vi } from "vitest";
import { Transport } from "../../src/core/transport.js";
import { NetworkError, UpstreamAuthRequired, UpstreamRateLimited, UpstreamSchemaDrift } from "../../src/core/errors.js";
import { jsonResponse, mockFetch, route } from "../helpers.js";

function makeTransport(fetch: ReturnType<typeof mockFetch>, extra: Record<string, unknown> = {}) {
  return new Transport({
    baseUrl: "https://example.com",
    source: "example",
    fetch,
    retry: { baseDelayMs: 1, maxDelayMs: 5, jitter: false, sleep: async () => {} },
    ...extra,
  });
}

describe("Transport", () => {
  it("sends a descriptive User-Agent and Accept header", async () => {
    const fetch = mockFetch([route("/x", () => jsonResponse({ ok: true }))]);
    const t = makeTransport(fetch);
    await t.request({ path: "/x" });
    const ua = fetch.captured[0].headers["user-agent"];
    expect(ua).toContain("unified-data-sdk/0.1.0");
    expect(ua).toContain("source: example");
    expect(ua).toContain("contact:");
    expect(fetch.captured[0].headers["accept"]).toBe("application/json");
  });

  it("builds URLs with query params", async () => {
    const fetch = mockFetch([route("/depth", () => jsonResponse({}))]);
    const t = makeTransport(fetch);
    await t.request({ path: "/api/v3/depth", query: { symbol: "BTCUSDT", limit: 5, skip: undefined } });
    expect(fetch.captured[0].url).toBe("https://example.com/api/v3/depth?symbol=BTCUSDT&limit=5");
  });

  it("maps 429 → UpstreamRateLimited with parsed Retry-After", async () => {
    const fetch = mockFetch([
      route("/limited", () => jsonResponse({ msg: "slow" }, { status: 429, headers: { "retry-after": "2" } })),
    ]);
    const t = makeTransport(fetch);
    const err = await t.request({ path: "/limited" }).catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamRateLimited);
    expect((err as UpstreamRateLimited).retryAfterMs).toBe(2000);
  });

  it("retries 429 then succeeds", async () => {
    let n = 0;
    const fetch = mockFetch([
      route("/flaky", () => (++n === 1 ? jsonResponse({}, { status: 429, headers: { "retry-after": "0" } }) : jsonResponse({ ok: 1 }))),
    ]);
    const t = makeTransport(fetch);
    const { data } = await t.request<{ ok: number }>({ path: "/flaky" });
    expect(data).toEqual({ ok: 1 });
    expect(n).toBe(2);
  });

  it("maps 401/403 → UpstreamAuthRequired (no retry)", async () => {
    const fetch = mockFetch([route("/private", () => jsonResponse({}, { status: 401 }))]);
    const t = makeTransport(fetch);
    const err = await t.request({ path: "/private" }).catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamAuthRequired);
    expect(fetch.callCount()).toBe(1);
  });

  it("maps fetch throw → NetworkError", async () => {
    const t = makeTransport(mockFetch([]), {});
    const throwing = new Transport({
      baseUrl: "https://example.com",
      source: "example",
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
      retry: { baseDelayMs: 1, jitter: false, sleep: async () => {}, maxAttempts: 1 },
    });
    const err = await throwing.request({ path: "/x" }).catch((e) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(err.retryable).toBe(true);
  });

  it("shape-guard failure → UpstreamSchemaDrift", async () => {
    const fetch = mockFetch([route("/drift", () => jsonResponse({ wrong: "shape" }))]);
    const t = makeTransport(fetch);
    const err = await t
      .request({
        path: "/drift",
        guard: (raw) => {
          const o = raw as Record<string, unknown>;
          if (typeof o["price"] !== "number") throw new Error('expected a finite number at "price"');
          return o;
        },
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamSchemaDrift);
    expect(fetch.callCount()).toBe(1); // drift is not retryable
  });

  it("conditionalGet sends validators and honors 304", async () => {
    const fetch = mockFetch([
      {
        match: (url) => url.includes("/feed"),
        respond: (_url, init) =>
          (init?.headers as Record<string, string>)?.["If-None-Match"] === '"v1"'
            ? new Response(null, { status: 304 })
            : jsonResponse({ items: [1] }, { headers: { etag: '"v1"' } }),
      },
    ]);
    const t = makeTransport(fetch);
    const first = await t.conditionalGet({ path: "/feed" });
    expect(first.notModified).toBe(false);
    const second = await t.conditionalGet({ path: "/feed", validators: { etag: '"v1"' } });
    expect(second.notModified).toBe(true);
    expect(fetch.captured[1].headers["if-none-match"]).toBe('"v1"');
  });

  it("enforces minIntervalMs between requests", async () => {
    const fetch = mockFetch([route("/a", () => jsonResponse({}))]);
    const t = makeTransport(fetch, { minIntervalMs: 30 });
    const start = Date.now();
    await t.request({ path: "/a" });
    await t.request({ path: "/a" });
    expect(Date.now() - start).toBeGreaterThanOrEqual(25);
  });

  it("aborts on timeout → NetworkError", async () => {
    const hanging = (async (_input: string | URL, init?: RequestInit) => {
      await new Promise<never>((_resolve, reject) => {
        // Behave like real fetch: reject when the signal aborts.
        init?.signal?.addEventListener("abort", () => {
          const e = new Error("The operation was aborted");
          e.name = "AbortError";
          reject(e);
        });
      });
      return jsonResponse({});
    }) as unknown as ReturnType<typeof mockFetch>;
    const t = new Transport({ baseUrl: "https://example.com", source: "example", fetch: hanging, timeoutMs: 20 });
    const err = await t.request({ path: "/x" }).catch((e) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as Error).message).toMatch(/timed out/i);
    void hanging;
  });

  it("uses the injected fetch and never touches the network in tests", async () => {
    const spy = vi.fn(async () => jsonResponse({ hello: "world" }));
    const t = new Transport({ baseUrl: "https://example.com", source: "example", fetch: spy });
    const { data } = await t.request<{ hello: string }>({ path: "/x" });
    expect(data).toEqual({ hello: "world" });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
