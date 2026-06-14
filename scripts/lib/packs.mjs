// Shared pack-discovery helpers (Node ESM, no `three` / no browser deps).
//
// A "pack" is a third-party folder mirroring content/'s layout — modules/ and
// scenes/ — registered in content/state/packs.json and checked out (clone or
// symlink) under the gitignored packs/ directory. This module is the single
// source of truth for:
//   - reading/writing the packs.json registry,
//   - enumerating installed packs on disk,
//   - the namespacing + precedence rule (local content beats a pack on a
//     bare-name collision; pack content is reached as "<pack>/<name>").
//
// It is consumed by scripts/build-catalog.mjs (catalog generation) and
// scripts/pack.mjs (pack:add / pack:update). The engine app (Vite/browser)
// mirrors the same rule in packages/engine-app/src/packs.ts — keep them in sync.
import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
export const packsDir = path.join(repoRoot, "packs");
export const registryPath = path.join(repoRoot, "content/state/packs.json");

/** Pack names are letters-first, alnum + hyphen — same shape we namespace with. */
export const PACK_NAME_RE = /^[a-z][a-zA-Z0-9-]*$/;

/**
 * Read content/state/packs.json. Shape:
 *   { "packs": [ { name, source, pin?, loomApi? }, … ] }
 * Missing/corrupt file → empty registry (nothing installed), never throws.
 */
export function readRegistry() {
  try {
    const raw = JSON.parse(readFileSync(registryPath, "utf8"));
    const packs = Array.isArray(raw?.packs) ? raw.packs : [];
    return { packs };
  } catch {
    return { packs: [] };
  }
}

export function writeRegistry(reg) {
  const sorted = [...reg.packs].sort((a, b) => a.name.localeCompare(b.name));
  writeFileSync(registryPath, `${JSON.stringify({ packs: sorted }, null, 2)}\n`);
}

/** Read a pack's loom-pack.json manifest, or null if absent/corrupt. */
export function readPackManifest(packPath) {
  try {
    return JSON.parse(readFileSync(path.join(packPath, "loom-pack.json"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Every installed pack that is BOTH registered (packs.json) AND present on disk
 * (packs/<name>/ exists). The registry is the source of truth for which packs
 * "should" be there; the on-disk check keeps a half-installed/removed pack from
 * breaking discovery. Returns [{ name, dir, source, pin, loomApi, manifest }].
 */
export function discoverPacks() {
  const reg = readRegistry();
  const out = [];
  for (const entry of reg.packs) {
    if (!entry?.name || !PACK_NAME_RE.test(entry.name)) {
      // A hand-edited/typo'd name would otherwise vanish from the catalog with
      // no trace — surface it so the author can fix packs.json.
      console.warn(
        `[loom] packs.json: skipping entry with invalid name ${JSON.stringify(entry?.name)} ` +
          `(must be letters-first, [a-z][a-zA-Z0-9-]*).`,
      );
      continue;
    }
    const dir = path.join(packsDir, entry.name);
    if (!existsSync(dir)) continue; // registered but not checked out yet
    out.push({
      name: entry.name,
      dir,
      source: entry.source ?? "",
      pin: entry.pin ?? null,
      loomApi: entry.loomApi ?? null,
      manifest: readPackManifest(dir),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The namespacing/precedence rule, in one place.
 *
 * - Local content (content/) keeps its BARE name ("aurora").
 * - Pack content surfaces as "<pack>/<name>" ("hippoPack/aurora").
 * - PRECEDENCE on a bare-name collision is LOCAL-WINS: a bare lookup ("aurora")
 *   always resolves to local content; a pack's same-named item is reachable ONLY
 *   via its namespaced id. This is deterministic and stable — the downstream
 *   marketplace relies on it.
 *
 * Because pack ids are always prefixed and local ids never are, the two
 * namespaces can't actually collide in the merged map; this helper just makes
 * the rule explicit for callers building that map.
 */
export function namespacedId(packName, bareName) {
  return `${packName}/${bareName}`;
}

/**
 * Files under packs/<name>/<sub>/ matching a filter, returned relative to dir
 * with their owning pack — used by the catalog generator. `sub` is e.g.
 * "modules" or "scenes". Recurses (modules live in control/sources/effects/geo).
 */
export function listPackFiles(packDir, sub, filter) {
  const root = path.join(packDir, sub);
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && filter(d.name))
    .map((d) => path.join(d.parentPath, d.name))
    .sort();
}
