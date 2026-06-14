import {
  AudioBus,
  BindingStore,
  BuildCtx,
  ChainHost,
  Clock,
  InputRegistry,
  isFxPath,
  Instance,
  MidiBus,
  ModulatorHost,
  PaletteRegistry,
  Stage,
  texNode,
  TimeBus,
  type InputsDef,
  type SceneDef,
} from "@loom/runtime";
import { DEFAULT_WS_PORT } from "@loom/sidecar/protocol";
import { texture, vec4 } from "three/tsl";
import { RenderTarget, WebGPURenderer } from "three/webgpu";
import inputsDef from "../../../content/inputs";
import liveScene from "../../../content/scenes/live.scene";
import { startBridge } from "./bridge";
import { Compositor } from "./compositor";
import { DebugSurface } from "./debug-surface";
import { ProjectsController } from "./projects-controller";
import { readTargetToDataUrl } from "./readback";
import { startConsoleChannel } from "./console-channel";
import { EngineApi } from "./engine-api";
import { FpsMeter } from "./fps";
import { getEffectLibrary } from "./effects";
import { FixtureService } from "./fixture-service";
import { MidiRouter } from "./midi-router";
import { PanicController } from "./panic-controller";
import { RenderService } from "./render-service";
import { getScenes } from "./scenes";
import { SessionStore } from "./session";
import { StateClient, StateKey } from "./state";
import { workerInterval } from "./worker-clock";

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
      renderService.queuePreview({
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
// FixtureService owns recording the live rack (record + the per-frame
// recordFrame hook) and the deterministic offline pass (shots).
const fixtureService = new FixtureService({
  session,
  renderer,
  inputs,
  palettes,
  timeBus,
  readTargetToDataUrl,
});

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

// Scene-panic's SAFE-target designation (panic-safe-scene-redesign): there is
// no boot-default warm instance — scene-panic is opt-in. PanicController owns
// only the runtime ⛑ designation over existing instances and its health surface.
const panicController = new PanicController({ session });

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

/**
 * Load persisted tuned state (R6.2) into the registries/maps. The intra-step
 * ordering is load-bearing and documented inline: ranges before values, color
 * decompositions before palette values, channel modulators last (their targets
 * must exist first). The SAFE-target designation is deliberately NOT persisted
 * (panic-safe-scene-redesign NFR-2): a fresh session boots to hold.
 */
async function loadPersistedState(): Promise<void> {
  if (!state.enabled) return;
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
}

// ============================ BOOT SEQUENCE ============================
// Explicit, ordered boot — each phase depends on the prior. Everything above is
// construction (surfaces, buses, registries, services, the persist/HMR wiring);
// from here the engine comes online in a fixed order.

// Boot 1 — bring the renderer + audio online.
await renderer.init();
// updateStyle=false: CSS owns the canvas's on-screen size (object-fit: cover).
renderer.setSize(RENDER_W, RENDER_H, false);
await startAudio();

// Boot 2 — load tuned state BEFORE the boot instance builds, so it comes up
// already tuned.
await loadPersistedState();

// Audio input devices, cached for the (synchronous) session snapshot.
let audioDevices: Array<{ id: string; label: string }> = [];
async function refreshAudioDevices(): Promise<void> {
  const devices = await audio.listInputDevices();
  audioDevices = devices.map((d, i) => ({ id: d.deviceId, label: d.label || `input ${i + 1}` }));
}
void refreshAudioDevices();
navigator.mediaDevices?.addEventListener("devicechange", () => void refreshAudioDevices());

// Boot 3 — install the debug surface, then build the boot + warm-panic instances.
const debugOnsets = audio.onset({ band: "bass", threshold: 0.22 });

// The window.__loom debug surface validators read; built + installed here,
// refreshed each frame by debug.update() (the heavy instances array throttled).
// `armed` reads the EngineApi, constructed just below — a getter, called only
// in-frame (after `api` exists).
const debug = new DebugSurface({
  audio,
  timeBus,
  fps,
  stage,
  session,
  inputs,
  palettes,
  midi,
  panicInfo: () => panicController.info(),
  armed: () => ({ panicMode: api.armedPanicMode, agentCommitArmed: api.agentCommitArmed }),
});

trySwapLive(liveScene);
// No boot-default safe scene (panic-safe-scene-redesign FR-1): PANIC boots armed
// hold; scene-panic becomes available once the human designates a SAFE target.

// Boot 4 — the render loop, the EngineApi, and the transports (bridge + console).
// The render loop owns the frame tick + loop-local state (latest frame, mix,
// onset count, screenshot/preview queues). Its api hooks (captureLiveMirror /
// tickPreview) read `api`, constructed just below — closures, called only
// in-frame. Started in Boot 5.
const renderService = new RenderService({
  renderer,
  canvas,
  clock,
  timeBus,
  audio,
  inputs,
  debugOnsets,
  fixtures: fixtureService,
  stage,
  projects: projectsController,
  session,
  globalsModulators,
  palettes,
  compositor,
  fps,
  debug,
  captureLiveMirror: (mode) => api.captureLiveMirror(mode),
  tickPreview: (mode, currentFps) => api.tickPreview(mode, currentFps),
  previewRoute: () => api.previewRoute(),
  mirrorPreviewCanvas: () => api.mirrorPreviewCanvas(),
  workerInterval,
});

// Explicitly typed to break the renderService ↔ api ↔ debug closure cycle
// (each references the others; one anchor type lets the rest infer).
const api: EngineApi = new EngineApi(
  {
    renderer,
    canvas,
    renderSize: { width: RENDER_W, height: RENDER_H },
    session,
    stage,
    audio,
    time: timeBus,
    getScenes: () => currentScenes(),
    availableEffects: () => effectsLib.describe(),
    saveEffectChain,
    previewEffect,
    latestFrame: () => renderService.latestFrame,
    captureCanvas: () => renderService.captureCanvas(),
    fps: () => fps.current,
    rms: () => window.__loom?.rms ?? 0,
    onsetCount: () => renderService.onsetCount,
    currentMix: () => renderService.currentMix,
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
    fixtures: fixtureService,
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
startConsoleChannel(api, {
  embedded,
  onYield: () => {
    renderService.stop();
    stopBridge();
  },
});

// Boot 5 — start the frame loop (rAF + the hidden-tab worker-clock fallback).
renderService.start();

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
  // vanished. A designated SAFE target is now an ordinary instance: editing its
  // scene hot-reloads it like any other, and if its scene file vanishes it is
  // destroyed — Stage's onInstanceDestroyed degrades an active scene-panic to
  // hold (FR-7), and PanicController.info() reverts to "none".
  import.meta.hot.accept("./scenes", (mod) => {
    if (!mod?.getScenes) return;
    currentScenes = mod.getScenes as typeof getScenes;
    const map = currentScenes();
    for (const entry of [...session.entries.values()]) {
      if (entry.id === bootId) continue; // owned by the live.scene accept above
      const def = map.get(entry.sceneName);
      if (!def) {
        console.warn(`[loom] scene "${entry.sceneName}" removed; destroying instance "${entry.id}"`);
        stage.onInstanceDestroyed(entry.id);
        session.destroy(entry.id);
      } else if (def !== entry.def) {
        const ok = session.rebuild(entry.id, def);
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
