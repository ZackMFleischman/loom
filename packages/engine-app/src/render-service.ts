import type { Clock, FrameCtx, ModulatorHost, PaletteRegistry, Stage, StageDirective } from "@loom/runtime";
import type { WebGPURenderer } from "three/webgpu";
import type { ScreenshotResult } from "@loom/sidecar/protocol";
import type { Compositor } from "./compositor";
import type { DebugSurface } from "./debug-surface";
import type { FpsMeter } from "./fps";
import type { SessionStore } from "./session";

/** A queued effect-picker preview: render N frames in-loop, then resolve. */
export interface PreviewJob {
  run: (f: FrameCtx) => void;
  done: () => void;
}

interface PendingShot {
  resolve: (s: ScreenshotResult) => void;
  reject: (e: Error) => void;
}

export interface RenderServiceDeps {
  renderer: WebGPURenderer;
  canvas: HTMLCanvasElement;
  clock: Clock;
  timeBus: { tick(f: FrameCtx): void };
  audio: { update(f: FrameCtx): void };
  inputs: { update(f: FrameCtx): void };
  /** Debug onset detector polled once per frame (drives onsetCount). */
  debugOnsets: { poll(f: FrameCtx): readonly unknown[] };
  fixtures: { recordFrame(): void };
  stage: Stage;
  projects: { maybeCull(): void };
  session: SessionStore;
  /** Global palette color-channel modulators (R7.4). */
  globalsModulators: ModulatorHost;
  palettes: PaletteRegistry;
  compositor: Compositor;
  fps: FpsMeter;
  debug: DebugSurface;
  /** EngineApi hook: same-task canvas read for the live tile mirror. */
  captureLiveMirror: (mode: StageDirective["mode"]) => void;
  /** EngineApi hook: full-res preview overlay + fps auto-reduction ladder. */
  tickPreview: (mode: StageDirective["mode"], fps: number) => void;
  /** Worker-clock factory (background-tab fallback). */
  workerInterval: (cb: () => void, ms: number) => () => void;
}

/**
 * The render loop (architecture refactor Phase 3) — owns { renderer, session,
 * stage, compositor } and the per-frame tick, plus the rAF/worker-clock
 * lifecycle and the loop-local state the EngineApi reads back (latest frame,
 * current crossfade mix, onset count, the pending screenshot/preview queues).
 *
 * FRAME ORDERING IS LOAD-BEARING — never-go-black depends on it. Within a tick:
 *
 *   advance clocks/buses → record fixture → stage.tick → CULL → modulators →
 *   RENDER (compositor) → MIRROR (live tile) → fps → preview-overlay →
 *   SCREENSHOT (live canvas read) → PREVIEW (effect-picker) → debug surface
 *
 *   - CULL runs before RENDER so a culled instance is never referenced by this
 *     frame's directive (it can't be: it isn't live).
 *   - Modulators write CPU-side BEFORE any leg renders (hold freezes them).
 *   - The SCREENSHOT canvas read happens in the same task as the render (the
 *     drawing buffer is only readable then), and BEFORE the effect-picker
 *     PREVIEW so the candidate fold never disturbs the canvas being read.
 *   - The destination render target is bound before passes run — but that
 *     constraint lives inside Compositor.render / FixtureService.shots, not here.
 */
export class RenderService {
  private latest: FrameCtx = { frame: 0, now: 0, dt: 0 };
  private onsets = 0;
  private mix: number | null = null;
  private heldLastFrame = false;
  private readonly pendingShots: PendingShot[] = [];
  private readonly pendingPreviews: PreviewJob[] = [];

  private yielded = false;
  private lastRafAt = performance.now();
  private stopHiddenClock: (() => void) | null = null;

  constructor(private readonly d: RenderServiceDeps) {}

  /** The most recent frame context (EngineApi reads this for tool timing). */
  get latestFrame(): FrameCtx {
    return this.latest;
  }
  /** Current crossfade mix (null unless mid-crossfade). */
  get currentMix(): number | null {
    return this.mix;
  }
  /** Accumulated debug onset count. */
  get onsetCount(): number {
    return this.onsets;
  }

  /**
   * Resolve a live-canvas screenshot inside the next render task (the drawing
   * buffer is only readable in the task that drew it). Rejects immediately if
   * the output is currently held (PANIC).
   */
  captureCanvas(): Promise<ScreenshotResult> {
    return new Promise<ScreenshotResult>((resolve, reject) => {
      if (this.heldLastFrame) {
        reject(new Error("output is held (PANIC) — resume before taking a live screenshot"));
        return;
      }
      this.pendingShots.push({ resolve, reject });
    });
  }

