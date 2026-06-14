import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
  resolve: {
    // Mirrors vite.config.ts — tests that exercise EngineApi import the
    // protocol's VALUE schemas, so the alias must resolve at runtime too.
    alias: {
      "@loom/runtime": fileURLToPath(new URL("../runtime/src/index.ts", import.meta.url)),
      "@loom/sidecar/protocol": fileURLToPath(new URL("../sidecar/src/protocol.ts", import.meta.url)),
    },
  },
});
