import type { FrameCtx } from "./frame";

/** Armed/active PANIC behavior: freeze the last frame, or cut to a safe scene. */
export type PanicMode = "hold" | "scene";

/** What the engine's compositor should do this frame. */
export type StageDirective =
  | { mode: "single"; live: string | null }
  | { mode: "crossfade"; live: string; staged: string; mix: number }
  | { mode: "hold" }
  | { mode: "panic-scene"; panic: string; live: string | null };

interface Fade {
  from: string;
  to: string;
  /** First frame of the fade (frame boundary after commit was called). */
  start: number;
  duration: number;
}

/**
 * The slot/commit machinery (R4.1/R4.2), pure state: which instance is LIVE,
 * which is staged, crossfade progress, and PANIC. The engine calls tick()
 * once per frame and renders whatever the directive says. Stage knows ids
 * only — instance lifecycles live in the engine's session registry.
 */
export class Stage {
  private liveId: string | null;
  private stagedId: string | null = null;
  private fade: Fade | null = null;
  /** null = not panicked; otherwise the active mode. */
  private panicState: PanicMode | null = null;
  /** The routed instance id while scene-panicked (null in hold mode). */
  private panicId: string | null = null;

  constructor(initialLive: string | null = null) {
    this.liveId = initialLive;
  }

  get live(): string | null {
    return this.liveId;
  }

  get staged(): string | null {
    return this.stagedId;
  }

  get panicked(): boolean {
    return this.panicState !== null;
  }

  /** The active PANIC mode, or null when not panicked. */
  get panicActive(): PanicMode | null {
    return this.panicState;
  }

  /** The instance routed to output while scene-panicked, or null. */
  get panicSceneId(): string | null {
    return this.panicId;
  }

  get fading(): boolean {
    return this.fade !== null;
  }

  stage(id: string): void {
    if (id === this.liveId) throw new Error(`"${id}" is already live`);
    this.stagedId = id;
  }

  /**
   * Boot/recovery only: make an instance live when nothing is. Every other
   * LIVE change must go through commit() — the audience-safety invariant.
   */
  adoptLive(id: string): void {
    if (this.liveId !== null) {
      throw new Error(`cannot adopt "${id}" — "${this.liveId}" is live; use commit()`);
    }
    this.liveId = id;
    if (this.stagedId === id) this.stagedId = null;
  }

  unstage(): void {
    this.stagedId = null;
    this.fade = null; // a fade only exists toward a staged candidate
  }

  /**
   * Begin the crossfade to the staged candidate at the next frame boundary.
   * The audience-facing transition: only this (and panic) may change LIVE.
   */
  commit(f: FrameCtx, durationFrames = 60): void {
    if (this.panicState !== null) throw new Error("PANIC is engaged — resume before committing");
    if (this.fade) throw new Error("a commit is already in progress");
    if (this.stagedId === null || this.liveId === null) {
      throw new Error("nothing staged to commit");
    }
    this.fade = {
      from: this.liveId,
      to: this.stagedId,
      start: f.frame + 1,
      duration: Math.max(0, Math.floor(durationFrames)), // 0 = hard cut at the boundary
    };
  }

  /**
   * Execute the armed PANIC mode. `hold` freezes the last presented frame;
   * `scene` routes a pre-built panic instance to the output with a hard cut and
   * WITHOUT moving the LIVE pointer (FR-4) — resume() returns to whatever was
   * live. Either way an in-flight crossfade is cancelled first (FR-9).
   *
   * Re-pressing while already panicked only ever escalates hold→scene;
   * scene→hold is a no-op, since holding the safe scene is strictly worse than
   * rendering it (FR-6). Passing `scene` with no panicId (a broken/absent panic
   * instance) falls back to hold (FR-7).
   */
  panic(mode: PanicMode = "hold", panicId: string | null = null): void {
    this.fade = null; // FR-9: cancel an in-flight crossfade first
    if (mode === "scene" && panicId !== null) {
      this.panicState = "scene";
      this.panicId = panicId;
      return;
    }
    // hold (or scene-with-no-instance fallback): never downgrade an active
    // scene-panic back to hold.
    if (this.panicState === "scene") return;
    this.panicState = "hold";
    this.panicId = null;
  }

  resume(): void {
    this.panicState = null;
    this.panicId = null;
  }

  onInstanceDestroyed(id: string): void {
    if (this.stagedId === id) this.unstage();
    if (this.liveId === id) {
      this.liveId = null;
      this.fade = null;
    }
    // Defensive: the engine protects the panic instance, but if its id ever
    // vanishes mid-panic, degrade scene-panic to hold rather than route a ghost.
    if (this.panicId === id) {
      this.panicId = null;
      if (this.panicState === "scene") this.panicState = "hold";
    }
  }

  /** Keep slot pointers (and an in-flight fade) coherent across an id rename. */
  onInstanceRenamed(from: string, to: string): void {
    if (this.liveId === from) this.liveId = to;
    if (this.stagedId === from) this.stagedId = to;
    if (this.fade) {
      if (this.fade.from === from) this.fade.from = to;
      if (this.fade.to === from) this.fade.to = to;
    }
  }

  tick(f: FrameCtx): StageDirective {
    if (this.panicState === "scene" && this.panicId !== null) {
      // Output override only — the LIVE pointer is untouched (FR-4).
      return { mode: "panic-scene", panic: this.panicId, live: this.liveId };
    }
    if (this.panicState === "hold") return { mode: "hold" };
    const fade = this.fade;
    if (fade && f.frame >= fade.start) {
      if (f.frame >= fade.start + fade.duration) {
        this.liveId = fade.to;
        this.stagedId = null;
        this.fade = null;
        return { mode: "single", live: this.liveId };
      }
      // Every fade frame is a true blend: mix walks (0, 1) exclusive, so a
      // duration-N fade spends exactly N frames visibly crossing.
      return {
        mode: "crossfade",
        live: fade.from,
        staged: fade.to,
        mix: (f.frame - fade.start + 1) / (fade.duration + 1),
      };
    }
    return { mode: "single", live: this.liveId };
  }
}
