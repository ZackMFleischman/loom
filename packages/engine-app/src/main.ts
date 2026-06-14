import {
  AudioBus,
  BindingStore,
  buildInstance,
  BuildCtx,
  ChainHost,
  Clock,
  Events,
  FixtureDataSchema,
  FixturePlayer,
  InputRegistry,
  isFxPath,
  Instance,
  MidiBus,
  ModulatorHost,
  PaletteRegistry,
  Signal,
  Stage,
  texNode,
  TimeBus,
  type AudioBusLike,
  type FixtureData,
  type FrameCtx,
  type InputsDef,
  type SceneDef,
} from "@loom/runtime";
import { DEFAULT_WS_PORT, type InstanceStatus, type ScreenshotResult } from "@loom/sidecar/protocol";
import { texture, vec4 } from "three/tsl";
import { RenderTarget, WebGPURenderer } from "three/webgpu";
import inputsDef from "../../../content/inputs";
import liveScene from "../../../content/scenes/live.scene";
import panicScene from "../../../content/scenes/panic.scene";
import { startBridge } from "./bridge";
import { Compositor } from "./compositor";
import { ProjectsController } from "./projects-controller";
import { readTargetToDataUrl } from "./readback";
import { startConsoleChannel } from "./console-channel";
import { EngineApi } from "./engine-api";
import { FpsMeter } from "./fps";
import { getEffectLibrary } from "./effects";
import { MidiRouter } from "./midi-router";
import { PanicController } from "./panic-controller";
import { getScenes } from "./scenes";
import { entryStatus, PREVIEW_H, PREVIEW_W, SessionStore } from "./session";
import { fixtureKey, repoStatePath, StateClient, StateDir, StateKey } from "./state";
import { workerInterval } from "./worker-clock";

declare global {
  interface Window {
    __loom?: {
      sceneName: string | null;
      audioMode: string;
      bpm: number;
      rms: number;
      onsetCount: number;
      instanceError: string | null;
      frame: number;
      fps: number;
      /** Which clock drove the last frame: rAF (visible) or the worker fallback (hidden tab). */
      clockSource?: "raf" | "worker";
      live: string | null;
      staged: string | null;
      mix: number | null;
      panicked: boolean;
      /** Armed PANIC behavior ("hold" | "scene"). */
      panicMode: "hold" | "scene";
      /** Active PANIC mode, or null when not panicked. */
      panicActive: "hold" | "scene" | null;
      /** Designated Panic Scene name + build health. */
      panicScene: { name: string; status: "ok" | "error"; error: string | null };
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
    };
  }
}

const qs = new URLSearchParams(location.search);

// Per-signal cost attribution is on by default (negligible overhead); `?profile=0`
// opts out for the perf-paranoid. Surfaces as `slowSignals` in get_session.
Instance.profilingEnabled = qs.get("profile") !== "0";

const canvas = document.querySelector<HTMLCanvasElement>("#out");
const fpsEl = document.querySelector<HTMLElement>("#fps");
if (!canvas || !fpsEl) {
  throw new Error("index.html is missing #out or #fps");
}
// The Output window is a pure projector surface (R9.1): the fps readout is
// kept in the DOM (validators gate readiness on its text) but stays invisible
// unless diagnostics are asked for.
if (qs.get("hud") === "1") fpsEl.classList.add("show");

// R9.2: render at a fixed internal resolution; CSS object-fit: cover scales
// the canvas to any window without warping (crop, never stretch). Render cost
// and screenshot size stop depending on window/display size.
const RES = /^(\d+)x(\d+)$/.exec(qs.get("res") ?? "");
const RENDER_W = RES ? Number(RES[1]) : 1920;
const RENDER_H = RES ? Number(RES[2]) : 1080;

const renderer = new WebGPURenderer({ canvas, antialias: true });
const clock = new Clock();
const timeBus = new TimeBus(Number(qs.get("bpm")) || 120);
const audio = new AudioBus();
const fps = new FpsMeter(fpsEl);

// The input rack (R6): named channels over the audio/MIDI buses, tuned via
// the globals manifest. defineInputs failures keep the previous rack —
// never-go-black covers the rack too.
const midi = new MidiBus();

