import type { ChainStepInput, SceneDef, Stage } from "@loom/runtime";
import { buildProjectInstance, ProjectStore, type ProjectData, type ProjectInstance } from "./projects";
import type { Entry, SessionStore } from "./session";
import { StateKey, type StateClient } from "./state";

/**
 * Session restore — the working set survives a refresh/restart.
 *
 * LOOM restarts often (an engine code change forces a full reload). Without
 * this the audience-facing boot scene comes back but everything the human built
 * in-session is gone: the sandbox tiles, per-instance modulators and chains, and
 * which instance was live. `save_project` captures all of that on demand;
 * SessionSnapshot does it AUTOMATICALLY — every structural edit debounce-writes
 * the same serialized instance set to content/state/session.json, and boot
 * rebuilds it and routes the live output back where it was.
 *
 * It reuses ProjectStore's serialize/build verbatim (same fidelity as a saved
 * project) and only adds the staged pointer plus the boot-time restore that —
 * uniquely, since there is no audience at boot — moves the LIVE pointer.
 */

/** The reserved snapshot name; the file is content/state/session.json. */
const SNAPSHOT_NAME = "__session__";

export interface SessionData extends ProjectData {
  /** The staged candidate at snapshot time (null when none / mid-commit). */
  staged: string | null;
}

export interface RestoreOutcome {
  /** Instances rebuilt under their original id (boot excluded — it already exists). */
  created: string[];
  /** Entries that could not be restored (scene gone, build threw, id clash). */
  skipped: Array<{ id: string; scene: string; reason: string }>;
  live: string | null;
  staged: string | null;
}

export interface SessionSnapshotDeps {
  session: SessionStore;
  stage: Stage;
  /** Current scene library (a getter so it tracks `./scenes` HMR). */
  scenes: () => Map<string, SceneDef>;
  /** Persistence client — `?state=off` (validators) disables load AND save. */
  state: StateClient;
}

export class SessionSnapshot {
  private readonly store: ProjectStore;

  constructor(private readonly d: SessionSnapshotDeps) {
    this.store = new ProjectStore(d.session, d.stage, d.scenes);
  }

  /**
   * Debounced autosave of the full working set + slot pointers. Called after
   * every snapshot-affecting command (the StateClient coalesces a burst of
   * edits into one write); a no-op under `?state=off`.
   */
  mark(): void {
    this.d.state.save(StateKey.session, () => this.serialize());
  }

  /**
   * Capture the working set. Fade-aware: a commit crossfade flips the live
   * pointer a frame later, so while one is in flight we record its TARGET as
   * live — a refresh mid-commit then lands on the committed scene, not the old
   * one. live/staged are pinned to ids that actually made it into the snapshot.
   */
  serialize(): SessionData {
    const base = this.store.serialize(SNAPSHOT_NAME, new Date().toISOString());
    const { stage } = this.d;
    const live = stage.fading ? stage.staged : stage.live;
    const staged = stage.fading ? null : stage.staged;
    const exists = (id: string | null): id is string =>
      id != null && base.instances.some((i) => i.id === id);
    return { ...base, live: exists(live) ? live : null, staged: exists(staged) ? staged : null };
  }

  /** Read the persisted snapshot, or null when absent/disabled/malformed. */
  async load(): Promise<SessionData | null> {
    const raw = await this.d.state.load(StateKey.session);
    if (raw == null || typeof raw !== "object" || !Array.isArray((raw as SessionData).instances)) {
      return null;
    }
    return raw as SessionData;
  }

  /**
   * Rebuild last session's working set into a freshly booted engine and route
   * the live output back where it was. The boot instance is already built from
   * live.scene.ts — its saved chain/modulators are reapplied onto it; every
   * other instance is rebuilt under its original id. Then (boot/recovery only,
   * no audience yet) the live pointer is hard-moved to whatever was live.
   *
   * Resilient by construction: a scene that no longer builds is skipped, an id
   * clash is skipped, and if the live target can't be restored the boot scene
   * keeps the output — never go black.
   */
  restore(data: SessionData, bootId: string): RestoreOutcome {
    const { session, stage } = this.d;
    const created: string[] = [];
    const skipped: RestoreOutcome["skipped"] = [];
    for (const inst of data.instances) {
      if (inst.id === bootId) {
        this.restoreBoot(session.get(bootId), inst);
        continue;
      }
      const def = this.d.scenes().get(inst.scene);
      if (!def) {
        skipped.push({ id: inst.id, scene: inst.scene, reason: `unknown scene "${inst.scene}"` });
        continue;
      }
      if (session.get(inst.id)) {
        skipped.push({ id: inst.id, scene: inst.scene, reason: `id "${inst.id}" already exists` });
        continue;
      }
      try {
        buildProjectInstance(session, def, inst, inst.id);
        created.push(inst.id);
      } catch (err) {
        skipped.push({ id: inst.id, scene: inst.scene, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    // Route live where it was. Hard-set is legal here only because boot has no
    // audience; a missing/failed target leaves the boot scene live (never black).
    const target = data.live;
    if (target != null && target !== bootId && session.get(target)) {
      stage.restoreLive(target);
    }
    const stagedTarget = data.staged;
    if (stagedTarget != null && stagedTarget !== stage.live && session.get(stagedTarget)) {
      try {
        stage.stage(stagedTarget);
      } catch {
        // staged === live after restore, or otherwise unstageable — leave it.
      }
    }
    return { created, skipped, live: stage.live, staged: stage.staged };
  }

  /**
   * Reapply the boot instance's saved chain + modulators onto the already-built
   * boot entry (live.scene.ts owns its scene/values; the chain and modulators
   * are session state that lives nowhere else). Each step is best-effort: a
   * chain step that no longer builds is rejected (NFR-5 keeps the scene chain),
   * a modulator whose param is gone is skipped.
   */
  private restoreBoot(entry: Entry | undefined, inst: ProjectInstance): void {
    if (!entry) return;
    const { session } = this.d;
    try {
      session.setChain(entry.id, inst.chain as ChainStepInput[]);
    } catch {
      // a step failed to build — keep the scene-declared chain
    }
    for (const [node, steps] of Object.entries(inst.nodeChains ?? {})) {
      try {
        session.setChain(entry.id, steps as ChainStepInput[], node);
      } catch {
        // the node is gone in the current scene code — skip its chain
      }
    }
    // Values land AFTER the chain rebuilds (each rebuild reapplies only the
    // per-scene tuned values; these are this instance's own overrides).
    for (const [path, v] of Object.entries(inst.values ?? {})) {
      try {
        entry.instance.manifest.get(path)?.set(v);
      } catch {
        // a persisted value that no longer fits its param — keep the default
      }
    }
    for (const m of inst.modulators ?? []) {
      try {
        entry.modulators.attach(entry.instance.manifest, m.path, m.spec);
        if (m.enabled === false) entry.modulators.setEnabled(m.path, false);
      } catch {
        // the param is gone — drop the modulator
      }
    }
  }
}
