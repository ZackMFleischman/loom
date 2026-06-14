import type {
  AudioBusLike,
  BindingStore,
  FixtureData,
  FrameCtx,
  InputRegistry,
  Manifest,
  ModulatorHost,
  PaletteRegistry,
  SceneDef,
  Stage,
  TimeBus,
} from "@loom/runtime";
import { fixtureName, isModBinding, isPalettePath, modTarget } from "@loom/runtime";
import {
  ArmAgentCommitArgs,
  ArmPanicModeArgs,
  BatchArgs,
  ClearModulationArgs,
  CommitArgs,
  CreateInstanceArgs,
  InstanceArgs,
  LiveStepArgs,
  LoadProjectArgs,
  MidiTargetArgs,
  ModulateParamArgs,
  PanicArgs,
  PreviewEffectArgs,
  RecordFixtureArgs,
  RenameInstanceArgs,
  SaveChainArgs,
  SaveProjectArgs,
  ScreenshotArgs,
  SetAudioArgs,
  SetChainArgs,
  SetColorSpaceArgs,
  SetModulationEnabledArgs,
  SetPanicInstanceArgs,
  SetParamArgs,
  SetParamsArgs,
  SetParamRangeArgs,
  SetPreviewArgs,
  TransportArgs,
  type AudioDevice,
  type EffectInfo,
  type FixtureShot,
  type LayerNode,
  type MidiMessageLog,
  type PanicMode,
  type PanicSceneInfo,
  type PreviewFrame,
  type RequestMsg,
  type ScreenshotResult,
  type SessionSnapshot,
} from "@loom/sidecar/protocol";
import type { WebGPURenderer } from "three/webgpu";
import { readTargetToDataUrl } from "./readback";
import { entryStatus, PREVIEW_H, PREVIEW_W, type Entry, type SessionStore } from "./session";

/** Who issued a command: the MCP bridge ("agent") or the Console ("human"). */
export type Source = "agent" | "human";

// set_audio is human-only: an agent must not silently swap the audio source
// mid-set (it isn't an MCP tool either — this is the belt to that braces).
// MIDI-learn is a physical-controller gesture, so it's human-only too.
const HUMAN_ONLY: ReadonlySet<string> = new Set([
  "live_step",
  "panic",
  "resume",
  "arm_panic_mode",
  "set_panic_instance",
  "set_audio",
  "arm_agent_commit",
  "rename_instance",
  "midi_learn",
  "midi_unbind",
  "set_preview",
]);

// Full-res preview stream (Console preview overlay): the ladder of streamed
// heights (16:9), the fps thresholds that drive auto-reduction, and how long a
// trend must hold before stepping. Reacts down fast, climbs back slowly.
const PREVIEW_LEVELS = [1080, 720, 540, 360] as const;
const PREVIEW_FPS_LOW = 50;
const PREVIEW_FPS_HIGH = 57;
const PREVIEW_LOW_HOLD = 20; // ~0.33 s of sag before dropping a level
const PREVIEW_GOOD_HOLD = 240; // ~4 s of headroom before climbing back
const PREVIEW_QUALITY = 0.82;
const previewWidth = (h: number): number => Math.round((h * 16) / 9);
const snapPreviewLevel = (h: number): number =>
  PREVIEW_LEVELS.reduce((best, l) => (Math.abs(l - h) < Math.abs(best - h) ? l : best), PREVIEW_LEVELS[0]);
const stepPreviewDown = (h: number): number =>
  PREVIEW_LEVELS[Math.min(PREVIEW_LEVELS.indexOf(h as (typeof PREVIEW_LEVELS)[number]) + 1, PREVIEW_LEVELS.length - 1)]!;
const stepPreviewUp = (h: number): number =>
  PREVIEW_LEVELS[Math.max(PREVIEW_LEVELS.indexOf(h as (typeof PREVIEW_LEVELS)[number]) - 1, 0)]!;

/** Pseudo-instance id serving the global manifest (input rack tunings). */
const GLOBALS = "globals";

/** Pseudo-instance for MIDI action bindings (stage navigation). */
const ACTIONS = "actions";
const ACTION_PATHS: ReadonlySet<string> = new Set(["live.next", "live.prev"]);

