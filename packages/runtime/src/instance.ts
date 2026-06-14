import { MeshBasicNodeMaterial, QuadMesh, type RenderTarget, type WebGPURenderer } from "./tsl";
import { BuildCtx, type Updater } from "./buildctx";
import { LOOP_GUARD_PREFIX } from "./loopguard-prefix";
import type { FrameCtx } from "./frame";
import type { AudioBusLike } from "./inputbus/audio";
import type { TimeBus } from "./inputbus/time";
import type { InputProvider } from "./fixture";
import type { LayerHooks, LayerNodeInfo } from "./layer";
import type { PaletteRegistry } from "./palette";
import type { Manifest } from "./param";
import type { SceneDef } from "./scene";
import type { ColorNode, Pass, TexNode } from "./texnode";

/**
 * A running scene graph. NFR-2: any exception inside render freezes this
 * instance (holds the last presented frame) — it never propagates to the
 * engine loop. NFR-5: code changes rebuild the instance from scratch.
 */
export class Instance {
  error: unknown = null;
  /** Smoothed renderFrame cost in ms — the per-instance frame-time HUD (M7). */
  frameMs = 0;

  /**
   * The owning session entry's id (e.g. "pulse-2"), set by the engine after
   * build and kept current across rename. The kernel itself only knows
   * {@link Instance.sceneName} at construction; this lets a render-time freeze /
   * loop-guard event carry the actual INSTANCE id (so `get_diagnostics
   * { instance:<id> }` matches a freeze on a sandbox whose id ≠ scene name).
   * Falls back to `sceneName` when unset (tests, headless kernel use).
   */
  instanceId: string | null = null;

  /**
   * Per-updater cost attribution (EMA ms), keyed by the updater's label (a param
   * path, "palette", "input.kick", …) or `uniform#<i>` for unlabeled ones.
   * Populated only while {@link Instance.profilingEnabled} is on; lets a frame's
   * time be traced to the specific signal that drove it (slow/heavy-signal hunt).
   */
  private readonly signalCost = new Map<string, number>();

  /**
   * Global toggle for per-signal profiling. On by default — the timing overhead
   * (two `performance.now()` reads per updater) is microseconds against the
   * frame budget, and it only measures, never changes values, so fixture
   * replays stay byte-identical. The engine sets it from `?profile=0`.
   */
  static profilingEnabled = true;

  /**
   * Injected diagnostics sink (app-instrumentation). The kernel keeps NO engine
   * dependency — like {@link Instance.profilingEnabled}, this is a static the
   * engine sets at boot. Used to surface the NFR-2 render-time freeze as a
   * structured event without importing the engine's ring. A no-op when unset
   * (tests, headless kernel use) and WRAPPED at the call site so emit can never
   * disturb the loop.
   */
  static diagSink: ((event: {
    level: "info" | "warn" | "error";
    kind: string;
    instance?: string;
    msg: string;
    data?: Record<string, unknown>;
  }) => void) | null = null;

  /** Emit through {@link Instance.diagSink}, swallowing any error (NFR-1). */
  private static emit(event: {
    level: "info" | "warn" | "error";
    kind: string;
    instance?: string;
    msg: string;
    data?: Record<string, unknown>;
  }): void {
    const sink = Instance.diagSink;
    if (sink == null) return;
    try {
      sink(event);
    } catch {
      // a broken sink must never break render
    }
  }

  private readonly material = new MeshBasicNodeMaterial();
  private readonly quad: QuadMesh;

  constructor(
    readonly sceneName: string,
    readonly manifest: Manifest,
    private readonly updaters: ReadonlyArray<Updater>,
    private readonly passes: readonly Pass[],
    output: ColorNode,
    /** Named nodes registered by ctx.layer() during this build (Layers). */
    readonly nodes: ReadonlyArray<LayerNodeInfo> = [],
  ) {
    this.material.colorNode = output;
    this.quad = new QuadMesh(this.material);
  }

