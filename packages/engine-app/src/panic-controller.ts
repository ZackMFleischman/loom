import type { SceneDef } from "@loom/runtime";
import type { Entry, SessionStore } from "./session";

/** Id of the always-warm Panic Scene instance (FR-3). */
export const PANIC_ID = "panic";

/** What scene-panic cuts to + its build health, surfaced to the Console/__loom. */
export interface PanicSceneInfo {
  name: string;
  status: "ok" | "error";
  error: string | null;
}

export interface PanicControllerDeps {
  session: SessionStore;
  /** Persist the chosen safe-scene name so the default survives a restart. */
  persistPanicScene: () => void;
  /** Boot default safe-scene name (from panic.scene.ts). */
  initialSceneName: string;
}

/**
 * The always-warm safe-scene instance (FR-3/FR-7), extracted from main.ts
 * (architecture refactor Phase 3).
 *
 * Owns the warm-instance lifecycle (`tryBuild`), the SAFE designation
 * (`setInstance`, which moves the ⛑ marker to any already-warm instance with no
 * build/gap), and the health surface (`instanceId`, `info`). PANIC must never
 * wait on — or risk — a build, so the warm instance is built next to boot and
 * never disposed; build failures only flag health (`buildError`) while whatever
 * is running keeps running (NFR-5). The hold-fallback (FR-7) triggers only when
 * no usable safe instance has *ever* built.
 */
export class PanicController {
  private sceneNameValue: string;
  // Last build error, surfaced even when a previous good instance still runs;
  // null once a usable instance exists.
  private buildError: string | null = "panic instance not built yet";

  constructor(private readonly d: PanicControllerDeps) {
    this.sceneNameValue = d.initialSceneName;
  }

  /** The current safe-scene name (boot default, or whatever was designated). */
  get sceneName(): string {
    return this.sceneNameValue;
  }

  /**
   * Build (or HMR-rebuild) the warm panic instance, same NFR-5 semantics as the
   * boot instance: a failed rebuild keeps the previous one running and only
   * flags health. The hold-fallback (FR-7) triggers only if there has *never*
   * been a healthy build (no instance exists).
   */
  tryBuild(def: SceneDef): boolean {
    this.sceneNameValue = def?.name ?? this.sceneNameValue;
    if (this.d.session.get(PANIC_ID)) {
      const ok = this.d.session.rebuild(PANIC_ID, def);
      this.buildError = ok ? null : `panic scene "${def?.name ?? "?"}" update rejected (see console)`;
      return ok;
    }
    try {
      const e = this.d.session.create(def, PANIC_ID);
      e.pinned = "panic";
      this.buildError = null;
      return true;
    } catch (err) {
      this.buildError = `panic scene "${def?.name ?? "?"}" failed to build: ${String(err)}`;
      console.error(`[loom] ${this.buildError}; PANIC will hold`, err);
      return false;
    }
  }

  /**
   * Designate an existing, already-warm instance as the SAFE SCENE target (the
   * Console picker). The ⛑ SAFE marker — and what scene-panic cuts to — moves to
   * the chosen instance; no build, no gap. Persists the target's scene so the
   * default reflects it across a restart (instance ids are ephemeral).
   */
  setInstance(id: string): void {
    const target = this.d.session.require(id);
    if (target.pinned === "panic") return;
    for (const e of this.d.session.entries.values()) if (e.pinned === "panic") delete e.pinned;
    target.pinned = "panic";
    this.sceneNameValue = target.sceneName;
    this.buildError = null;
    this.d.persistPanicScene();
  }

  /** A usable safe-target instance exists → scene-panic is available (FR-7). */
  instanceId(): string | null {
    return this.pinnedEntry()?.id ?? (this.d.session.get(PANIC_ID) ? PANIC_ID : null);
  }

  info(): PanicSceneInfo {
    const e = this.pinnedEntry();
    return {
      name: e?.sceneName ?? this.sceneNameValue,
      status: e ? "ok" : "error",
      error: e ? null : this.buildError,
    };
  }

  /**
   * HMR hook: when the `./scenes` barrel rebuilds the pinned safe instance, fold
   * the result into build health (a rejected update flags, a good one clears).
   */
  noteSafeRebuild(ok: boolean, def: SceneDef): void {
    this.buildError = ok ? null : `safe scene "${def.name}" update rejected (see console)`;
  }

  /** The instance currently bearing the SAFE designation, if any. */
  private pinnedEntry(): Entry | undefined {
    for (const e of this.d.session.entries.values()) if (e.pinned === "panic") return e;
    return undefined;
  }
}