// Chrome ≥124 gates ALL WebMIDI behind a permission prompt — and this page
// is a bare projector surface the human rarely interacts with, so the boot
// request can be dismissed or never seen. Make init retryable: on pointer
// gestures here, and the moment the permission flips to granted (the Console
// primes the prompt in the window the human actually clicks; grants are
// per-origin, so they unlock this page too).
let midiInitInFlight = false;
async function ensureMidi(): Promise<void> {
  if (midi.status === "ready" || midiInitInFlight) return;
  midiInitInFlight = true;
  try {
    const ok = await midi.init();
    if (ok) {
      console.info(`[loom] MIDI ready (${midi.devices.join(", ") || "no devices yet — hot-plug works"})`);
    } else {
      console.warn("[loom] MIDI unavailable (permission not granted yet?) — grant it from the Console header");
    }
  } finally {
    midiInitInFlight = false;
  }
}
void ensureMidi();
void (async () => {
  try {
    const perm = await navigator.permissions.query({ name: "midi" as PermissionName });
    perm.onchange = () => {
      if (perm.state === "granted") void ensureMidi();
    };
    if (perm.state === "granted") void ensureMidi();
  } catch {
    // Permissions API has no "midi" here — gesture retry still covers us.
  }
})();
const inputs = new InputRegistry({ audio, midi });
function tryDefineInputs(def: InputsDef): boolean {
  try {
    inputs.define(def);
    return true;
  } catch (err) {
    console.error("[loom] content/inputs.ts rejected; keeping previous rack", err);
    return false;
  }
}
tryDefineInputs(inputsDef);

// Global color palettes (R7): a second globals-side manifest, served through
// the same "globals" pseudo-instance and persisted like the rack tunings.
const palettes = new PaletteRegistry();

// Modulators for decomposed global palette color CHANNELS (R7.4): the input
// rack stays hand-tuned, but a stop expanded into HSV/RGB exposes channel
// params an LFO or MIDI fader can drive. Ticked each frame before any leg
// reads the stops; phase freezes under PANIC hold like instance modulators.
const globalsModulators = new ModulatorHost({ bpm: () => timeBus.bpm, audio });

/** Globals modulator specs for persistence ([] when none attached). */
function serializeGlobalsMods(): Array<{ path: string; spec: unknown; enabled: boolean }> {
  return globalsModulators.list().map((m) => ({ path: m.path, spec: m.spec, enabled: m.enabled }));
}

const bindings = new BindingStore();
// `?state=off` keeps validation runs from reading/writing tuned state.
const state = new StateClient(qs.get("state") !== "off");
const tunedValues = new Map<string, Record<string, number | boolean | string>>();
// Per-scene slider range overrides (path → [min, max]); persisted next to values
// and reapplied before them on every build, so a widened bound holds across HMR.
const tunedRanges = new Map<string, Record<string, [number, number]>>();
// Per-scene color decompositions (path → "hsv"|"rgb"); reapplied before values
// on every build so a stop expanded into channels survives HMR (R7.4).
const tunedColorSpaces = new Map<string, Record<string, "hsv" | "rgb">>();

const persist = {
  globals: () => {
    state.save(StateKey.inputs, () => inputs.manifest.values());
    state.save(StateKey.inputRanges, () => inputs.manifest.rangeOverrides());
  },
  palettes: () => {
    state.save(StateKey.palettes, () => palettes.manifest.values());
    // Color decomposition + channel modulators travel with the palette tunings.
    state.save(StateKey.paletteSpaces, () => palettes.manifest.colorSpaces());
    state.save(StateKey.paletteMods, () => serializeGlobalsMods());
  },
  scene: (sceneName: string) => {
    const entry = [...session.entries.values()].find((e) => e.sceneName === sceneName);
    if (entry) {
      // Chain knob values (fx.*) live in the chain data, not the per-scene file
      // (full chain persistence is M9) — keep them out of values/<scene>.json.
      const vals = entry.instance.manifest.values();
      for (const k of Object.keys(vals)) if (isFxPath(k)) delete vals[k];
      tunedValues.set(sceneName, vals);
      const ranges = entry.instance.manifest.rangeOverrides();
      for (const k of Object.keys(ranges)) if (isFxPath(k)) delete ranges[k];
      tunedRanges.set(sceneName, ranges);
      tunedColorSpaces.set(sceneName, entry.instance.manifest.colorSpaces());
    }
    state.save(StateKey.sceneValues(sceneName), () => tunedValues.get(sceneName) ?? {});
    state.save(StateKey.sceneRanges(sceneName), () => tunedRanges.get(sceneName) ?? {});
    state.save(StateKey.sceneColorSpaces(sceneName), () => tunedColorSpaces.get(sceneName) ?? {});
  },
  bindings: () => state.save(StateKey.bindings, () => bindings.toJSON()),
  panicScene: () => state.save(StateKey.panic, () => ({ scene: panicController.sceneName })),
};

