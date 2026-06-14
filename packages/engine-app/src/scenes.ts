import type { SceneDef } from "@loom/runtime";
import { mergeNamespaced, packNameFromPath } from "./packs";

/**
 * Eagerly globs every scene so (a) create_instance can build any of them by
 * name and (b) editing ANY scene file bubbles through this barrel to
 * main.ts's hot-accept — Vite still withholds whole updates on syntax
 * errors, so never-go-black semantics are unchanged at N instances.
 *
 * Module packs (packs/<name>/scenes/*.scene.ts) are globbed alongside local
 * content and NAMESPACED as "<pack>/<scene>" (see ./packs); local content keeps
 * its bare name and wins any bare-name collision. The glob pattern is static
 * (Vite requirement) — every installed pack matches automatically.
 */
const globbed = import.meta.glob("../../../content/scenes/*.scene.ts", { eager: true });
const packGlobbed = import.meta.glob("../../../packs/*/scenes/*.scene.ts", { eager: true });

export function getScenes(): Map<string, SceneDef> {
  const local = new Map<string, SceneDef>();
  for (const [path, mod] of Object.entries(globbed)) {
    const file = path.split("/").pop()!.replace(".scene.ts", "");
    // live.scene.ts is a re-export pointer (the boot scene), not a scene of its own.
    if (file === "live") continue;
    const def = (mod as { default?: SceneDef }).default;
    if (def?.name) local.set(def.name, def);
  }

  const packItems: Array<{ pack: string; id: string; value: SceneDef }> = [];
  for (const [path, mod] of Object.entries(packGlobbed)) {
    const file = path.split("/").pop()!.replace(".scene.ts", "");
    if (file === "live" || file === "panic") continue;
    const pack = packNameFromPath(path);
    const def = (mod as { default?: SceneDef }).default;
    if (pack && def?.name) packItems.push({ pack, id: def.name, value: def });
  }

  return mergeNamespaced(local, packItems);
}
