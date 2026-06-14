import { defineConfig } from "vitest/config";
import { coverage } from "./vitest.coverage.shared";

/**
 * The coverage gate over `packages/` (FR-1..FR-3). Runs the three package vitest
 * suites under one command via vitest "projects", each keeping its own
 * environment + resolve aliases (referenced by their existing config files), and
 * applies one shared coverage policy on top.
 *
 * Used by `pnpm test:coverage` (and CI later) — NOT by the fast `pnpm test`, so
 * local dev and the content-creation loop stay untouched (NFR-1, NFR-2). The
 * coverage `include`/`exclude` make this gate physically unable to measure
 * `content/` (FR-2) — see vitest.coverage.shared.ts.
 */
export default defineConfig({
  test: {
    projects: [
      "packages/runtime/vitest.config.ts",
      "packages/sidecar/vitest.config.ts",
      // Engine-app's two suites referenced as leaf configs (not its project
      // wrapper) so each keeps its own environment under coverage.
      "packages/engine-app/vitest.node.config.ts",
      "packages/engine-app/vitest.ui.config.ts",
    ],
    coverage,
  },
});
