import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 10000,
    // No network in tests: every test injects a mocked fetch.
  },
});
