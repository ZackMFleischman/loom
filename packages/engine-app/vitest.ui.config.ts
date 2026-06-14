import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Engine-app "ui" project: React hook/component tests that need a DOM. happy-dom
 * (a repo dep) hosts `renderHook` over the `useSyncExternalStore` hooks. The DOM
 * env + testing-library are devDependencies of THIS package only and never enter
 * the production Vite build (NFR-3) — `vite build` uses vite.config.ts, not this.
 * Referenced by both vitest.config.ts and the root coverage config.
 */
const alias = {
  "@loom/runtime": fileURLToPath(new URL("../runtime/src/index.ts", import.meta.url)),
  "@loom/sidecar/protocol": fileURLToPath(new URL("../sidecar/src/protocol.ts", import.meta.url)),
};

export default defineConfig({
  resolve: { alias },
  test: {
    name: "engine-app:ui",
    environment: "happy-dom",
    include: ["test/ui/**/*.test.tsx", "test/ui/**/*.test.ts"],
    setupFiles: ["test/ui/setup.ts"],
  },
});
