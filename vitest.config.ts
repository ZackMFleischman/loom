import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The content/ test root: stdlib module tests run headlessly in Node with the
 * REAL BuildCtx and mock buses (see content/test/harness.ts). happy-dom is
 * needed because image-flavored modules construct a DOM Image via three's
 * TextureLoader at build time; no GPU or WebGPURenderer is ever created.
 * Package tests (runtime/sidecar/engine-app) keep their own vitest roots —
 * `pnpm test` runs those first, then this via `pnpm test:content`.
 */
export default defineConfig({
  test: {
    include: ["content/test/**/*.test.ts"],
    environment: "happy-dom",
    setupFiles: ["content/test/setup.ts"],
  },
  resolve: {
    // A locally-linked module pack lives under packs/<name>/ but symlinks
    // OUTSIDE the repo. Without this, Vite resolves a pack file to its real
    // out-of-tree path and can no longer find the host's `three`/`three/tsl`
    // from node_modules. Keeping the symlinked path makes bare specifiers
    // resolve up through the repo's node_modules like any local content file.
    preserveSymlinks: true,
    alias: {
      // Mirrors packages/engine-app/vite.config.ts — content/ sits outside
      // any package, so the runtime resolves through this alias.
      "@loom/runtime": fileURLToPath(new URL("./packages/runtime/src/index.ts", import.meta.url)),
      "@loom/sidecar/protocol": fileURLToPath(
        new URL("./packages/sidecar/src/protocol.ts", import.meta.url),
      ),
    },
  },
});