  /** Queue an effect-picker preview job, serviced one per frame from the loop. */
  queuePreview(job: PreviewJob): void {
    this.pendingPreviews.push(job);
  }

  /** Start the rAF loop + the hidden-tab worker-clock fallback. */
  start(): void {
    this.d.renderer.setAnimationLoop((tMs) => {
      this.lastRafAt = performance.now();
      this.tick(tMs);
    });
    // Browsers freeze rAF in hidden tabs (and starve it for offscreen iframes).
    // A worker clock (exempt from background timer throttling) keeps the engine
    // ticking at ~30 fps whenever rAF isn't delivering; the moment rAF resumes,
    // the starvation guard backs off so the two never double-step.
    this.stopHiddenClock = this.d.workerInterval(() => {
      if (document.hidden || performance.now() - this.lastRafAt > 150) this.tick(performance.now());
    }, 33);
  }

  /** Stand down completely (Console yield): stop rAF + the worker clock. */
  stop(): void {
    this.yielded = true;
    this.d.renderer.setAnimationLoop(null);
    this.stopHiddenClock?.();
  }

  /** One frame. Statement order is the never-go-black contract — see class doc. */
  tick(tMs: number): void {
    if (this.yielded) return;
    const d = this.d;
    const f = d.clock.tick(tMs);
    this.latest = f;
    d.timeBus.tick(f);
    d.audio.update(f);
    d.inputs.update(f); // every channel advances even with zero consumers (R6.4)
    this.onsets += d.debugOnsets.poll(f).length;

    // Fixtures: append this frame's rack values to a pending recording.
    d.fixtures.recordFrame();

    const directive = d.stage.tick(f);
    this.mix = directive.mode === "crossfade" ? directive.mix : null;
    this.heldLastFrame = directive.mode === "hold";

    // Projects: a commit from the loaded set has landed (live, fade done) — cull
    // the replaced instances. Before the render, so a culled instance is never
    // referenced by this frame's directive (it can't be: it isn't live).
    d.projects.maybeCull();
    // Modulators write CPU-side before any leg renders. Hold pauses them all;
    // scene-panic pauses only the suspended live instance (FR-5/FR-10).
    if (directive.mode === "panic-scene") d.session.tickModulators(f, directive.live);
    else if (directive.mode !== "hold") d.session.tickModulators(f);
    // Global palette color-channel modulators (R7.4) write the stops before any
    // leg reads them; hold freezes their phase like instance modulators (FR-10).
    if (directive.mode !== "hold") d.globalsModulators.tick(d.palettes.manifest, f);
    d.compositor.render(d.renderer, f, directive, d.session);
    d.captureLiveMirror(directive.mode); // same-task canvas read for the live tile
    d.fps.tick();
    // Full-res preview overlay: resize the previewed sandbox target / mirror the
    // live canvas, and run the fps auto-reduction ladder (same task as the render).
    d.tickPreview(directive.mode, d.fps.current);

    if (this.pendingShots.length > 0) {
      const waiting = this.pendingShots.splice(0);
      if (directive.mode === "hold") {
        const e = new Error("output is held (PANIC)");
        for (const w of waiting) w.reject(e);
      } else {
        try {
          const url = d.canvas.toDataURL("image/png");
          const shot: ScreenshotResult = {
            mime: "image/png",
            base64: url.slice(url.indexOf(",") + 1),
            width: d.canvas.width,
            height: d.canvas.height,
            frame: f.frame,
            fps: d.fps.current,
          };
          for (const w of waiting) w.resolve(shot);
        } catch (err) {
          const e = err instanceof Error ? err : new Error(String(err));
          for (const w of waiting) w.reject(e);
        }
      }
    }

    // One effect-picker preview per frame (bounds cost), AFTER the live screenshot
    // read so it never disturbs the canvas: the candidate effect is folded over the
    // instance's preview target, which the compositor just refreshed, then rendered
    // to its own offscreen RT.
    if (this.pendingPreviews.length > 0) {
      const job = this.pendingPreviews.shift()!;
      try {
        job.run(f);
      } catch {
        // a bad preview render must never break the live loop
      }
      job.done();
    }

    d.debug.update(f, { onsetCount: this.onsets, currentMix: this.mix });
  }
}
