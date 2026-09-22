import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Spec §2 / Appendix A: EXCLUDED sources must not ship in any bundle.
 * This test scans the SDK source for the excluded hosts/endpoints and fails
 * if any of them are referenced (even in comments).
 */
const SRC = new URL("../src", import.meta.url).pathname;

const EXCLUDED: Array<{ name: string; patterns: RegExp[] }> = [
  {
    name: "Coinbase Exchange (Market Data ToS forbids redistribution)",
    patterns: [/api\.exchange\.coinbase\.com/i, /api\.coinbase\.com\/v2\/exchange/i],
  },
  {
    name: "Solscan (no verifiable free tier — paid-only)",
    patterns: [/pro-api\.solscan\.io/i, /public-api\.solscan\.io/i],
  },
  {
    name: "Yahoo Finance (no official API; ToS prohibits automated access)",
    patterns: [/query1\.finance\.yahoo\.com/i, /query2\.finance\.yahoo\.com/i],
  },
  {
    name: "ESPN unofficial API (unlicensed media data)",
    patterns: [/site\.api\.espn\.com/i, /site\.web\.api\.espn\.com/i],
  },
];

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (full.endsWith(".ts")) yield full;
  }
}

describe("EXCLUDED sources are not implemented", () => {
  it("no excluded host appears anywhere in src/", () => {
    const violations: string[] = [];
    for (const file of walk(SRC)) {
      const content = readFileSync(file, "utf8");
      for (const { name, patterns } of EXCLUDED) {
        for (const p of patterns) {
          if (p.test(content)) violations.push(`${name} referenced in ${file} (pattern ${p})`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("no bundled API keys exist in src/ (GATED keys always come from the end user)", () => {
    const suspicious = [/api[_-]?key["']?\s*[:=]\s*["'][A-Za-z0-9]{16,}["']/i];
    const violations: string[] = [];
    for (const file of walk(SRC)) {
      const content = readFileSync(file, "utf8");
      for (const p of suspicious) {
        const m = p.exec(content);
        if (m && !/user|their own|GATED|example|test/i.test(content.slice(Math.max(0, m.index - 80), m.index))) {
          violations.push(`${file}: possible bundled key`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