export interface EngineDeps {
  renderer: WebGPURenderer;
  canvas: HTMLCanvasElement;
  session: SessionStore;
  stage: Stage;
  audio: AudioBusLike & {
    mode: string;
    startMic(deviceId?: string): Promise<void>;
    startTest(bpm?: number): void;
  };
  time: TimeBus;
  /** The input rack: globals manifest + live channel values (R6). */
  inputs: InputRegistry;
  /** Global color palettes (R7): second globals-side manifest, path prefix "palette.". */
  palettes: PaletteRegistry;
  /** Modulators for decomposed global palette color channels (R7.4). */
  globalsModulators: ModulatorHost;
  /** MIDI bindings + learn state; CC routing itself lives in main.ts. */
  bindings: BindingStore;
  midiStatus(): "off" | "ready";
  midiDevices(): string[];
  /** Raw-message monitor (incl. non-CC traffic the engine ignores). */
  midiRecent(): MidiMessageLog[];
  /** Tuned-state persistence triggers (debounced engine-side). */
  persist: {
    globals(): void;
    palettes(): void;
    scene(scene: string): void;
    bindings(): void;
  };
  /** Cached audio input devices (snapshot is sync; main.ts owns the refresh). */
  audioDevices(): AudioDevice[];
  refreshAudioDevices(): void;
  getScenes(): Map<string, SceneDef>;
  /** The chainable-effect library for the "+ effect" picker (M6). */
  availableEffects(): EffectInfo[];
  /** Write the instance's current chain as a composite effect file; returns its repo path. */
  saveEffectChain(name: string, data: unknown): Promise<{ path: string }>;
  /** Render a candidate effect over an instance's current output → JPEG data URL (picker grid). */
  previewEffect(instanceId: string, effect: string): Promise<string>;
  latestFrame(): FrameCtx;
  /** Same-task canvas capture, resolved by the render loop (live output only). */
  captureCanvas(): Promise<ScreenshotResult>;
  fps(): number;
  rms(): number;
  onsetCount(): number;
  /** Current crossfade mix from the last directive, or null. */
  currentMix(): number | null;
  /** The warm panic instance's id if one is usable, else null (PANIC holds). */
  panicInstanceId(): string | null;
  /** The designated Panic Scene's name + build health (FR-7/FR-10). */
  panicScene(): PanicSceneInfo;
  /** Designate which existing instance the SAFE SCENE panic cuts to. */
  setPanicInstance(id: string): void;
  /** Id bookkeeping outside the session (main.ts tracks the boot instance). */
  onInstanceRenamed?(from: string, to: string): void;
  /** Fixtures — deterministic input traces (main.ts owns recording + replay shots). */
  fixtures: {
    /** Capture the live rack for N frames; resolves when the trace is written. */
    record(name: string, frames: number): Promise<{ saved: string; path: string; frames: number; channels: string[]; bpm: number }>;
    /** Load + validate a saved trace. */
    load(name: string): Promise<FixtureData>;
    /** Deterministic offline captures of a fixture entry at the given frames. */
    shots(entryId: string, frames: number[]): Promise<FixtureShot[]>;
  };
  /** Projects — set lists (main.ts owns the store, persistence and the cull). */
  projects: {
    /** Refresh from disk and return the saved project names. */
    list(): Promise<string[]>;
    /** Last known names (sync, for the session snapshot). */
    cached(): string[];
    save(name: string, tileOrder?: string[]): Promise<{ saved: string; path: string; instances: number }>;
    /** Audience-safe load: sandboxes only, the Stage is never touched. */
    load(name: string): Promise<{
      created: string[];
      skipped: Array<{ id: string; scene: string; reason: string }>;
    }>;
  };
}

/**
 * One dispatch for every engine command, shared by the WS bridge (agent)
 * and the Console BroadcastChannel (human). Throws become ok:false
 * responses at the transport layer — never engine crashes.
 */
export class EngineApi {
  agentCommitArmed: boolean;
  /** Armed PANIC behavior; the human sets it from the Console (FR-1/FR-10). */
  armedPanicMode: PanicMode = "hold";

  // The live output's thumbnail source. The WebGL canvas is only readable in
  // the task that rendered it, so the render loop mirrors it in here (a 2D
  // canvas keeps its bitmap) and thumbnails() reads the mirror at leisure.
  private readonly liveMirror = document.createElement("canvas");
  private readonly liveMirrorCtx: CanvasRenderingContext2D;
  private liveMirrorAt = -Infinity;
  private consoleSeenAt = -Infinity;

  // Full-res preview stream state. `preview` is the active request (instance +
  // user-chosen ceiling); `previewSizedId` is the sandbox entry whose target we
  // enlarged (restored when preview moves/stops); `previewMirror` holds the
  // downscaled live canvas when the *live* instance is the one being previewed.
  private preview: { id: string; ceilingH: number } | null = null;
  private previewAdaptiveH: number = PREVIEW_LEVELS[0];
  private previewActualH: number = PREVIEW_LEVELS[0];
  private previewSizedId: string | null = null;
  private previewLowFrames = 0;
  private previewGoodFrames = 0;
  private readonly previewMirror = document.createElement("canvas");
  private readonly previewMirrorCtx: CanvasRenderingContext2D;

  constructor(
    private readonly deps: EngineDeps,
    opts: { agentCommitArmed?: boolean } = {},
  ) {
    this.agentCommitArmed = opts.agentCommitArmed ?? false;
    this.liveMirror.width = 640;
    this.liveMirror.height = 360;
    this.liveMirrorCtx = this.liveMirror.getContext("2d")!;
    this.previewMirrorCtx = this.previewMirror.getContext("2d")!;
  }

  markConsolePresent(): void {
    this.consoleSeenAt = performance.now();
  }

  /**
   * Call from the render loop right after compositing — same task as the
   * render, the only place the canvas is readable. Throttled to thumbnail
   * rate and skipped entirely when no Console is listening.
   */
  captureLiveMirror(mode: "single" | "crossfade" | "hold" | "panic-scene"): void {
    // Skip while held or scene-panicked: the canvas isn't showing the LIVE
    // instance, so the live tile keeps its last good (pre-panic) mirror.
    if (mode === "hold" || mode === "panic-scene" || this.deps.stage.live == null) return;
    const now = performance.now();
    if (now - this.consoleSeenAt > 5000 || now - this.liveMirrorAt < 140) return;
    this.liveMirrorAt = now;
    this.liveMirrorCtx.drawImage(this.deps.canvas, 0, 0, this.liveMirror.width, this.liveMirror.height);
  }

  /**
   * "live" is an alias, not an id: it resolves to whatever instance is
   * currently LIVE (the boot instance is id "boot"). Commands default to
   * it so "tweak the live thing" needs no id lookup.
   */
  private resolveId(id: string): string {
    return id === "live" ? (this.deps.stage.live ?? id) : id;
  }

  /**
   * Humans may edit the LIVE chain directly; an agent needs the same arming
   * gate as commit to touch it. Non-live (sandbox) chain edits are ungated —
   * they change nothing the audience sees.
   */
  private guardLiveChain(source: Source, id: string): void {
    if (source === "agent" && this.deps.stage.live === id && !this.agentCommitArmed) {
      throw new Error(
        "agent edits to the LIVE chain need arming — edit a staged candidate instead, " +
          "or ask the human to arm agent commit (engines started with ?agentCommit=1 arm it)",
      );
    }
  }

