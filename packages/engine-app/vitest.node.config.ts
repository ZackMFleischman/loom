import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Engine-app "node" project: the existing pure-logic suite (EngineLink,
 * render-service, MIDI, projects, …) — no DOM, faster without one. Referenced by
 * both vitest.config.ts (the `pnpm --filter` entry) and the root coverage config.
 */
const alias = {
  "@loom/runtime": fileURLToPath(new URL("../runtime/src/index.ts", import.meta.url)),
  "@loom/sidecar/protocol": fileURLToPath(new URL("../sidecar/src/protocol.ts", import.meta.url)),
};

export default defineConfig({
  resolve: { alias },
  test: {
    name: "engine-app:node",
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: ["test/ui/**"],
  },
});
