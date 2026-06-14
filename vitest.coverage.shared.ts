import type { CoverageV8Options } from "vitest/node";

/**
 * Shared coverage policy for the `packages/` gate (FR-1, FR-2).
 *
 * The boundary is load-bearing: coverage is measured over `packages/*\/src/**`
 * ONLY. `content/` (agent territory — visuals built FAST) is NEVER measured and
 * NEVER thresholded, mirroring the packages-vs-content line in `biome.json`.
 * `include` does not list `content/**` at all, and it is excluded belt-and-braces
 * below — the gate is *physically incapable* of measuring it.
 *
 * Thresholds are a ratchet floor: they equal the current measured coverage so a
 * green build stays green the moment the gate turns on, and they only ever go up.
 * Re-measure with `pnpm test:coverage` and raise these as tests land.
 */
export const coverage: CoverageV8Options = {
  provider: "v8",
  enabled: true,
  reporter: ["text", "lcov"],
  // The whole point of the gate: engine code only, never content/.
  include: ["packages/*/src/**"],
  exclude: [
    "content/**",
    "**/test/**",
    "**/*.config.*",
    "**/*.d.ts",
    // Barrels / generated re-exports carry no testable logic.
    "**/index.ts",
    "packages/*/src/**/*.gen.ts",
  ],
  // Ratchet floor — measured 2026-06-13 via `pnpm test:coverage`:
  //   lines 50.31% · statements 49.35% · functions 40.16% · branches 36.21%
  // Thresholds are set just BELOW the measured numbers so a green build stays
  // green when the gate turns on; floored (not rounded up) to absorb tiny
  // run-to-run variance. Raise these deliberately as tests land — never lower.
  thresholds: {
    lines: 50,
    statements: 49,
    functions: 40,
    branches: 36,
  },
};
