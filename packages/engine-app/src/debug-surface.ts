import type { FrameCtx, Stage } from "@loom/runtime";
import type { InstanceStatus } from "@loom/sidecar/protocol";
import type { PanicSceneInfo } from "./panic-controller";
import { entryStatus, type SessionStore } from "./session";

/** The `window.__loom` debug surface validators (and the Console's resume hook) read. */
export interface LoomDebug {
  sceneName: string | null;
  audioMode: string;
  /** Input monitor (Console-only): play the mic input through the speakers. */
  monitorEnabled: boolean;
  monitorLevel: number;
  bpm: number;
  rms: number;
  onsetCount: number;
  instanceError: string | null;
  frame: number;
  fps: number;
  /** Which clock drove the last frame: rAF (visible) or the worker fallback (hidden tab). */
  clockSource?: "raf" | "worker";
  /** Wall-time (ms) of the most recent OFF-LOOP thumbnail pass (perf harness/overlay). */
  thumbMs?: number;
  live: string | null;
  staged: string | null;
  mix: number | null;
  panicked: boolean;
  /** Armed PANIC behavior ("hold" | "scene"). */
  panicMode: "hold" | "scene";
  /** Active PANIC mode, or null when not panicked. */
  panicActive: "hold" | "scene" | null;
  /** Designated Panic Scene name + build health. */
  panicScene: PanicSceneInfo;
  agentCommitArmed: boolean;
  instances: Array<{
    id: string;
    scene: string;
    status: InstanceStatus;
    builds: number;
    pinned: "panic" | null;
    modulators: Array<{ path: string; type: string; error: string | null; enabled: boolean }>;
    chain: Array<{ id: string; effect: string; kind: string; mix: number; enabled: boolean }>;
    /** Costliest CPU signals (smoothed ms, desc) — per-signal cost attribution. */
    slowSignals: Array<{ label: string; ms: number }>;
  }>;
  /** Input-rack channel values (rack meters / validation). */
  inputs: Record<string, number>;
  /** Global palette tunings (R7) — palette.<source>.<i> → "#rrggbb". */
  palettes: Record<string, number | boolean | string>;
  /** Mocked-hardware hook: feeds the same path as a real CC message. */
  midiInject: (cc: number, ch: number, value01: number) => void;
  /** Console (parent frame) forwards its click gesture here to unsuspend audio. */
  resumeAudio: () => void;
}

declare global {
  interface Window {
    __loom?: LoomDebug;
  }
}

export interface DebugSurfaceDeps {
  audio: {
    readonly mode: string;
    readonly monitorEnabled: boolean;
    readonly monitorLevel: number;
    rms: { get(f: FrameCtx): number };
    resume(): void;
  };
  timeBus: { readonly bpm: number };
  fps: { readonly current: number };
  stage: Stage;
  session: SessionStore;
  inputs: { values(): Record<string, number> };
  palettes: { manifest: { values(): Record<string, number | boolean | string> } };
  midi: { inject(cc: number, ch: number, value01: number): void };
  /** Safe-scene name + build health (PanicController). */
  panicInfo: () => PanicSceneInfo;
  /** Armed flags from the EngineApi, which is constructed after this surface. */
  armed: () => { panicMode: "hold" | "scene"; agentCommitArmed: boolean };
  /** Most-recent off-loop thumbnail pass time (ms) from the EngineApi (perf). */
  thumbPassMs?: () => number;
}

/**
 * The `window.__loom` debug surface validators read (architecture refactor
 * Phase 3). Builds and installs the surface, then refreshes it each frame.
 *
 * The allocation-heavy `instances` array — `[...entries].map()` with nested
 * `.list().map()` per instance — is rebuilt only every {@link INSTANCES_EVERY}
 * frames instead of every frame. Validators poll it through multi-second
 * `waitFor` loops (and the Console never reads it — only `resumeAudio`), so the
 * ~100 ms refresh cadence is invisible while the per-frame churn is gone. The
 * cheap scalar fields (frame, fps, live, staged, instanceError, inputs, …) stay
 * per-frame fresh so anything a validator polls tightly is never stale.
 */
export class DebugSurface {
  private readonly dbg: LoomDebug;
  private instancesAge = 0;

  constructor(private readonly d: DebugSurfaceDeps) {
    this.dbg = {
      sceneName: null,
      audioMode: d.audio.mode,
      monitorEnabled: d.audio.monitorEnabled,
      monitorLevel: d.audio.monitorLevel,
      bpm: d.timeBus.bpm,
      rms: 0,
      onsetCount: 0,
      instanceError: null,
      frame: 0,
      fps: 0,
      live: null,
      staged: null,
      mix: null,
      panicked: false,
      panicMode: "hold",
      panicActive: null,
      panicScene: d.panicInfo(),
      agentCommitArmed: false,
      instances: [],
      inputs: {},
      palettes: {},
      midiInject: (cc, ch, value01) => d.midi.inject(cc, ch, value01),
      resumeAudio: () => d.audio.resume(),
    };
    window.__loom = this.dbg;
  }

  /** Refresh the surface for this frame (scalars always; instances throttled). */
  update(f: FrameCtx, state: { onsetCount: number; currentMix: number | null }): void {
    const { stage, session, audio } = this.d;
    const liveEntry = stage.live != null ? session.get(stage.live) : undefined;
    const dbg = this.dbg;
    dbg.sceneName = liveEntry?.sceneName ?? null;
    dbg.audioMode = audio.mode;
    dbg.monitorEnabled = audio.monitorEnabled;
    dbg.monitorLevel = audio.monitorLevel;
    dbg.bpm = this.d.timeBus.bpm;
    dbg.rms = audio.rms.get(f);
    dbg.onsetCount = state.onsetCount;
    dbg.instanceError = liveEntry?.instance.error != null ? String(liveEntry.instance.error) : null;
    dbg.frame = f.frame;
    dbg.fps = this.d.fps.current;
    dbg.clockSource = document.hidden ? "worker" : "raf"; // which clock drove this frame
    dbg.live = stage.live;
    dbg.staged = stage.staged;
    dbg.mix = state.currentMix;
    dbg.panicked = stage.panicked;
    const armed = this.d.armed();
    dbg.panicMode = armed.panicMode;
    dbg.panicActive = stage.panicActive;
    dbg.panicScene = this.d.panicInfo();
    dbg.agentCommitArmed = armed.agentCommitArmed;
    if (this.d.thumbPassMs != null) dbg.thumbMs = this.d.thumbPassMs();
    dbg.inputs = this.d.inputs.values();
    dbg.palettes = this.d.palettes.manifest.values();
    // Throttle the allocation-heavy instances rebuild (frame 0, then every Nth).
    if (this.instancesAge++ % INSTANCES_EVERY === 0) {
      dbg.instances = [...session.entries.values()].map((e) => ({
        id: e.id,
        scene: e.sceneName,
        status: entryStatus(e),
        builds: e.builds,
        pinned: e.pinned ?? null,
        modulators: e.modulators
          .list()
          .map((m) => ({ path: m.path, type: m.spec.type, error: m.error, enabled: m.enabled })),
        chain: e.chain.list(),
        slowSignals: e.instance.slowSignals(),
      }));
    }
  }
}

/** Rebuild the heavy `instances` snapshot at most this often (~100 ms at 60 fps). */
const INSTANCES_EVERY = 6;
