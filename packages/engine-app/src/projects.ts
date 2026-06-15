import type { ChainStep, ChainStepInput, SceneDef, Stage } from "@loom/runtime";
import { hasFxSegment } from "@loom/runtime";
import type { Entry, SessionStore } from "./session";

/**
 * Projects — set lists. A project is the serialized instance set: per instance
 * the scene, tuned values, modulators, root chain and per-node chains, in tile
 * order, plus which one was live. Saved as plain JSON to
 * content/state/projects/<name>.json through the loom:state middleware, so set
 * lists live in git like all tuned state (NFR-4).
 *
 * Loading is AUDIENCE-SAFE: every project instance builds into a sandbox and
 * the Stage is never touched — current output keeps playing until a commit
 * from the newly loaded set (the engine culls the replaced instances after
 * that commit's fade lands; see main.ts).
 */

export interface ProjectInstance {
  id: string;
  scene: string;
  values: Record<string, number | boolean | string>;
  modulators: Array<{ path: string; spec: Record<string, unknown>; enabled?: boolean }>;
  chain: Array<{ id: string; effect: string; params: Record<string, number | boolean> }>;
  nodeChains: Record<string, Array<{ id: string; effect: string; params: Record<string, number | boolean> }>>;
}

export interface ProjectData {
  name: string;
  savedAt: string;
  /** The id that was live at save time (informational — load never commits). */
  live: string | null;
  /** In tile order. */
  instances: ProjectInstance[];
}

export interface LoadOutcome {
  /** Created instance ids, in project tile order. */
  created: string[];
  /** Project entries that could not build (scene gone, build threw). */
  skipped: Array<{ id: string; scene: string; reason: string }>;
  /** Pre-load instance ids to cull after a commit from the loaded set. */
  replaced: string[];
}

const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;

export function assertProjectName(name: string): void {
  if (!PROJECT_NAME_RE.test(name) || name.length > 60) {
    throw new Error(`bad project name "${name}" — letters, digits, - and _ (start alphanumeric)`);
  }
}

/** Capture one entry into its serialized form (live knob values included). */
function serializeEntry(e: Entry): ProjectInstance {
  // Pull live chain-knob values into the step data first — saved knobs reflect
  // what's on screen, same rule as save_chain.
  e.chain.captureValues(e.instance.manifest);
  for (const host of e.nodeChains.values()) host.captureValues(e.instance.manifest);

  const steps = (list: ChainStep[]) => list.map((s) => ({ id: s.id, effect: s.effect, params: { ...s.params } }));
  const nodeChains: ProjectInstance["nodeChains"] = {};
  for (const [node, host] of e.nodeChains) {
    if (host.steps.length > 0) nodeChains[node] = steps(host.steps);
  }
  // Chain knob values live in the chain data — keep them out of values, same
  // rule as per-scene persistence.
  const values = e.instance.manifest.values();
  for (const k of Object.keys(values)) {
    if (hasFxSegment(k)) delete values[k];
  }
  return {
    id: e.id,
    scene: e.sceneName,
    values,
    modulators: e.modulators.list().map((m) => ({
      path: m.path,
      spec: m.spec as unknown as Record<string, unknown>,
      enabled: m.enabled,
    })),
    chain: steps(e.chain.steps),
    nodeChains,
  };
}

/**
 * Build one serialized instance into the session under `id` and re-attach its
 * saved modulators (a modulator that no longer fits its param is skipped — a
 * restore is never fatal). Shared by project load and session restore. A failed
 * build throws out to the caller, which records it as a skip.
 */
export function buildProjectInstance(
  session: SessionStore,
  def: SceneDef,
  inst: ProjectInstance,
  id: string,
): Entry {
  const entry = session.create(def, id, {
    chain: inst.chain as ChainStepInput[],
    nodeChains: inst.nodeChains as Record<string, ChainStepInput[]>,
    values: inst.values,
  });
  for (const m of inst.modulators ?? []) {
    try {
      entry.modulators.attach(entry.instance.manifest, m.path, m.spec);
      if (m.enabled === false) entry.modulators.setEnabled(m.path, false);
    } catch {
      // a modulator that no longer fits its param — skip it, keep loading
    }
  }
  return entry;
}

export class ProjectStore {
  constructor(
    private readonly session: SessionStore,
    private readonly stage: Stage,
    private readonly getScenes: () => Map<string, SceneDef>,
  ) {}

  /** Serialize the current instance set (pinned infra instances excluded). */
  serialize(name: string, savedAt: string, tileOrder?: string[]): ProjectData {
    const entries = [...this.session.entries.values()].filter((e) => e.pinned == null);
    const pos = (id: string) => {
      const i = (tileOrder ?? []).indexOf(id);
      return i < 0 ? (tileOrder ?? []).length : i;
    };
    entries.sort((a, b) => pos(a.id) - pos(b.id));
    return {
      name,
      savedAt,
      live: this.stage.live != null && entries.some((e) => e.id === this.stage.live) ? this.stage.live : null,
      instances: entries.map(serializeEntry),
    };
  }

  /**
   * Build every project instance into a sandbox. NEVER touches the Stage.
   * Ids are kept when free, suffixed when taken (loading twice is legal).
   * A failed build skips that entry — loading is free, never fatal.
   */
  load(data: ProjectData): LoadOutcome {
    const replaced = [...this.session.entries.values()]
      .filter((e) => e.pinned == null)
      .map((e) => e.id);
    const created: string[] = [];
    const skipped: LoadOutcome["skipped"] = [];
    for (const inst of data.instances) {
      const def = this.getScenes().get(inst.scene);
      if (!def) {
        skipped.push({ id: inst.id, scene: inst.scene, reason: `unknown scene "${inst.scene}"` });
        continue;
      }
      let id = inst.id;
      for (let n = 2; this.session.entries.has(id); n++) id = `${inst.id}~${n}`;
      try {
        buildProjectInstance(this.session, def, inst, id);
        created.push(id);
      } catch (err) {
        skipped.push({ id: inst.id, scene: inst.scene, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    return { created, skipped, replaced };
  }
}
