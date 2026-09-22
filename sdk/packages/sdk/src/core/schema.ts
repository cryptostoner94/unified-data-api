/**
 * Runtime response-shape guards (§3.6 "schema-drift detection").
 *
 * Every bundle validates the upstream JSON it normalizes. When a provider
 * changes their schema, the guard throws UpstreamSchemaDrift instead of
 * producing garbage — and the failure is attributable to a shape change.
 */
import { UpstreamSchemaDrift } from "./errors.js";

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isArray(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

/** Guard a whole payload; wraps any failure as UpstreamSchemaDrift. */
export function guardShape<T>(name: string, value: unknown, fn: (v: unknown) => T, source?: string): T {
  try {
    return fn(value);
  } catch (err) {
    if (err instanceof UpstreamSchemaDrift) throw err;
    throw new UpstreamSchemaDrift(
      `Upstream response failed shape guard "${name}": ${err instanceof Error ? err.message : String(err)}`,
      name,
      { source, cause: err },
    );
  }
}

/** Internal: throw a plain Error describing the shape violation. */
function fail(what: string, key?: string): never {
  throw new Error(key ? `expected ${what} at "${key}"` : `expected ${what}`);
}

export function expectRecord(v: unknown, key?: string): Record<string, unknown> {
  if (!isRecord(v)) fail("an object", key);
  return v as Record<string, unknown>;
}

export function expectArray(v: unknown, key?: string): unknown[] {
  if (!isArray(v)) fail("an array", key);
  return v;
}

export function reqString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string") fail("a string", key);
  return v as string;
}

export function reqNumber(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) fail("a finite number", key);
  return n;
}

/** Numbers that arrive as numeric strings (Binance, Kraken, EDGAR) are common. */
export function num(v: unknown, key?: string): number {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) fail("a finite number", key);
  return n;
}

export function optString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  if (v == null) return undefined;
  if (typeof v !== "string") fail("a string", key);
  return v;
}

export function optNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  if (v == null || v === "") return undefined;
  return num(v, key);
}

export function str(v: unknown, key?: string): string {
  if (typeof v !== "string") fail("a string", key);
  return v;
}

/** Best-effort ISO timestamp from the shapes upstreams actually send. */
export function isoDate(v: unknown, key?: string): string {
  if (typeof v === "number" && Number.isFinite(v)) {
    // Seconds vs milliseconds heuristic.
    const ms = v < 1e12 ? v * 1000 : v;
    return new Date(ms).toISOString();
  }
  if (typeof v === "string") {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return new Date(t).toISOString();
    // EDGAR dates like "2026-01-15" parse fine via Date.parse; fall through otherwise.
  }
  fail("a parseable date", key);
}
