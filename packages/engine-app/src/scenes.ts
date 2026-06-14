import type { SceneDef } from "@loom/runtime";

/**
 * Eagerly globs every scene so (a) create_instance can build any of them by
 * name and (b) editing ANY scene file bubbles through this barrel to
 * main.ts's hot-accept — Vite still withholds whole updates on syntax
 * errors, so never-go-black semantics are unchanged at N instances.
 */
const globbed = import.meta.glob("../../../content/scenes/*.scene.ts", { eager: true });

export function getScenes(): Map<string, SceneDef> {
  const map = new Map<string, SceneDef>();
  for (const [path, mod] of Object.entries(globbed)) {
    const file = path.split("/").pop()!.replace(".scene.ts", "");
    // live.scene.ts is a re-export pointer (the boot scene), not a scene of its own.
    if (file === "live") continue;
    const def = (mod as { default?: SceneDef }).default;
    if (def?.name) map.set(def.name, def);
  }
  return map;
}
