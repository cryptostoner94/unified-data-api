/**
 * Test helpers: mocked fetch, canned responses, request capture.
 * NO network calls in tests — every test injects a mocked fetch.
 */
import type { FetchFn } from "../src/core/transport.js";

export function jsonResponse(data: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(data), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

export function textResponse(text: string, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(text, {
    status: init.status ?? 200,
    headers: { "Content-Type": "text/plain", ...(init.headers ?? {}) },
  });
}

export interface MockRoute {
  match: (url: string, init?: RequestInit) => boolean;
  respond: (url: string, init?: RequestInit) => Response | Promise<Response>;
}

export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  bodyText?: string;
}

export interface MockFetch extends FetchFn {
  captured: CapturedRequest[];
  callCount: () => number;
}

/** Route-based mock fetch. Unmatched URLs → 404 JSON (never real network). */
export function mockFetch(routes: MockRoute[]): MockFetch {
  const captured: CapturedRequest[] = [];
  const fn = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    const h = init?.headers as Record<string, string> | undefined;
    if (h) for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = String(v);
    let bodyText: string | undefined;
    if (typeof init?.body === "string") bodyText = init.body;
    captured.push({ url, method: (init?.method ?? "GET").toUpperCase(), headers, bodyText });
    for (const route of routes) {
      if (route.match(url, init)) return route.respond(url, init);
    }
    return jsonResponse({ error: `no mock route for ${url}` }, { status: 404 });
  }) as MockFetch;
  fn.captured = captured;
  fn.callCount = () => captured.length;
  return fn;
}

/** Match when the URL contains `substr` (and optionally the method matches). */
export function route(substr: string, respond: MockRoute["respond"], method?: string): MockRoute {
  return {
    match: (url, init) => url.includes(substr) && (!method || (init?.method ?? "GET").toUpperCase() === method),
    respond,
  };
}

/** Sleep helper for async timing tests. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