  async handleRequest(req: RequestMsg, source: Source): Promise<unknown> {
    if (source === "agent" && HUMAN_ONLY.has(req.type)) {
      throw new Error(`${req.type} is a human-only control (Console)`);
    }
    const { session, stage } = this.deps;
    switch (req.type) {
      case "get_session":
        return this.snapshot();
      case "get_manifest": {
        const { instance } = InstanceArgs.parse(req.args);
        if (instance === GLOBALS) {
          return { instance: GLOBALS, params: this.globalsJson() };
        }
        const e = session.require(this.resolveId(instance));
        return { instance: e.id, params: this.manifestJson(e), nodes: this.nodesJson(e) };
      }
      case "set_param": {
        const { instance, path, value } = SetParamArgs.parse(req.args);
        if (instance === GLOBALS) {
          const isPalette = isPalettePath(path);
          const param = this.requireParam(this.globalsManifest(path), path, GLOBALS);
          const gmod = this.deps.globalsModulators.get(path);
          if (gmod != null && gmod.error == null && gmod.enabled) {
            throw new Error(
              `"${path}" on "globals" is modulated (${gmod.spec.type}) — call clear_modulation ` +
                "or set_modulation_enabled false (∿ in the Console) to take manual control",
            );
          }
          param.set(value);
          if (isPalette) this.deps.persist.palettes();
          else this.deps.persist.globals();
          return { instance: GLOBALS, path, value: param.value as number | boolean | string };
        }
        const e = session.require(this.resolveId(instance));
        const param = this.requireParam(e.instance.manifest, path, e.id);
        const mod = e.modulators.get(path);
        if (mod != null && mod.error == null && mod.enabled) {
          throw new Error(
            `"${path}" on "${e.id}" is modulated (${mod.spec.type}) — call clear_modulation ` +
              "or set_modulation_enabled false (∿ in the Console) to take manual control",
          );
        }
        param.set(value);
        this.deps.persist.scene(e.sceneName);
        return { instance: e.id, path, value: param.value as number | boolean | string };
      }
      case "set_params": {
        // The batched set_param: every path is applied in this one handler call,
        // so the whole group lands on the same frame (no tearing between knobs)
        // and persistence flushes once. Partial success — a bad path is reported
        // in `errors[]` rather than sinking the rest.
        const { instance, values } = SetParamsArgs.parse(req.args);
        const set: Array<{ path: string; value: number | boolean | string }> = [];
        const errors: Array<{ path: string; error: string }> = [];
        if (instance === GLOBALS) {
          let touchedPalette = false;
          let touchedGlobals = false;
          for (const [path, value] of Object.entries(values)) {
            try {
              const isPalette = isPalettePath(path);
              const param = this.requireParam(this.globalsManifest(path), path, GLOBALS);
              param.set(value);
              if (isPalette) touchedPalette = true;
              else touchedGlobals = true;
              set.push({ path, value: param.value as number | boolean | string });
            } catch (err) {
              errors.push({ path, error: err instanceof Error ? err.message : String(err) });
            }
          }
          if (touchedPalette) this.deps.persist.palettes();
          if (touchedGlobals) this.deps.persist.globals();
          return { instance: GLOBALS, set, errors };
        }
        const e = session.require(this.resolveId(instance));
        for (const [path, value] of Object.entries(values)) {
          try {
            const param = this.requireParam(e.instance.manifest, path, e.id);
            const mod = e.modulators.get(path);
            if (mod != null && mod.error == null && mod.enabled) {
              throw new Error(
                `"${path}" on "${e.id}" is modulated (${mod.spec.type}) — call clear_modulation ` +
                  "or set_modulation_enabled false to take manual control",
              );
            }
            param.set(value);
            set.push({ path, value: param.value as number | boolean | string });
          } catch (err) {
            errors.push({ path, error: err instanceof Error ? err.message : String(err) });
          }
        }
        if (set.length > 0) this.deps.persist.scene(e.sceneName);
        return { instance: e.id, set, errors };
      }
      case "set_param_range": {
        const { instance, path, min, max, restoreDefault } = SetParamRangeArgs.parse(req.args);
        const retune = (param: ReturnType<typeof this.requireParam>) => {
          if (!param.rangeable) {
            throw new Error(
              `"${path}" is ${param.type}${param.range() != null ? " (a labelled selector)" : ""} — ` +
                "only plain float/int sliders have an editable range",
            );
          }
          if (restoreDefault) {
            param.resetRange();
            return;
          }
          const [curLo, curHi] = param.range()!;
          param.setRange(min ?? curLo, max ?? curHi);
        };
        if (instance === GLOBALS) {
          const param = this.requireParam(this.globalsManifest(path), path, GLOBALS);
          retune(param);
          // Rack ranges persist with the rack tunings (palette params have no range).
          this.deps.persist.globals();
          const [lo, hi] = param.range()!;
          return { instance: GLOBALS, path, min: lo, max: hi, value: param.value as number };
        }
        const e = session.require(this.resolveId(instance));
        const param = this.requireParam(e.instance.manifest, path, e.id);
        retune(param);
        this.deps.persist.scene(e.sceneName);
        const [lo, hi] = param.range()!;
        return { instance: e.id, path, min: lo, max: hi, value: param.value as number };
      }
      case "modulate_param": {
        const { instance, path, modulator } = ModulateParamArgs.parse(req.args);
        if (instance === GLOBALS) {
          const manifest = this.globalsManifest(path);
          this.requireGlobalsChannel(manifest, path);
          const spec = this.deps.globalsModulators.attach(manifest, path, modulator);
          this.deps.persist.palettes();
          return { instance: GLOBALS, path, modulator: spec };
        }
        const e = session.require(this.resolveId(instance));
        if (!e.instance.manifest.get(path)) {
          const have = e.instance.manifest.paths().join(", ") || "(none)";
          throw new Error(`unknown param "${path}" on "${e.id}" — manifest has: ${have}`);
        }
        const spec = e.modulators.attach(e.instance.manifest, path, modulator);
        return { instance: e.id, path, modulator: spec };
      }
      case "clear_modulation": {
        const { instance, path } = ClearModulationArgs.parse(req.args);
        if (instance === GLOBALS) {
          const cleared = this.deps.globalsModulators.clear(path);
          if (cleared) this.deps.persist.palettes();
          return { instance: GLOBALS, path, cleared };
        }
        const e = session.require(this.resolveId(instance));
        return { instance: e.id, path, cleared: e.modulators.clear(path) };
      }
      case "set_modulation_enabled": {
        const { instance, path, enabled } = SetModulationEnabledArgs.parse(req.args);
        if (instance === GLOBALS) {
          const info = this.deps.globalsModulators.setEnabled(path, enabled);
          this.deps.persist.palettes();
          return { instance: GLOBALS, path, enabled: info.enabled };
        }
        const e = session.require(this.resolveId(instance));
        const info = e.modulators.setEnabled(path, enabled); // throws when nothing is attached
        return { instance: e.id, path, enabled: info.enabled };
      }
      case "set_color_space": {
        const { instance, path, space } = SetColorSpaceArgs.parse(req.args);
        if (instance === GLOBALS) {
          const manifest = this.globalsManifest(path);
          const { added, removed } = manifest.setColorSpace(path, space);
          for (const cp of removed) {
            this.deps.globalsModulators.clear(cp);
            this.deps.bindings.unbind({ scene: GLOBALS, path: cp });
          }
          this.deps.persist.palettes();
          if (removed.length > 0) this.deps.persist.bindings();
          return { instance: GLOBALS, path, space, added, removed };
        }
        const e = session.require(this.resolveId(instance));
        this.requireParam(e.instance.manifest, path, e.id);
        const { added, removed } = e.instance.manifest.setColorSpace(path, space);
        for (const cp of removed) {
          e.modulators.clear(cp);
          this.deps.bindings.unbind({ scene: e.sceneName, path: cp });
        }
        this.deps.persist.scene(e.sceneName);
        if (removed.length > 0) this.deps.persist.bindings();
        return { instance: e.id, path, space, added, removed };
      }
      case "set_chain": {
        const { instance, node, steps, restoreDefault } = SetChainArgs.parse(req.args);
        const e = session.require(this.resolveId(instance));
        this.guardLiveChain(source, e.id);
        // Throws on an unknown effect/node or a rejected build (chain unchanged / NFR-5).
        session.setChain(e.id, restoreDefault ? "default" : (steps ?? []), node);
        this.deps.persist.scene(e.sceneName);
        const host = node == null ? e.chain : e.nodeChains.get(node);
        return { instance: e.id, node: node ?? null, chain: host?.list() ?? [] };
      }
      case "preview_effect": {
        const { instance, effect } = PreviewEffectArgs.parse(req.args);
        const e = session.require(this.resolveId(instance));
        return { effect, image: await this.deps.previewEffect(e.id, effect) };
      }
      case "save_chain": {
        const { instance, name, description } = SaveChainArgs.parse(req.args);
        const e = session.require(this.resolveId(instance));
        e.chain.captureValues(e.instance.manifest); // saved knobs reflect live tweaks
        const { steps } = e.chain.serialize(); // throws if a composite is present
        if (steps.length === 0) throw new Error("nothing to save — this instance has no chain");
        const payload = { name, ...(description != null ? { description } : {}), steps };
        const { path } = await this.deps.saveEffectChain(name, payload);
        return { saved: name, path, steps: steps.length };
      }
      case "screenshot": {
        const { instance, frames } = ScreenshotArgs.parse(req.args);
        const e = session.require(this.resolveId(instance));
        if (frames != null) {
          // Deterministic offline pass (Fixtures): same trace + frame list →
          // identical pixels, every time. Only meaningful against a fixture.
          if (e.fixture == null) {
            throw new Error(
              `"${e.id}" replays no fixture — screenshot {frames} needs an instance ` +
                'created with inputs: "fixture:<name>"',
            );
          }
          return { fixture: e.fixture.name, frames: await this.deps.fixtures.shots(e.id, frames) };
        }
        if (this.isOnCanvas(e)) return this.deps.captureCanvas();
        return this.targetShot(e);
      }
      case "create_instance": {
        const { scene, id, inputs } = CreateInstanceArgs.parse(req.args);
        const def = this.deps.getScenes().get(scene);
        if (!def) {
          const have = [...this.deps.getScenes().keys()].join(", ") || "(none)";
          throw new Error(`unknown scene "${scene}" — available: ${have}`);
        }
        let fixture;
        if (inputs != null) {
          const name = fixtureName(inputs);
          const data = await this.deps.fixtures.load(name); // throws on unknown/corrupt trace
          fixture = { name, data, baseFrame: this.deps.latestFrame().frame };
        }
        const e = session.create(def, id, fixture ? { fixture } : undefined);
        return { instance: e.id, scene: e.sceneName, paramPaths: e.instance.manifest.paths() };
      }
      case "record_fixture": {
        const { name, frames } = RecordFixtureArgs.parse(req.args);
        return await this.deps.fixtures.record(name, frames);
      }
      case "destroy_instance": {
        const { instance } = InstanceArgs.parse(req.args);
        const e = session.require(this.resolveId(instance));
        if (stage.live === e.id) {
          throw new Error(`"${e.id}" is LIVE — commit something else before destroying it`);
        }
        if (e.pinned === "panic") {
          throw new Error(`"${e.id}" is the SAFE target — designate another instance before destroying it`);
        }
        stage.onInstanceDestroyed(e.id);
        session.destroy(e.id);
        return { destroyed: e.id };
      }
      case "rename_instance": {
        const { instance, to } = RenameInstanceArgs.parse(req.args);
        const e = session.require(this.resolveId(instance));
        const from = e.id;
        if (to === from) return { instance: to, was: from };
        if (e.pinned === "panic") {
          throw new Error(`"${from}" is the SAFE target — designate another instance before renaming it`);
        }
        if (to === "live" || to === "globals" || to === "actions") {
          throw new Error(`"${to}" is a reserved name`);
        }
        session.rename(from, to);
        stage.onInstanceRenamed(from, to);
        this.deps.onInstanceRenamed?.(from, to);
        return { instance: to, was: from };
      }
      case "stage": {
        const { instance } = InstanceArgs.parse(req.args);
        const e = session.require(this.resolveId(instance));
        stage.stage(e.id);
        return { staged: e.id, live: stage.live };
      }
      case "unstage":
        stage.unstage();
        return { staged: null };
      case "commit": {
        const { durationFrames } = CommitArgs.parse(req.args);
        if (source === "agent" && !this.agentCommitArmed) {
          throw new Error(
            "agent commit is not armed — the human disarmed it (Console checkbox or " +
              "?agentCommit=0); ask them to press COMMIT in the Console or re-arm agent commit",
          );
        }
        const from = stage.live;
        const to = stage.staged;
        stage.commit(this.deps.latestFrame(), durationFrames);
        return { from, to, durationFrames };
      }
      case "live_step": {
        // Same deck-ring step the MIDI prev/next buttons fire — now also
        // reachable as a real Console button (mash-safe: a no-op mid-fade /
        // under PANIC / with <2 healthy tiles).
        const { dir } = LiveStepArgs.parse(req.args);
        const before = stage.live;
        this.liveStep(dir);
        return { dir, from: before, live: stage.live };
      }
      case "panic": {
        // Execute the armed mode (an explicit override is allowed). Scene mode
        // routes the warm panic instance; if none is usable, Stage falls back
        // to hold (FR-7) — worst case equals today's behavior, never worse.
        const { mode } = PanicArgs.parse(req.args);
        const effective = mode ?? this.armedPanicMode;
        const panicId = effective === "scene" ? this.deps.panicInstanceId() : null;
        stage.panic(panicId != null ? "scene" : "hold", panicId);
        return { panicked: true, mode: stage.panicActive };
      }
      case "resume":
        stage.resume();
        return { panicked: false };
      case "arm_panic_mode": {
        const { mode } = ArmPanicModeArgs.parse(req.args);
        this.armedPanicMode = mode;
        return { panicMode: mode };
      }
      case "set_panic_instance": {
        // Move the SAFE designation to an existing, already-warm instance — no
        // build, no gap. Its scene becomes the safe target scene-panic cuts to.
        const { instance } = SetPanicInstanceArgs.parse(req.args);
        const e = session.require(this.resolveId(instance));
        this.deps.setPanicInstance(e.id);
        return { panicScene: this.deps.panicScene(), instance: e.id };
      }
      case "set_transport": {
        const { bpm, tap } = TransportArgs.parse(req.args);
        if (bpm !== undefined) this.deps.time.setBpm(bpm);
        if (tap) this.deps.time.tap(performance.now() / 1000);
        return { bpm: this.deps.time.bpm };
      }
      case "set_audio": {
        const { mode, deviceId } = SetAudioArgs.parse(req.args);
        if (mode === "test") {
          this.deps.audio.startTest(this.deps.time.bpm);
        } else {
          try {
            await this.deps.audio.startMic(deviceId);
          } catch (err) {
            // Never leave the instrument deaf: fall back like boot does.
            this.deps.audio.startTest(this.deps.time.bpm);
            throw new Error(`mic unavailable (${String(err)}) — fell back to the test signal`);
          }
        }
        this.deps.refreshAudioDevices(); // labels appear once mic permission is granted
        return { audioMode: this.deps.audio.mode };
      }
      case "arm_agent_commit": {
        const { armed } = ArmAgentCommitArgs.parse(req.args);
        this.agentCommitArmed = armed;
        return { agentCommitArmed: armed };
      }
      case "set_preview": {
        const { instance, maxHeight } = SetPreviewArgs.parse(req.args);
        if (instance == null) {
          this.preview = null;
          this.restorePreviewTarget();
        } else {
          const id = this.resolveId(instance);
          session.require(id); // throws on unknown id
          const ceilingH = snapPreviewLevel(maxHeight);
          // A manual pick (or a switch) gets a fresh try at the chosen ceiling —
          // reset the adaptive headroom so we don't stay stuck at a prior floor.
          this.preview = { id, ceilingH };
          this.previewAdaptiveH = ceilingH;
          this.previewActualH = ceilingH;
          this.previewLowFrames = 0;
          this.previewGoodFrames = 0;
        }
        return { preview: this.preview };
      }
      case "midi_learn": {
        const target = this.resolveMidiTarget(req.args);
        this.deps.bindings.startLearn(target);
        return { learning: this.deps.bindings.learning };
      }
      case "midi_unbind": {
        const target = this.resolveMidiTarget(req.args);
        const removed = this.deps.bindings.unbind(target);
        if (removed) this.deps.persist.bindings();
        return { removed };
      }
      case "list_projects":
        return { projects: await this.deps.projects.list() };
      case "save_project": {
        // Saving writes a repo file — same trust tier as commit for agents.
        const { name, tileOrder } = SaveProjectArgs.parse(req.args);
        if (source === "agent" && !this.agentCommitArmed) {
          throw new Error(
            "agent project save is not armed — ask the human to save from the Console, " +
              "or to arm agent commit",
          );
        }
        return await this.deps.projects.save(name, tileOrder);
      }
      case "load_project": {
        // Audience-safe: builds sandboxes only; LIVE keeps playing untouched.
        const { name } = LoadProjectArgs.parse(req.args);
        const out = await this.deps.projects.load(name);
        return { loaded: name, created: out.created, skipped: out.skipped, live: stage.live };
      }
      case "batch": {
        // Fan one round-trip out to many commands. Each sub-call re-enters this
        // same dispatch, so every per-type validation AND every gate (human-only
        // verbs, live-commit arming) is enforced exactly as a direct call would
        // be. Serial in request order; `stopOnError` aborts the remainder.
        const { mode, stopOnError, calls } = BatchArgs.parse(req.args);
        const results: Array<
          | { ok: true; tool: string; result: unknown }
          | { ok: false; tool: string; error: string }
        > = [];
        for (const call of calls) {
          if (call.tool === "batch") {
            // Reject nesting rather than recurse — keeps the fan-out one level
            // deep and bounds the work a single request can trigger.
            results.push({ ok: false, tool: call.tool, error: "batch cannot nest" });
            if (stopOnError) break;
            continue;
          }
          try {
            const result = await this.handleRequest(
              { id: req.id, kind: "req", type: call.tool, args: call.args },
              source,
            );
            results.push({ ok: true, tool: call.tool, result });
          } catch (err) {
            results.push({ ok: false, tool: call.tool, error: err instanceof Error ? err.message : String(err) });
            if (stopOnError) break;
          }
        }
        return { mode, results };
      }
    }
  }

