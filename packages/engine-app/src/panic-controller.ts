import type { Entry, SessionStore } from "./session";

/** What scene-panic cuts to + its health, surfaced to the Console/__loom. */
export interface PanicSceneInfo {
  /** The designated instance's scene name, or "" when none is designated. */
  name: string;
  /**
   * "none" = no SAFE target designated (scene-panic unavailable → PANIC holds);
   * "ok" = a healthy designated instance exists; "error" = the designated
   * instance has errored (PANIC holds).
   */
  status: "none" | "ok" | "error";
  /** Last error for an errored target, else null. */
  error: string | null;
}

export interface PanicControllerDeps {
  session: SessionStore;
}

/**
 * The SAFE-target designation for scene-panic (panic-safe-scene-redesign).
 *
 * Scene-panic is **opt-in**: there is no boot-default warm instance anymore. At
 * boot nothing is designated — `instanceId()` returns null and PANIC holds. The
 * human turns scene-panic on by designating an existing, already-warm instance
 * as the SAFE target via `setInstance` (the Console picker), which moves the ⛑
 * marker with no build and no gap, exactly as before. Designation is purely
 * runtime over existing instances and is **not persisted** — a fresh session
 * boots to hold, the human re-designates if they want scene-panic.
 *
 * The engine's panic machinery is unchanged: a missing/errored target degrades
 * scene-panic to hold (FR-7), and the designated instance is destroy/rename
 * protected (engine-api) exactly as today.
 */
export class PanicController {
  constructor(private readonly d: PanicControllerDeps) {}

  /**
   * Designate an existing, already-warm instance as the SAFE SCENE target (the
   * Console picker). The ⛑ SAFE marker — and what scene-panic cuts to — moves to
   * the chosen instance; no build, no gap.
   */
  setInstance(id: string): void {
    const target = this.d.session.require(id);
    if (target.pinned === "panic") return;
    for (const e of this.d.session.entries.values()) if (e.pinned === "panic") delete e.pinned;
    target.pinned = "panic";
  }

  /**
   * The designated, usable safe-target instance id → scene-panic is available
   * (FR-4). Null until the human designates one, or when the designated instance
   * has errored (so the engine falls back to hold, FR-7).
   */
  instanceId(): string | null {
    const e = this.pinnedEntry();
    if (!e) return null;
    return e.instance.error != null ? null : e.id;
  }

  info(): PanicSceneInfo {
    const e = this.pinnedEntry();
    if (!e) return { name: "", status: "none", error: null };
    const err = e.instance.error;
    if (err != null) return { name: e.sceneName, status: "error", error: String(err) };
    return { name: e.sceneName, status: "ok", error: null };
  }

  /** The instance currently bearing the SAFE designation, if any. */
  private pinnedEntry(): Entry | undefined {
    for (const e of this.d.session.entries.values()) if (e.pinned === "panic") return e;
    return undefined;
  }
}
