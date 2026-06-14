import { isFxPath, PALETTE_SOURCE_PATH } from "@loom/runtime";
import type { ParamDesc } from "../engine-link";

/** A manifest entry: [path, descriptor]. */
export type ParamEntry = [string, ParamDesc];

/** The bits of a layer node the param panel groups on. */
export interface NodeInfo {
  id: string;
  parent: string | null;
}

export interface ParamGroups {
  /** Dotless params (and palette.source) shown flat on top. */
  flat: ParamEntry[];
  /** Dotted params bucketed by their head segment ("logo.tiltX" → group "logo"). */
  groups: Map<string, ParamEntry[]>;
  nodeIds: Set<string>;
  parentOf: Map<string, string | null>;
  /** How many params are flagged `hidden` (e.g. auto input trims) — drives the
   *  panel's "advanced" toggle. The count reflects the full manifest, so the
   *  toggle stays available whether or not hidden params are currently shown. */
  hiddenCount: number;
}

/**
 * Bucket a manifest into the param panel's flat params + dotted groups (pure;
 * the component owns rendering and persistence). Chain knobs (`fx.*` and a
 * node's `<node>.fx.*`) are dropped — they render inside the FX CHAIN section.
 * palette.source stays flat (the scene's palette switch is too load-bearing to
 * bury in a collapsed accordion). Every layer node gets a section even if the
 * manifest snapshot lags the session's node list.
 *
 * Params flagged `hidden` (e.g. the auto-added per-instance input trim
 * `input.<name>.amount`) are dropped unless `includeHidden` is set — the panel's
 * "advanced" toggle. They are always counted into `hiddenCount` so the toggle
 * stays available even while they're hidden.
 */
export function groupParams(
  manifest: Record<string, ParamDesc> | undefined,
  nodes: NodeInfo[],
  includeHidden = false,
): ParamGroups {
  const nodeIds = new Set(nodes.map((n) => n.id));
  const parentOf = new Map<string, string | null>(nodes.map((n) => [n.id, n.parent]));
  const flat: ParamEntry[] = [];
  const groups = new Map<string, ParamEntry[]>();
  let hiddenCount = 0;
  for (const [path, p] of Object.entries(manifest ?? {})) {
    if (isFxPath(path)) continue; // chain knobs render inside the FX CHAIN section
    if (p.channelOf != null) continue; // color channels render inside their color widget (R7.4)
    if (p.hidden) {
      hiddenCount++;
      if (!includeHidden) continue; // revealed only by the panel's advanced toggle
    }
    const dot = path.indexOf(".");
    if (dot < 0 || path === PALETTE_SOURCE_PATH) {
      flat.push([path, p]);
    } else {
      const g = path.slice(0, dot);
      if (nodeIds.has(g) && isFxPath(path.slice(dot + 1))) continue; // node chain knobs
      let bucket = groups.get(g);
      if (!bucket) {
        bucket = [];
        groups.set(g, bucket);
      }
      bucket.push([path, p]);
    }
  }
  for (const id of nodeIds) if (!groups.has(id)) groups.set(id, []);
  return { flat, groups, nodeIds, parentOf, hiddenCount };
}

/**
 * Split a group's entries into its layer-rig params (`<group>.layer.*`) and the
 * rest. Rig params fold into a nested "transform" sub-group so the section stays
 * scannable; with no rig params the group renders flat (rest = all entries).
 */
export function splitRig(entries: ParamEntry[], group: string): { rig: ParamEntry[]; rest: ParamEntry[] } {
  const isRig = ([path]: ParamEntry) => path.slice(group.length + 1).startsWith("layer.");
  const rig = entries.filter(isRig);
  const rest = rig.length > 0 ? entries.filter((e) => !isRig(e)) : entries;
  return { rig, rest };
}