  /**
   * MIDI action: crossfade LIVE to the next/prev ok-status tile, wrapping in
   * tile (insertion) order. Mash-safe: ignored mid-fade, under PANIC, or with
   * fewer than two healthy tiles — a stuck button can never throw. Pinned
   * tiles (the always-warm safe scene) are reserves, not part of the deck
   * ring — though stepping OFF one still works (escape after a scene-panic).
   */
  liveStep(dir: 1 | -1): void {
    const { session, stage } = this.deps;
    if (stage.panicked || stage.fading) return;
    const ids = [...session.entries.values()]
      .filter((e) => entryStatus(e) === "ok" && e.pinned == null)
      .map((e) => e.id);
    const live = stage.live;
    if (live == null || ids.length < 2) return;
    const cur = ids.indexOf(live); // -1 (live not ok) still lands on a valid neighbor
    const next = ids[(cur + dir + ids.length) % ids.length]!;
    if (next === live) return;
    stage.stage(next); // deliberately clobbers a pending staged candidate — performer wins
    stage.commit(this.deps.latestFrame(), 60);
  }

  /**
   * MIDI targets address a SCENE (durable across instance churn): an instance
   * arg resolves to its scene name; "globals" and "actions" pass through.
   * Param paths must exist on the target manifest right now — fail loud at
   * learn time, not silently on the first knob twist. Action bindings are
   * always edge-triggered ("set" semantics, no value).
   */
  private resolveMidiTarget(args: unknown): {
    scene: string;
    path: string;
    mode?: "absolute" | "set" | "cycle";
    value?: number;
  } {
    const { instance, path, mode, value } = MidiTargetArgs.parse(args);
    const rest = {
      ...(mode !== undefined ? { mode } : {}),
      ...(value !== undefined ? { value } : {}),
    };
    if (instance === ACTIONS) {
      if (!ACTION_PATHS.has(path)) {
        throw new Error(`unknown action "${path}" — actions: ${[...ACTION_PATHS].join(", ")}`);
      }
      return { scene: ACTIONS, path, mode: "set" };
    }
    // "mod:<paramPath>" toggles that param's modulator on/off (a button press
    // pauses/resumes the wave without detaching). Always edge-triggered.
    if (isModBinding(path)) {
      const paramPath = modTarget(path);
      if (instance === GLOBALS) {
        // Only a decomposed palette color channel carries a modulator on globals.
        this.requireGlobalsChannel(this.globalsManifest(paramPath), paramPath);
        return { scene: GLOBALS, path, mode: "cycle" };
      }
      const e = this.deps.session.require(this.resolveId(instance));
      this.requireParam(e.instance.manifest, paramPath, e.id);
      return { scene: e.sceneName, path, mode: "cycle" };
    }
    let scene: string;
    let param: { type: string };
    if (instance === GLOBALS) {
      scene = GLOBALS;
      param = this.requireParam(this.globalsManifest(path), path, GLOBALS);
    } else {
      const e = this.deps.session.require(this.resolveId(instance));
      scene = e.sceneName;
      param = this.requireParam(e.instance.manifest, path, e.id);
    }
    if (mode === "set") {
      if (value === undefined) throw new Error(`a set binding needs a value ("${path}")`);
      if (param.type === "bool" || param.type === "color") {
        throw new Error(
          `set targets numeric params — "${path}" is ${param.type}` +
            (param.type === "bool" ? " (use cycle to toggle it)" : ""),
        );
      }
    }
    return { scene, path, ...rest };
  }

