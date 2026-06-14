import type { SceneDef, Stage } from "@loom/runtime";
import { assertProjectName, ProjectStore, type ProjectData } from "./projects";
import type { SessionStore } from "./session";
import { projectKey, repoStatePath, StateDir } from "./state";

export interface ProjectsControllerDeps {
  session: SessionStore;
  stage: Stage;
  /** Current scene library (a getter so it tracks `./scenes` HMR). */
  scenes: () => Map<string, SceneDef>;
}

/**
 * main.ts-side glue over the tested ProjectStore (architecture refactor
 * Phase 3): the fetch/persist plumbing for set lists plus the deferred-cull
 * bookkeeping. The serialize/load logic itself stays in ProjectStore.
 *
 * Save/load are explicit user actions, so they work regardless of `?state=off`
 * (which only disables AMBIENT persistence). Loading is audience-safe — every
 * project instance builds into a sandbox and the Stage is never touched; the
 * pre-load instances keep running until a commit from the loaded set LANDS,
 * then `maybeCull` (driven from the frame loop) reaps them.
 */
export class ProjectsController {
  private readonly store: ProjectStore;
  private names: string[] = [];
  // Deferred cull: pre-load instances to reap once a commit from the loaded set
  // lands (fade complete). Loading alone never changes what the audience sees.
  private pendingCull: { loaded: Set<string>; stale: Set<string> } | null = null;

  constructor(private readonly d: ProjectsControllerDeps) {
    this.store = new ProjectStore(d.session, d.stage, d.scenes);
  }

  /** Refresh the saved-project names from disk (a convenience, never a blocker). */
  async list(): Promise<string[]> {
    try {
      const res = await fetch(`/loom/state-list/${StateDir.projects}`);
      if (res.ok) this.names = (await res.json()) as string[];
    } catch {
      // listing is a convenience, never a blocker
    }
    return this.names;
  }

  /** Last known names (sync, for the session snapshot). */
  cached(): string[] {
    return this.names;
  }

  async save(name: string, tileOrder?: string[]): Promise<{ saved: string; path: string; instances: number }> {
    assertProjectName(name);
    const data = this.store.serialize(name, new Date().toISOString(), tileOrder);
    if (data.instances.length === 0) throw new Error("nothing to save — no instances");
    const res = await fetch(`/loom/state/${StateDir.projects}/${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data, null, 2),
    });
    if (!res.ok) throw new Error(`project save failed (${res.status})`);
    await this.list();
    return { saved: name, path: repoStatePath(projectKey(name)), instances: data.instances.length };
  }

  async load(name: string) {
    assertProjectName(name);
    const res = await fetch(`/loom/state/${StateDir.projects}/${encodeURIComponent(name)}`);
    if (!res.ok) {
      throw new Error(`unknown project "${name}" — saved projects: ${this.names.join(", ") || "(none)"}`);
    }
    const data = (await res.json()) as ProjectData;
    const out = this.store.load(data);
    this.pendingCull = { loaded: new Set(out.created), stale: new Set(out.replaced) };
    return out;
  }

  /**
   * Frame-loop hook: once a commit from the loaded set has landed (live, fade
   * done), reap the replaced pre-load instances. Called before the render so a
   * culled instance is never referenced by this frame's directive (it can't be:
   * it isn't live). No-op until the loaded instance is live and not fading.
   */
  maybeCull(): void {
    const { stage, session } = this.d;
    const pc = this.pendingCull;
    if (pc == null || stage.fading || stage.live == null || !pc.loaded.has(stage.live)) return;
    let culled = 0;
    for (const id of pc.stale) {
      const e = session.get(id);
      if (!e || e.id === stage.live || e.pinned != null) continue;
      stage.onInstanceDestroyed(id);
      session.destroy(id);
      culled++;
    }
    if (culled > 0) console.info(`[loom] project set committed — culled ${culled} replaced instance(s)`);
    this.pendingCull = null;
  }
}