// MIDI routing lives in MidiRouter (writeParam / setModEnabled / onCc) —
// constructed and started below, once `session` exists.

// The chainable-effect library (M6). Re-cached on an `./effects` hot-update so a
// saved chain or an edited effect appears in the picker without a reload.
let effectsLib = getEffectLibrary();

// Save the live chain to content/modules/effects/chains/<name>.chain.json (the
// Vite loom:effects middleware writes it; the glob picks it up as a composite).
async function saveEffectChain(name: string, data: unknown): Promise<{ path: string }> {
  const res = await fetch(`/loom/effects/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`save failed (${res.status}): ${await res.text().catch(() => "")}`);
  return { path: `content/modules/effects/chains/${name}.chain.json` };
}

const session = new SessionStore(
  { audio, time: timeBus, inputs, palettes },
  () => effectsLib,
  (scene) => tunedValues.get(scene),
  (scene) => tunedRanges.get(scene),
  (scene) => tunedColorSpaces.get(scene),
);

// CC handling (writeParam / setModEnabled / actions). `onAction` is late-bound
// after the EngineApi exists; the CC subscription is live immediately.
const midiRouter = new MidiRouter({ midi, session, inputs, palettes, globalsModulators, bindings, persist });
midiRouter.start();

// Effect-picker previews: fold a candidate effect over an instance's CURRENT
// output (its already-rendered preview target — no extra scene render, so a live
// instance's stateful passes are never disturbed) into a throwaway instance,
// render a few frames in-loop, and read it back as a JPEG. Serviced one per
// frame from the render loop (the only place the renderer is ours to drive).
const PREVIEW2_W = 256;
const PREVIEW2_H = 144;
const PREVIEW2_FRAMES = 8; // lets stateful candidates (feedback) settle over the still source
const pendingPreviews: Array<{ run: (f: FrameCtx) => void; done: () => void }> = [];

async function previewEffect(instanceId: string, effect: string): Promise<string> {
  const e = session.require(instanceId);
  const outRT = new RenderTarget(PREVIEW2_W, PREVIEW2_H);
  let preview: Instance;
  try {
    const ctx = new BuildCtx(audio, timeBus, inputs, palettes);
    const chain = new ChainHost(() => effectsLib);
    chain.seed([{ effect }]);
    const folded = chain.fold(ctx, texNode(vec4(texture(e.target.texture).rgb, 1)));
    ctx.finalize();
    preview = new Instance(`fxpreview:${effect}`, ctx.manifest, ctx.updaters, folded.passes, folded.color);
  } catch (err) {
    outRT.dispose();
    throw new Error(`preview build failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    await new Promise<void>((resolve) => {
      pendingPreviews.push({
        run: (f) => {
          for (let i = 0; i < PREVIEW2_FRAMES; i++) preview.renderFrame(renderer, f, outRT);
        },
        done: resolve,
      });
    });
    return await readTargetToJpeg(outRT, PREVIEW2_W, PREVIEW2_H);
  } finally {
    preview.dispose();
    outRT.dispose();
  }
}

const readTargetToJpeg = (rt: RenderTarget, w: number, h: number): Promise<string> =>
  readTargetToDataUrl(renderer, rt, w, h);
const stage = new Stage();
const compositor = new Compositor(RENDER_W, RENDER_H);

// ---- Projects: set lists (serialized instance sets in content/state/projects/) ----
// ProjectsController owns the fetch/persist plumbing + deferred-cull bookkeeping
// over the tested ProjectStore. Save/load are explicit user actions, so they
// work regardless of ?state=off (which only disables AMBIENT persistence).
const projectsController = new ProjectsController({ session, stage, scenes: () => currentScenes() });

// ---- Fixtures: deterministic input traces (content/state/fixtures/) ----

/** A pending rack recording; frameTick appends one row per frame. */
let recording: {
  name: string;
  channels: string[];
  rows: number[][];
  remaining: number;
  resolve: (r: { saved: string; path: string; frames: number; channels: string[]; bpm: number }) => void;
  reject: (e: Error) => void;
} | null = null;