  /** "globals" = the input rack + the palettes, merged; routed by path prefix. */
  private globalsManifest(path: string): Manifest {
    return isPalettePath(path) ? this.deps.palettes.manifest : this.deps.inputs.manifest;
  }

  /**
   * Only a decomposed palette color CHANNEL modulates/binds on "globals" — the
   * input-rack tunings and the (still-color) stops stay hand-driven. Returns
   * the channel param or throws a pointer to set_color_space.
   */
  private requireGlobalsChannel(manifest: Manifest, path: string) {
    const param = this.requireParam(manifest, path, GLOBALS);
    const channelOf = (param.toJSON() as { channelOf?: unknown }).channelOf;
    if (channelOf == null) {
      throw new Error(
        `"${path}" on "globals" isn't a color channel — expand a palette stop into HSV/RGB ` +
          "(set_color_space) first, then modulate/bind its h/s/v or r/g/b channel",
      );
    }
    return param;
  }

  private globalsJson(): Record<string, unknown> {
    const out = {
      ...(this.deps.inputs.manifest.toJSON() as Record<string, Record<string, unknown>>),
      ...(this.deps.palettes.manifest.toJSON() as Record<string, Record<string, unknown>>),
    };
    // Carry each channel's modulator config (FR-8 parity with instance manifests).
    for (const m of this.deps.globalsModulators.list()) {
      if (out[m.path] != null) {
        out[m.path]!.modulator = m.error == null ? { ...m.spec, enabled: m.enabled } : null;
      }
    }
    return out;
  }

