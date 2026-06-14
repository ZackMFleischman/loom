import { defineConfig } from "vitest/config";

/**
 * Tooling tests: pure-logic units in scripts/ (e.g. the affected-shots PR-diff
 * resolver) that run plain in Node — no DOM, no runtime alias. `pnpm test`
 * runs this after the package and content suites.
 */
export default defineConfig({
  test: {
    include: ["scripts/**/*.test.mjs"],
    environment: "node",
  },
});
