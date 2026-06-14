import { defineConfig } from "vitest/config";

/**
 * Engine-app runs TWO vitest projects under one `pnpm --filter @loom/engine-app
 * test` (FR-6): the existing node logic suite and a DOM (happy-dom) React suite,
 * each with its own environment + setup. Both are defined as standalone leaf
 * configs so the root coverage config can reference them directly too.
 */
export default defineConfig({
  test: {
    projects: ["./vitest.node.config.ts", "./vitest.ui.config.ts"],
  },
});
