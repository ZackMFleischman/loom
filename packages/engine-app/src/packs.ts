/**
 * Pack-aware namespacing for the engine barrels (scenes / effects).
 *
 * A module pack lives under packs/<name>/ (cloned/symlinked by `pnpm pack:add`,
 * registered in content/state/packs.json). Its scenes and modules surface in the
 * engine exactly like local content, but NAMESPACED:
 *
 *   - local content keeps its BARE name      ("aurora")
 *   - pack content surfaces as "<pack>/<name>" ("hippoPack/aurora")
 *
 * PRECEDENCE — local-wins, deterministic (the downstream marketplace relies on
 * it): on a bare-name collision the LOCAL item wins; a pack's same-named item is
 * reachable ONLY via its namespaced id. Because pack ids are always prefixed and
 * local ids never are, the merged map can't actually collide — `mergeNamespaced`
 * just makes the rule explicit and order-independent.
 *
 * This mirrors scripts/lib/packs.mjs (the Node/catalog side) — keep them in sync.
 */

/** "packs/<name>/…" → "<name>", else null (not a pack path). */
export function packNameFromPath(filePath: string): string | null {
  return /\/packs\/([^/]+)\//.exec(filePath)?.[1] ?? null;
}

/**
 * Merge local + pack items into one id→value map applying the namespacing &
 * precedence rule. `local` is keyed by bare id; `pack` is a list of
 * {pack, id, value}. Local entries are written last so a (defensive) bare-name
 * clash always resolves local-wins.
 */
export function mergeNamespaced<T>(
  local: Map<string, T>,
  packItems: Array<{ pack: string; id: string; value: T }>,
): Map<string, T> {
  const map = new Map<string, T>();
  for (const it of packItems) map.set(`${it.pack}/${it.id}`, it.value);
  for (const [id, value] of local) map.set(id, value); // local wins
  return map;
}