  private requireParam(manifest: Manifest, path: string, owner: string) {
    const param = manifest.get(path);
    if (!param) {
      const have = manifest.paths().join(", ") || "(none)";
      throw new Error(`unknown param "${path}" on "${owner}" — manifest has: ${have}`);
    }
    return param;
  }

  snapshot(): SessionSnapshot {
    const { session, stage } = this.deps;
    const liveEntry = stage.live != null ? session.get(stage.live) : undefined;
    return {
      scene: liveEntry?.sceneName ?? null,
      instance: liveEntry?.id ?? null,
      instanceError: liveEntry?.instance.error != null ? String(liveEntry.instance.error) : null,
      paramPaths: liveEntry?.instance.manifest.paths() ?? [],
      instances: [...session.entries.values()].map((e) => ({
        id: e.id,
        scene: e.sceneName,
        status: entryStatus(e),
        error: e.instance.error != null ? String(e.instance.error) : null,
        paramPaths: e.instance.manifest.paths(),
        modulators: e.modulators
          .list()
          .map((m) => ({ path: m.path, type: m.spec.type, error: m.error, enabled: m.enabled })),
        chain: e.chain.list(),
        nodes: this.nodesJson(e),
        fixture: e.fixture?.name ?? null,
        frameMs: Math.round(e.instance.frameMs * 100) / 100,
        slowSignals: e.instance.slowSignals(),
        builds: e.builds,
        pinned: e.pinned ?? null,
      })),
      live: stage.live,
      staged: stage.staged,
      mix: this.deps.currentMix(),
      panicked: stage.panicked,
      panicMode: this.armedPanicMode,
      panicActive: stage.panicActive,
      panicScene: this.deps.panicScene(),
      agentCommitArmed: this.agentCommitArmed,
      availableScenes: [...this.deps.getScenes().keys()],
      availableEffects: this.deps.availableEffects(),
      projects: this.deps.projects.cached(),
      audioMode: this.deps.audio.mode,
      audioDevices: this.deps.audioDevices(),
      inputs: this.deps.inputs.values(),
      midi: {
        status: this.deps.midiStatus(),
        devices: this.deps.midiDevices(),
        learning: this.deps.bindings.learning,
        recent: this.deps.midiRecent(),
      },
      bindings: this.deps.bindings.toJSON(),
      bpm: this.deps.time.bpm,
      rms: this.deps.rms(),
      onsetCount: this.deps.onsetCount(),
      fps: this.deps.fps(),
      frame: this.deps.latestFrame().frame,
    };
  }