const fixturesApi = {
  record(name: string, frames: number) {
    if (recording != null) throw new Error("a fixture recording is already in flight");
    const channels = Object.keys(inputs.values());
    if (channels.length === 0) throw new Error("the input rack has no channels to record");
    return new Promise<{ saved: string; path: string; frames: number; channels: string[]; bpm: number }>(
      (resolve, reject) => {
        recording = { name, channels, rows: [], remaining: frames, resolve, reject };
      },
    );
  },
  async load(name: string): Promise<FixtureData> {
    const res = await fetch(`/loom/state/${StateDir.fixtures}/${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error(`unknown fixture "${name}" — record one with record_fixture`);
    const parsed = FixtureDataSchema.safeParse(await res.json());
    if (!parsed.success) throw new Error(`fixture "${name}" is corrupt: ${parsed.error.message}`);
    return parsed.data;
  },
  /**
   * Deterministic offline pass: rebuild the entry's scene against its trace on
   * a virtual clock (frame 0, dt 1/60, own TimeBus at the trace's BPM, silent
   * audio), mirror its tuned values + chains + modulators, step to each
   * requested frame and read the pixels back. Same fixture + frames →
   * identical bytes, independent of wall time and the live loop.
   */
  async shots(entryId: string, frameList: number[]) {
    const e = session.require(entryId);
    if (e.fixture == null) throw new Error(`"${entryId}" replays no fixture`);
    const data = e.fixture.data;
    const player = new FixturePlayer(data, 0);
    const vTime = new TimeBus(data.bpm);
    const silentAudio: AudioBusLike = {
      rms: new Signal(() => 0),
      band: () => new Signal(() => 0),
      onset: () => new Events(() => []),
    };
    // Mirror the entry's current chain knobs into the chain data, then fold the
    // same chains into the throwaway build.
    e.chain.captureValues(e.instance.manifest);
    for (const h of e.nodeChains.values()) h.captureValues(e.instance.manifest);
    const throwaway = buildInstance(
      e.def,
      { audio: silentAudio, time: vTime, inputs: player, palettes },
      (ctx, tex) => e.chain.fold(ctx, tex),
      { foldNode: (ctx, node, tex) => e.nodeChains.get(node)?.fold(ctx, tex) ?? tex },
    );
    const mods = new ModulatorHost({ bpm: () => vTime.bpm, audio: silentAudio });
    try {
      // Mirror live values (incl. chain knobs) and modulator specs.
      for (const [path, v] of Object.entries(e.instance.manifest.values())) {
        try {
          throwaway.manifest.get(path)?.set(v);
        } catch {
          // value doesn't fit (shouldn't happen — same def) — keep default
        }
      }
      for (const m of e.modulators.list()) {
        if (m.error != null) continue;
        try {
          mods.attach(throwaway.manifest, m.path, m.spec);
        } catch {
          // spec no longer fits — skip for the offline pass
        }
      }
      const want = [...new Set(frameList)].sort((a, b) => a - b);
      const rts = new Map(want.map((i) => [i, new RenderTarget(PREVIEW_W, PREVIEW_H)]));
      const scratch = new RenderTarget(PREVIEW_W, PREVIEW_H);
      try {
        const DT = 1 / 60;
        const liveTarget = renderer.getRenderTarget();
        for (let i = 0; i <= want[want.length - 1]!; i++) {
          const f: FrameCtx = { frame: i, now: i * DT, dt: DT };
          vTime.tick(f);
          mods.tick(throwaway.manifest, f);
          // Bind the destination BEFORE the passes run: destination-sized
          // stateful passes (render3d, transform, layer rigs) read the current
          // target to size their buffers — leaving the live loop's last target
          // bound made that size (and the pixels) nondeterministic.
          const dest = rts.get(i) ?? scratch;
          renderer.setRenderTarget(dest);
          throwaway.renderFrame(renderer, f, dest);
          if (throwaway.error != null) {
            throw new Error(`offline render froze at frame ${i}: ${String(throwaway.error)}`);
          }
        }
        renderer.setRenderTarget(liveTarget);
        const shots = [];
        for (const i of want) {
          const url = await readTargetToDataUrl(renderer, rts.get(i)!, PREVIEW_W, PREVIEW_H, {
            mime: "image/png",
          });
          shots.push({
            frame: i,
            mime: "image/png" as const,
            base64: url.slice(url.indexOf(",") + 1),
            width: PREVIEW_W,
            height: PREVIEW_H,
          });
        }
        return shots;
      } finally {
        for (const rt of rts.values()) rt.dispose();
        scratch.dispose();
      }
    } finally {
      throwaway.dispose();
    }
  },
};

async function finishRecording(r: NonNullable<typeof recording>): Promise<void> {
  const data: FixtureData = { name: r.name, bpm: timeBus.bpm, channels: r.channels, frames: r.rows };
  try {
    const res = await fetch(`/loom/state/${StateDir.fixtures}/${encodeURIComponent(r.name)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`fixture save failed (${res.status})`);
    r.resolve({
      saved: r.name,
      path: repoStatePath(fixtureKey(r.name)),
      frames: r.rows.length,
      channels: r.channels,
      bpm: data.bpm,
    });
  } catch (err) {
    r.reject(err instanceof Error ? err : new Error(String(err)));
  }
}

void projectsController.list();

// The barrel binding goes stale when ./scenes hot-updates; HMR swaps it below.
let currentScenes = getScenes;

/**
 * The instance that tracks live.scene.ts. It boots as "boot" but the human
 * can rename it (the engine-api rename hook keeps this pointer current) —
 * "live" is an alias for whatever the Stage routes to output, not an id.
 */
let bootId = "boot";

/**
 * NFR-5 for the boot instance: build the new one first; a failed
 * build/rebuild keeps whatever is running — never go black.
 */
function trySwapLive(def: SceneDef): boolean {
  if (session.get(bootId)) return session.rebuild(bootId, def);
  try {
    session.create(def, bootId);
    if (stage.live === null) stage.adoptLive(bootId);
    return true;
  } catch (err) {
    console.error(`[loom] scene "${def?.name ?? "?"}" rejected; keeping previous`, err);
    return false;
  }
}

// The always-warm Panic Scene instance (FR-3/FR-7): built at boot next to the
// boot instance, rebuilt through HMR, never disposed. PanicController owns the
// warm-instance lifecycle, the SAFE designation, and build-health reporting.
const panicController = new PanicController({
  session,
  persistPanicScene: () => persist.panicScene(),
  initialSceneName: panicScene?.name ?? "panic",
});

async function startAudio(): Promise<void> {
  if (qs.get("audio") === "test") {
    audio.startTest(timeBus.bpm);
    return;
  }
  try {
    await audio.startMic();
  } catch (err) {
    console.warn("[loom] mic unavailable; falling back to test signal", err);
    audio.startTest(timeBus.bpm);
  }
}

await renderer.init();
// updateStyle=false: CSS owns the canvas's on-screen size (object-fit: cover).
renderer.setSize(RENDER_W, RENDER_H, false);
await startAudio();

// Tuned state (R6.2): globals tunings, MIDI bindings, and per-scene values
// load before the boot instance builds so it comes up already tuned.
let savedPanicScene: string | null = null;
if (state.enabled) {
  // Range overrides load BEFORE values so a widened bound is in place to hold a
  // value persisted outside the declared range.
  const savedInputRanges = await state.load(StateKey.inputRanges);
  if (savedInputRanges && typeof savedInputRanges === "object") {
    inputs.manifest.applyRanges(savedInputRanges as Record<string, unknown>);
  }
  const savedGlobals = await state.load(StateKey.inputs);
  if (savedGlobals && typeof savedGlobals === "object") {
    for (const [path, v] of Object.entries(savedGlobals as Record<string, number | boolean>)) {
      try {
        inputs.manifest.get(path)?.set(v);
      } catch {
        // corrupt entry — keep the default
      }
    }
  }
  // Color decompositions load BEFORE values so the channel params exist to
  // receive their saved channel values (R7.4).
  const savedPaletteSpaces = await state.load(StateKey.paletteSpaces);
  if (savedPaletteSpaces && typeof savedPaletteSpaces === "object") {
    palettes.manifest.applyColorSpaces(savedPaletteSpaces as Record<string, unknown>);
  }
  const savedPalettes = await state.load(StateKey.palettes);
  if (savedPalettes && typeof savedPalettes === "object") {
    for (const [path, v] of Object.entries(savedPalettes as Record<string, unknown>)) {
      try {
        palettes.manifest.get(path)?.set(v as never);
      } catch {
        // corrupt entry — keep the default
      }
    }
  }
  // Re-attach channel modulators last (their target channels now exist).
  const savedPaletteMods = await state.load(StateKey.paletteMods);
  if (Array.isArray(savedPaletteMods)) {
    for (const m of savedPaletteMods as Array<{ path?: unknown; spec?: unknown; enabled?: unknown }>) {
      if (typeof m.path !== "string") continue;
      try {
        globalsModulators.attach(palettes.manifest, m.path, m.spec);
        if (m.enabled === false) globalsModulators.setEnabled(m.path, false);
      } catch {
        // channel gone or bad spec — drop it
      }
    }
  }
  bindings.load(await state.load(StateKey.bindings));
  for (const scene of currentScenes().keys()) {
    const vals = await state.load(StateKey.sceneValues(scene));
    if (vals && typeof vals === "object") {
      tunedValues.set(scene, vals as Record<string, number | boolean | string>);
    }
    const ranges = await state.load(StateKey.sceneRanges(scene));
    if (ranges && typeof ranges === "object") {
      tunedRanges.set(scene, ranges as Record<string, [number, number]>);
    }
    const spaces = await state.load(StateKey.sceneColorSpaces(scene));
    if (spaces && typeof spaces === "object") {
      tunedColorSpaces.set(scene, spaces as Record<string, "hsv" | "rgb">);
    }
  }
  const savedPanic = await state.load(StateKey.panic);
  const name = (savedPanic as { scene?: unknown } | null)?.scene;
  if (typeof name === "string") savedPanicScene = name;
}

// Audio input devices, cached for the (synchronous) session snapshot.
let audioDevices: Array<{ id: string; label: string }> = [];
async function refreshAudioDevices(): Promise<void> {
  const devices = await audio.listInputDevices();
  audioDevices = devices.map((d, i) => ({ id: d.deviceId, label: d.label || `input ${i + 1}` }));
}
void refreshAudioDevices();
navigator.mediaDevices?.addEventListener("devicechange", () => void refreshAudioDevices());

const debugOnsets = audio.onset({ band: "bass", threshold: 0.22 });
let onsetCount = 0;
let latestFrame: FrameCtx = { frame: 0, now: 0, dt: 0 };
let currentMix: number | null = null;
let lastDirectiveHold = false;

// Screenshot requests for the canvas resolve inside the render loop: the
// drawing buffer is only readable in the same task that rendered it.
const pendingShots: Array<{
  resolve: (s: ScreenshotResult) => void;
  reject: (e: Error) => void;
}> = [];

window.__loom = {
  sceneName: null,
  audioMode: audio.mode,
  bpm: timeBus.bpm,
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
  panicScene: panicController.info(),
  agentCommitArmed: false,
  instances: [],
  inputs: {},
  palettes: {},
  midiInject: (cc, ch, value01) => midi.inject(cc, ch, value01),
  resumeAudio: () => audio.resume(),
};

trySwapLive(liveScene);
// Build the warm panic instance alongside boot. A throw here leaves it in
// hold-fallback (FR-7) rather than failing the engine.
panicController.tryBuild(panicScene);
// A persisted runtime pick overrides the panic.scene.ts boot default.
if (savedPanicScene && savedPanicScene !== panicController.sceneName && currentScenes().has(savedPanicScene)) {
  panicController.tryBuild(currentScenes().get(savedPanicScene)!);
}

const api = new EngineApi(
  {
    renderer,
    canvas,
    session,
    stage,
    audio,
    time: timeBus,
    getScenes: () => currentScenes(),
    availableEffects: () => effectsLib.describe(),
    saveEffectChain,
    previewEffect,
    latestFrame: () => latestFrame,
    captureCanvas: () =>
      new Promise((resolve, reject) => {
        if (lastDirectiveHold) {
          reject(new Error("output is held (PANIC) — resume before taking a live screenshot"));
          return;
        }
        pendingShots.push({ resolve, reject });
      }),
    fps: () => fps.current,
    rms: () => window.__loom?.rms ?? 0,
    onsetCount: () => onsetCount,
    currentMix: () => currentMix,
    panicInstanceId: () => panicController.instanceId(),
    panicScene: () => panicController.info(),
    setPanicInstance: (id) => panicController.setInstance(id),
    audioDevices: () => audioDevices,
    refreshAudioDevices: () => void refreshAudioDevices(),
    inputs,
    palettes,
    globalsModulators,
    bindings,
    midiStatus: () => midi.status,
    midiDevices: () => midi.devices,
    midiRecent: () => midi.recent,
    persist,
    projects: projectsController,
    fixtures: fixturesApi,
    // live.scene.ts hot-swaps must keep landing on the boot instance even
    // after the human renames its tile.
    onInstanceRenamed: (from, to) => {
      if (bootId === from) bootId = to;
    },
  },
  // Agent commit defaults ARMED (the stage→commit ceremony was getting in the
  // way); ?agentCommit=0 restores the human gate, and the Console checkbox
  // disarms live either way.
  { agentCommitArmed: qs.get("agentCommit") !== "0" },
);

// MIDI action bindings step LIVE through the tiles — a physical button press
// is a human gesture, so this rides the human trust tier (no agent arming).
midiRouter.onAction = (path) => {
  if (path === "live.next") api.liveStep(1);
  else if (path === "live.prev") api.liveStep(-1);
};

// `?ws=` lets validation runs use an isolated sidecar port so they never
// collide with (or silently talk to) a live performance session's sidecar.
const stopBridge = startBridge(`ws://localhost:${Number(qs.get("ws")) || DEFAULT_WS_PORT}`, api);

// ?embedded=1 marks the Console's hidden-iframe engine (solo mode, no Output
// window). It stands down completely if a real Output engine appears.
const embedded = qs.get("embedded") === "1";
let yielded = false;
startConsoleChannel(api, {
  embedded,
  onYield: () => {
    yielded = true;
    renderer.setAnimationLoop(null);
    stopHiddenClock();
    stopBridge();
  },
});

const frameTick = (tMs: number): void => {
  if (yielded) return;
  const f = clock.tick(tMs);
  latestFrame = f;
  timeBus.tick(f);
  audio.update(f);
  inputs.update(f); // every channel advances even with zero consumers (R6.4)
  onsetCount += debugOnsets.poll(f).length;

  // Fixtures: append this frame's rack values to a pending recording.
  if (recording != null) {
    const vals = inputs.values();
    recording.rows.push(recording.channels.map((c) => vals[c] ?? 0));
    if (--recording.remaining <= 0) {
      const done = recording;
      recording = null;
      void finishRecording(done);
    }
  }

  const directive = stage.tick(f);
  currentMix = directive.mode === "crossfade" ? directive.mix : null;
  lastDirectiveHold = directive.mode === "hold";

  // Projects: a commit from the loaded set has landed (live, fade done) — cull
  // the replaced instances. Before the render, so a culled instance is never
  // referenced by this frame's directive (it can't be: it isn't live).
  projectsController.maybeCull();
  // Modulators write CPU-side before any leg renders. Hold pauses them all;
  // scene-panic pauses only the suspended live instance (FR-5/FR-10).
  if (directive.mode === "panic-scene") session.tickModulators(f, directive.live);
  else if (directive.mode !== "hold") session.tickModulators(f);
  // Global palette color-channel modulators (R7.4) write the stops before any
  // leg reads them; hold freezes their phase like instance modulators (FR-10).
  if (directive.mode !== "hold") globalsModulators.tick(palettes.manifest, f);
  compositor.render(renderer, f, directive, session);
  api.captureLiveMirror(directive.mode); // same-task canvas read for the live tile
  fps.tick();
  // Full-res preview overlay: resize the previewed sandbox target / mirror the
  // live canvas, and run the fps auto-reduction ladder (same task as the render).
  api.tickPreview(directive.mode, fps.current);

  if (pendingShots.length > 0) {
    const waiting = pendingShots.splice(0);
    if (directive.mode === "hold") {
      const e = new Error("output is held (PANIC)");
      for (const w of waiting) w.reject(e);
    } else {
      try {
        const url = canvas.toDataURL("image/png");
        const shot: ScreenshotResult = {
          mime: "image/png",
          base64: url.slice(url.indexOf(",") + 1),
          width: canvas.width,
          height: canvas.height,
          frame: f.frame,
          fps: fps.current,
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
  if (pendingPreviews.length > 0) {
    const job = pendingPreviews.shift()!;
    try {
      job.run(f);
    } catch {
      // a bad preview render must never break the live loop
    }
    job.done();
  }

  const liveEntry = stage.live != null ? session.get(stage.live) : undefined;
  const dbg = window.__loom!;
  dbg.sceneName = liveEntry?.sceneName ?? null;
  dbg.audioMode = audio.mode;
  dbg.bpm = timeBus.bpm;
  dbg.rms = audio.rms.get(f);
  dbg.onsetCount = onsetCount;
  dbg.instanceError = liveEntry?.instance.error != null ? String(liveEntry.instance.error) : null;
  dbg.frame = f.frame;
  dbg.fps = fps.current;
  dbg.clockSource = document.hidden ? "worker" : "raf"; // which clock drove this frame
  dbg.live = stage.live;
  dbg.staged = stage.staged;
  dbg.mix = currentMix;
  dbg.panicked = stage.panicked;
  dbg.panicMode = api.armedPanicMode;
  dbg.panicActive = stage.panicActive;
  dbg.panicScene = panicController.info();
  dbg.agentCommitArmed = api.agentCommitArmed;
  dbg.inputs = inputs.values();
  dbg.palettes = palettes.manifest.values();
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
};

let lastRafAt = performance.now();
renderer.setAnimationLoop((tMs) => {
  lastRafAt = performance.now();
  frameTick(tMs);
});

// Browsers freeze rAF in hidden tabs (and starve it for offscreen iframes),
// which used to freeze every Console preview whenever the Output tab wasn't
// showing. A worker clock (exempt from background timer throttling) keeps the
// engine ticking at ~30 fps whenever rAF isn't delivering; the moment rAF
// resumes, the starvation guard backs off so the two never double-step.
const stopHiddenClock = workerInterval(() => {
  if (document.hidden || performance.now() - lastRafAt > 150) frameTick(performance.now());
}, 33);

// Tap tempo on "t"; any click also unblocks a suspended AudioContext.
window.addEventListener("keydown", (e) => {
  if (e.key === "t") timeBus.tap(performance.now() / 1000);
});
window.addEventListener("pointerdown", () => {
  audio.resume();
  void ensureMidi(); // a real gesture can re-pop a dismissed MIDI prompt
});

if (import.meta.hot) {
  // Compile errors never reach these callbacks (Vite withholds the update);
  // build()-time throws are caught per instance; render-time throws freeze
  // the instance (NFR-2). All three keep the previous pixels alive.
  import.meta.hot.accept("../../../content/scenes/live.scene", (mod) => {
    if (!mod?.default) {
      console.warn("[loom] hot update carried no scene default export; keeping previous");
      return;
    }
    const ok = trySwapLive(mod.default as SceneDef);
    console.info(
      ok
        ? `[loom] scene hot-swapped: ${session.get(bootId)?.sceneName}`
        : "[loom] scene rejected; previous still live",
    );
  });

  // The input rack hot-reloads like scenes: a bad inputs.ts is rejected and
  // the previous rack (with its tunings and detector state) keeps running.
  import.meta.hot.accept("../../../content/inputs", (mod) => {
    if (!mod?.default) {
      console.warn("[loom] inputs hot update carried no default export; keeping previous rack");
      return;
    }
    const ok = tryDefineInputs(mod.default as InputsDef);
    console.info(ok ? "[loom] input rack redefined" : "[loom] inputs.ts rejected; previous rack still active");
  });

  // Any scene file edit bubbles through the barrel: rebuild only instances
  // whose def identity actually changed (NFR-5), destroy ones whose scene file
  // vanished. The warm panic instance rebuilds here by name like any other
  // (so editing whichever scene is the safe target hot-reloads it), but is
  // never destroyed — the escape hatch must stay warm.
  import.meta.hot.accept("./scenes", (mod) => {
    if (!mod?.getScenes) return;
    currentScenes = mod.getScenes as typeof getScenes;
    const map = currentScenes();
    for (const entry of [...session.entries.values()]) {
      if (entry.id === bootId) continue; // owned by the live.scene accept above
      const def = map.get(entry.sceneName);
      if (!def) {
        if (entry.pinned === "panic") continue; // keep the hatch warm
        console.warn(`[loom] scene "${entry.sceneName}" removed; destroying instance "${entry.id}"`);
        stage.onInstanceDestroyed(entry.id);
        session.destroy(entry.id);
      } else if (def !== entry.def) {
        const ok = session.rebuild(entry.id, def);
        if (entry.pinned === "panic") panicController.noteSafeRebuild(ok, def);
        console.info(
          ok
            ? `[loom] instance "${entry.id}" rebuilt (${def.name})`
            : `[loom] instance "${entry.id}" rejected the update; previous still running`,
        );
      }
    }
  });

  // The effect library hot-reloads like scenes: an edited effect or a newly
  // saved chain (content/modules/effects/**) re-globs through this barrel, so
  // the "+ effect" picker and future folds see it without a reload. Live chains
  // keep running on the old code until their next rebuild (NFR-5 unchanged).
  import.meta.hot.accept("./effects", (mod) => {
    if (!mod?.getEffectLibrary) return;
    effectsLib = (mod.getEffectLibrary as typeof getEffectLibrary)();
    console.info("[loom] effect library reloaded");
  });
}