  /**
   * Render exactly once per frame (stateful passes advance per call).
   * `target` null presents to the canvas; a RenderTarget renders offscreen
   * (preview tiles, crossfade legs).
   */
  renderFrame(renderer: WebGPURenderer, f: FrameCtx, target: RenderTarget | null = null): void {
    if (this.error != null) return; // frozen: hold the last good frame
    const t0 = performance.now();
    try {
      if (Instance.profilingEnabled) this.runUpdatersProfiled(f);
      else for (const update of this.updaters) update(f);
      for (const pass of this.passes) pass.render(renderer, f);
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(target);
      this.quad.render(renderer);
      renderer.setRenderTarget(prev);
    } catch (err) {
      this.error = err;
      console.error(`[loom] instance "${this.sceneName}" froze (NFR-2 containment):`, err);
      // Surface the freeze as a structured event (app-instrumentation). A loop
      // guard trip is a distinct, high-value kind the agent should recognize.
      const message = err instanceof Error ? err.message : String(err);
      const isLoopGuard = err instanceof Error && err.message.startsWith(LOOP_GUARD_PREFIX);
      // Carry the instance id (not the scene name) so `get_diagnostics
      // { instance:<id> }` matches a freeze on a sandbox whose id ≠ scene name.
      const id = this.instanceId ?? this.sceneName;
      Instance.emit({
        level: "error",
        kind: isLoopGuard ? "loopguard.tripped" : "instance.frozen",
        instance: id,
        msg: `instance "${id}" froze (NFR-2): ${message}`,
        data: { error: message, scene: this.sceneName, frame: f.frame },
      });
    }
    // CPU-side submit cost (GPU time is opaque here) — still the early-warning
    // meter for heavy scenes: stacked chains, geo worlds, particle pools.
    this.frameMs = this.frameMs * 0.9 + (performance.now() - t0) * 0.1;
  }

  /** Run every updater, folding each one's cost into the EMA attribution map. */
  private runUpdatersProfiled(f: FrameCtx): void {
    const updaters = this.updaters;
    for (let i = 0; i < updaters.length; i++) {
      const u = updaters[i]!;
      const u0 = performance.now();
      u(f);
      const key = u.label ?? `uniform#${i}`;
      const prev = this.signalCost.get(key) ?? 0;
      this.signalCost.set(key, prev * 0.9 + (performance.now() - u0) * 0.1);
    }
  }

  /**
   * The costliest CPU signals this instance is pulling, by smoothed ms,
   * descending. Empty when profiling is off or nothing has rendered yet —
   * the agent's window into "which signal is eating the frame".
   */
  slowSignals(limit = 5): Array<{ label: string; ms: number }> {
    return [...this.signalCost.entries()]
      .map(([label, ms]) => ({ label, ms: Math.round(ms * 1000) / 1000 }))
      .sort((a, b) => b.ms - a.ms)
      .slice(0, limit);
  }

  dispose(): void {
    for (const pass of this.passes) {
      try {
        pass.dispose();
      } catch {}
    }
    this.material.dispose();
  }
}

/** Build a scene into a running instance. Throws on a bad build — callers contain. */
export function buildInstance(
  scene: SceneDef,
  buses: { audio: AudioBusLike; time: TimeBus; inputs?: InputProvider; palettes?: PaletteRegistry },
  /**
   * Optional post-effect fold (M6 chains): wraps the scene's output before the
   * manifest finalizes, so chain params land on the same manifest and a throwing
   * step throws the whole build (NFR-5 keeps the previous pixels).
   */
  fold?: (ctx: BuildCtx, tex: TexNode) => TexNode,
  /** Per-node hooks (Layers): lets the session fold node chains at the wrap point. */
  layerHooks?: LayerHooks,
): Instance {
  const ctx = new BuildCtx(buses.audio, buses.time, buses.inputs, buses.palettes, layerHooks);
  let out = scene.build(ctx);
  if (out?.color == null) {
    throw new Error(`scene "${scene.name}": build() must return a TexNode`);
  }
  if (fold) out = fold(ctx, out);
  ctx.finalize();
  return new Instance(scene.name, ctx.manifest, ctx.updaters, out.passes, out.color, ctx.nodes);
}