  /** Console state payload: snapshot plus full manifests for param panels. */
  consoleState(): { session: SessionSnapshot; manifests: Record<string, unknown> } {
    const manifests: Record<string, unknown> = {};
    for (const e of this.deps.session.entries.values()) {
      manifests[e.id] = this.manifestJson(e);
    }
    manifests[GLOBALS] = this.globalsJson(); // the rack's widgets + palettes
    return { session: this.snapshot(), manifests };
  }

  /** Layer nodes (Layers): id, immediate parent, and each node's chain steps. */
  private nodesJson(e: Entry): LayerNode[] {
    return e.instance.nodes.map((n) => ({
      id: n.id,
      parent: n.parent,
      chain: e.nodeChains.get(n.id)?.list() ?? [],
    }));
  }

  /** Manifest JSON with each param's attached modulator config + enabled (or null) — FR-8. */
  private manifestJson(e: Entry): Record<string, unknown> {
    const params = e.instance.manifest.toJSON() as Record<string, Record<string, unknown>>;
    for (const path of Object.keys(params)) {
      const m = e.modulators.get(path);
      params[path]!.modulator =
        m != null && m.error == null ? { ...m.spec, enabled: m.enabled } : null;
    }
    return params;
  }

  /** Small JPEG thumbnails per instance for the Console tiles. */
  async thumbnails(width = 640, height = 360): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const e of this.deps.session.entries.values()) {
      try {
        // The live entry shows what the audience sees (loop-mirrored canvas);
        // everyone else reads back their offscreen preview target at its full
        // 640×360 res — enough for the 2x tiles AND /staged.html full-screen
        // (the old staged-only 2x special case is now just the default).
        out[e.id] =
          e.id === this.deps.stage.live
            ? this.liveMirror.toDataURL("image/jpeg", 0.7)
            : await this.readTarget(e, width, height, "image/jpeg");
      } catch {
        // skip a tile this round rather than break the loop
      }
    }
    return out;
  }

  /** Live output renders straight to the canvas outside a crossfade. */
  private isOnCanvas(e: Entry): boolean {
    return this.deps.stage.live === e.id && !this.deps.stage.fading && !this.deps.stage.panicked;
  }

  private async targetShot(e: Entry): Promise<ScreenshotResult> {
    const dataUrl = await this.readTarget(e, PREVIEW_W, PREVIEW_H, "image/png");
    return {
      mime: "image/png",
      base64: dataUrl.slice(dataUrl.indexOf(",") + 1),
      width: PREVIEW_W,
      height: PREVIEW_H,
      frame: this.deps.latestFrame().frame,
      fps: this.deps.fps(),
    };
  }

  private readTarget(e: Entry, outW: number, outH: number, mime: string): Promise<string> {
    // Read the target at its ACTUAL size — a previewed instance's target is
    // enlarged (tickPreview), and the source region must match or the readback
    // crops. Thumbnails/screenshots still downscale to their requested outW/outH.
    return readTargetToDataUrl(this.deps.renderer, e.target, e.target.width, e.target.height, {
      outW,
      outH,
      mime,
      quality: 0.7,
    });
  }

  /** True while a Console preview overlay is asking for a full-res stream. */
  previewActive(): boolean {
    return this.preview != null && performance.now() - this.consoleSeenAt < 5000;
  }

  /**
   * Per-frame preview bookkeeping (called from the render loop). Runs the fps
   * auto-reduction ladder, then prepares the source the stream reads from: for
   * the LIVE instance it downscales the canvas into previewMirror (the canvas is
   * only readable in this task); for a sandbox instance it resizes that entry's
   * render target so the compositor renders it at the preview resolution (once
   * per frame — no second render). Never throws into the loop.
   */
  tickPreview(mode: "single" | "crossfade" | "hold" | "panic-scene", fps: number): void {
    const p = this.preview;
    if (p == null || performance.now() - this.consoleSeenAt > 5000) {
      this.restorePreviewTarget();
      return;
    }
    const e = this.deps.session.get(p.id);
    if (!e) {
      // Previewed instance vanished (destroyed/renamed) — drop the request.
      this.preview = null;
      this.restorePreviewTarget();
      return;
    }

    // Adaptive ladder: sag drops a level fast, sustained headroom climbs slowly.
    if (fps > 0 && fps < PREVIEW_FPS_LOW) {
      this.previewLowFrames++;
      this.previewGoodFrames = 0;
    } else if (fps >= PREVIEW_FPS_HIGH) {
      this.previewGoodFrames++;
      this.previewLowFrames = Math.max(0, this.previewLowFrames - 1);
    } else {
      this.previewLowFrames = Math.max(0, this.previewLowFrames - 1);
      this.previewGoodFrames = 0;
    }
    if (this.previewLowFrames >= PREVIEW_LOW_HOLD) {
      this.previewAdaptiveH = stepPreviewDown(this.previewAdaptiveH);
      this.previewLowFrames = 0;
    } else if (this.previewGoodFrames >= PREVIEW_GOOD_HOLD && this.previewAdaptiveH < p.ceilingH) {
      this.previewAdaptiveH = stepPreviewUp(this.previewAdaptiveH);
      this.previewGoodFrames = 0;
    }
    const actualH = Math.min(p.ceilingH, this.previewAdaptiveH);
    this.previewActualH = actualH;
    const w = previewWidth(actualH);

    const isLive =
      this.deps.stage.live === p.id && mode !== "hold" && mode !== "panic-scene";
    try {
      if (isLive) {
        // Live renders to the canvas, not entry.target — mirror the canvas.
        this.restorePreviewTarget();
        if (this.previewMirror.width !== w || this.previewMirror.height !== actualH) {
          this.previewMirror.width = w;
          this.previewMirror.height = actualH;
        }
        this.previewMirrorCtx.drawImage(this.deps.canvas, 0, 0, w, actualH);
      } else {
        // Size the sandbox instance's target up so the compositor renders it at
        // the preview resolution next frame; restore any previously-sized entry.
        if (this.previewSizedId !== p.id) this.restorePreviewTarget();
        if (e.target.width !== w || e.target.height !== actualH) {
          e.target.setSize(w, actualH);
        }
        this.previewSizedId = p.id;
      }
    } catch {
      // A bad capture/resize must never disturb the live loop.
    }
  }

  /** Restore the enlarged preview target back to the standard thumbnail size. */
  private restorePreviewTarget(): void {
    if (this.previewSizedId == null) return;
    const e = this.deps.session.get(this.previewSizedId);
    if (e && (e.target.width !== PREVIEW_W || e.target.height !== PREVIEW_H)) {
      e.target.setSize(PREVIEW_W, PREVIEW_H);
    }
    this.previewSizedId = null;
  }

  /**
   * One frame of the preview stream (called off the render loop at stream rate,
   * like thumbnails). Reads the previewMirror (live) or the enlarged target
   * (sandbox) back as a JPEG. Returns null when there's nothing to stream.
   */
  async previewFrame(): Promise<PreviewFrame | null> {
    const p = this.preview;
    if (p == null) return null;
    const e = this.deps.session.get(p.id);
    if (!e) return null;
    const ceilingHeight = p.ceilingH;
    const actualHeight = this.previewActualH;
    const reduced = actualHeight < ceilingHeight;
    const isLive = this.deps.stage.live === p.id;
    try {
      if (isLive) {
        const w = this.previewMirror.width;
        const h = this.previewMirror.height;
        if (w === 0 || h === 0) return null;
        return {
          instance: p.id,
          image: this.previewMirror.toDataURL("image/jpeg", PREVIEW_QUALITY),
          width: w,
          height: h,
          actualHeight,
          ceilingHeight,
          reduced,
        };
      }
      const w = e.target.width;
      const h = e.target.height;
      const image = await readTargetToDataUrl(this.deps.renderer, e.target, w, h, {
        mime: "image/jpeg",
        quality: PREVIEW_QUALITY,
      });
      return { instance: p.id, image, width: w, height: h, actualHeight, ceilingHeight, reduced };
    } catch {
      return null;
    }
  }
}
