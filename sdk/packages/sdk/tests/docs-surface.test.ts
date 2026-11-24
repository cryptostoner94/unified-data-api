import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as sdkEntry from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");
const packageName = JSON.parse(
  readFileSync(resolve(here, "../package.json"), "utf8"),
).name as string;

function readDoc(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8").replace(/<[^>]+>/g, "");
}

function documentedImports(text: string): Array<{ symbols: string[]; specifier: string }> {
  return [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)].map((m) => ({
    symbols: m[1].split(",").map((s) => s.trim()).filter(Boolean),
    specifier: m[2],
  }));
}

describe("documented quickstart", () => {
  it.each(["README.md", "landing/index.html"])(
    "%s names the published package, its exported symbols, and the factory it documents",
    (doc) => {
      const text = readDoc(doc);
      const imports = documentedImports(text);
      expect(imports.length).toBeGreaterThan(0);
      for (const { symbols, specifier } of imports) {
        expect(specifier).toBe(packageName);
        expect(symbols.length).toBeGreaterThan(0);
        for (const symbol of symbols) expect(sdkEntry).toHaveProperty(symbol);
      }
      expect(typeof sdkEntry.UnifiedDataSDK.create).toBe("function");
      expect(text).toContain("UnifiedDataSDK.create(");
      expect(text).toContain("licenseBaseUrl");
    },
  );

  it("landing page installs the published package", () => {
    const text = readDoc("landing/index.html");
    expect(text).toContain(`npm install ${packageName}`);
  });
});
