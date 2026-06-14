// @vitest-environment happy-dom
import {
  BindingStore,
  defineModule,
  defineScene,
  Events,
  InputRegistry,
  ModulatorHost,
  PaletteRegistry,
  Signal,
  Stage,
  texNode,
  TimeBus,
  type AudioBusLike,
  type BuildCtx,
  type EffectRegistry,
  type PrimitiveEffectEntry,
  type TexNode,
} from "@loom/runtime";
import { vec4 } from "three/tsl";
import { describe, expect, it } from "vitest";
import { EngineApi, type EngineDeps } from "../src/engine-api";
import { SessionStore } from "../src/session";

/** The audience-safety gates and state serialization EngineApi owns — the
 * highest-value logic that previously had NO unit coverage (validators only
 * exercise the happy paths). */

const silentAudio: AudioBusLike & { mode: string; startMic(): Promise<void>; startTest(): void } = {
  rms: new Signal(() => 0),
  band: () => new Signal(() => 0),
  onset: () => new Events(() => []),
  mode: "test",
  startMic: () => Promise.resolve(),
  startTest: () => {},
};

const passInput = defineModule(
  { name: "glitch", kind: "effect", description: "x" },
  (_c: BuildCtx, opts: { input: TexNode }) => opts.input,
);
const glitch: PrimitiveEffectEntry = { name: "glitch", kind: "primitive", chainParams: [], factory: passInput };
const boom: PrimitiveEffectEntry = {
  name: "boom",
  kind: "primitive",
  chainParams: [],
  factory: defineModule({ name: "boom", kind: "effect", description: "x" }, () => {
    throw new Error("kaboom");
  }),
};
const registry: EffectRegistry = {
  get: (n) => (n === "glitch" ? glitch : n === "boom" ? boom : undefined),
  names: () => ["glitch", "boom"],
};

const scene = defineScene({
  name: "apitest",
  description: "engine-api test fixture",
  build(ctx) {
    ctx.float("speed", { default: 0.5, min: 0, max: 1 });
    ctx.bool("flag", { default: false });
    return ctx.layer("logo", texNode(vec4(0, 0, 0, 1)));
  },
});

function world() {
  const time = new TimeBus(120);
  const inputs = new InputRegistry({ audio: silentAudio });
  const palettes = new PaletteRegistry();
  const globalsModulators = new ModulatorHost({ bpm: () => time.bpm, audio: silentAudio });
  const session = new SessionStore({ audio: silentAudio, time, inputs, palettes }, () => registry);
  const stage = new Stage();
  const bindings = new BindingStore();
  const scenes = new Map([[scene.name, scene]]);
  const deps: EngineDeps = {
    renderer: {} as never,
    canvas: document.createElement("canvas"),
    session,
    stage,
    audio: silentAudio,
    time,
    inputs,
    palettes,
    globalsModulators,
    bindings,
    midiStatus: () => "off",
    midiDevices: () => [],
    midiRecent: () => [],
    persist: { globals() {}, palettes() {}, scene() {}, bindings() {} },
    audioDevices: () => [],
    refreshAudioDevices: () => {},
    getScenes: () => scenes,
    availableEffects: () => [{ name: "glitch", kind: "primitive" }],
    saveEffectChain: () => Promise.resolve({ path: "x" }),
    previewEffect: () => Promise.resolve("data:"),
    latestFrame: () => ({ frame: 0, now: 0, dt: 1 / 60 }),
    captureCanvas: () => Promise.reject(new Error("no canvas in tests")),
    fps: () => 60,
    rms: () => 0,
    onsetCount: () => 0,
    currentMix: () => null,
    panicInstanceId: () => null,
    panicScene: () => ({ name: "panic", status: "error", error: "none" }),
    setPanicInstance: () => {},
    fixtures: {
      record: () => Promise.reject(new Error("unused")),
      load: () => Promise.reject(new Error("unused")),
      shots: () => Promise.reject(new Error("unused")),
    },
    projects: {
      list: () => Promise.resolve([]),
      cached: () => [],
      save: () => Promise.reject(new Error("unused")),
      load: () => Promise.reject(new Error("unused")),
    },
  };
  const api = new EngineApi(deps, { agentCommitArmed: false });
  return { api, session, stage, bindings, deps };
}

const req = (type: string, args: Record<string, unknown> = {}) => ({
  id: "t",
  kind: "req" as const,
  type: type as never,
  args,
});

describe("EngineApi audience-safety gates", () => {
  it("agent set_chain on the LIVE chain throws unless armed; sandbox stays ungated", async () => {
    const { api, session, stage } = world();
    session.create(scene, "boot");
    stage.adoptLive("boot");
    session.create(scene, "sandbox");

    await expect(
      api.handleRequest(req("set_chain", { instance: "boot", steps: [{ effect: "glitch" }] }), "agent"),
    ).rejects.toThrow(/arming|arm agent commit/);
    // Humans are never gated; agent edits to a SANDBOX are free.
    await api.handleRequest(req("set_chain", { instance: "boot", steps: [{ effect: "glitch" }] }), "human");
    await api.handleRequest(req("set_chain", { instance: "sandbox", steps: [{ effect: "glitch" }] }), "agent");
    // Arming opens the live gate.
    api.agentCommitArmed = true;
    await api.handleRequest(req("set_chain", { instance: "boot", steps: [] }), "agent");
  });

  it("agent commit is gated; human-only verbs reject agents outright", async () => {
    const { api, session, stage } = world();
    session.create(scene, "boot");
    stage.adoptLive("boot");
    session.create(scene, "next");
    stage.stage("next");
    await expect(api.handleRequest(req("commit"), "agent")).rejects.toThrow(/not armed/);
    await expect(api.handleRequest(req("set_audio", { mode: "test" }), "agent")).rejects.toThrow(/human-only/);
    await expect(api.handleRequest(req("panic"), "agent")).rejects.toThrow(/human-only/);
  });

  it("a throwing chain step is rejected and the previous chain + instance survive (NFR-5)", async () => {
    const { api, session } = world();
    const e = session.create(scene, "sandbox");
    await api.handleRequest(req("set_chain", { instance: "sandbox", steps: [{ effect: "glitch" }] }), "agent");
    const instanceBefore = e.instance;
    const stepsBefore = e.chain.list().map((s) => s.id);
    await expect(
      api.handleRequest(req("set_chain", { instance: "sandbox", steps: [{ effect: "boom" }] }), "agent"),
    ).rejects.toThrow(/rejected/);
    expect(e.instance).toBe(instanceBefore); // old pixels keep running
    expect(e.chain.list().map((s) => s.id)).toEqual(stepsBefore);
    expect(e.builds).toBe(2); // create + the one good chain edit, not the bad one
  });

  it("rename refuses reserved names and protects the live instance alias", async () => {
    const { api, session, stage } = world();
    session.create(scene, "boot");
    stage.adoptLive("boot");
    for (const to of ["live", "globals", "actions"]) {
      await expect(api.handleRequest(req("rename_instance", { instance: "boot", to }), "human")).rejects.toThrow(
        /reserved/,
      );
    }
    const r = (await api.handleRequest(req("rename_instance", { instance: "boot", to: "deckA" }), "human")) as {
      instance: string;
    };
    expect(r.instance).toBe("deckA");
    expect(stage.live).toBe("deckA"); // the stage pointer followed the rename
  });
});

describe("EngineApi full-res preview stream", () => {
  it("is human-only and resolves the live alias", async () => {
    const { api, session, stage } = world();
    session.create(scene, "boot");
    stage.adoptLive("boot");
    await expect(api.handleRequest(req("set_preview", { instance: "boot" }), "agent")).rejects.toThrow(
      /human-only/,
    );
    api.markConsolePresent();
    const r = (await api.handleRequest(req("set_preview", { instance: "live" }), "human")) as {
      preview: { id: string } | null;
    };
    expect(r.preview?.id).toBe("boot"); // "live" resolved to the live instance
  });

  it("renders a sandbox candidate at the chosen resolution and restores on stop", async () => {
    const { api, session, stage } = world();
    session.create(scene, "boot");
    stage.adoptLive("boot");
    const e = session.create(scene, "sandbox");
    expect([e.target.width, e.target.height]).toEqual([640, 360]); // the thumbnail size

    api.markConsolePresent();
    await api.handleRequest(req("set_preview", { instance: "sandbox", maxHeight: 1080 }), "human");
    api.tickPreview("single", 60);
    expect([e.target.width, e.target.height]).toEqual([1920, 1080]); // full-res render now

    // A lower ceiling re-sizes; the live instance is never enlarged (it renders
    // to the canvas, so its target stays at the thumbnail size).
    await api.handleRequest(req("set_preview", { instance: "sandbox", maxHeight: 720 }), "human");
    api.tickPreview("single", 60);
    expect([e.target.width, e.target.height]).toEqual([1280, 720]);

    await api.handleRequest(req("set_preview", { instance: null }), "human");
    expect([e.target.width, e.target.height]).toEqual([640, 360]); // restored
  });

  it("leaves the live instance's target untouched (canvas-mirrored, not enlarged)", async () => {
    const { api, session, stage } = world();
    const e = session.create(scene, "boot");
    stage.adoptLive("boot");
    api.markConsolePresent();
    await api.handleRequest(req("set_preview", { instance: "boot", maxHeight: 1080 }), "human");
    api.tickPreview("single", 60);
    expect([e.target.width, e.target.height]).toEqual([640, 360]);
  });

  it("auto-reduces the resolution when fps sags and climbs back when it recovers", async () => {
    const { api, session, stage } = world();
    session.create(scene, "boot");
    stage.adoptLive("boot");
    const e = session.create(scene, "sandbox");
    api.markConsolePresent();
    await api.handleRequest(req("set_preview", { instance: "sandbox", maxHeight: 1080 }), "human");

    const sag = (n: number, fps: number) => {
      for (let i = 0; i < n; i++) api.tickPreview("single", fps);
    };
    sag(25, 30); // sustained low fps → drop one level
    expect(e.target.height).toBe(720);
    sag(25, 30); // keep sagging → drop another
    expect(e.target.height).toBe(540);
    sag(260, 60); // sustained headroom → climb one level back
    expect(e.target.height).toBe(720);
    // Never climbs past the human-chosen ceiling.
    sag(520, 60);
    expect(e.target.height).toBe(1080);
    sag(260, 60);
    expect(e.target.height).toBe(1080);
  });
});

describe("EngineApi set_params (batched param writes)", () => {
  it("applies every good path, persists once, and reports bad paths without dropping the rest", async () => {
    const { api, session } = world();
    const e = session.create(scene, "sandbox");
    e.modulators.attach(e.instance.manifest, "speed", { type: "sine", periodSeconds: 2 });

    const res = (await api.handleRequest(
      req("set_params", { instance: "sandbox", values: { flag: true, speed: 0.9, nope: 1 } }),
      "agent",
    )) as { instance: string; set: Array<{ path: string; value: unknown }>; errors: Array<{ path: string; error: string }> };

    expect(res.instance).toBe("sandbox");
    expect(res.set).toEqual([{ path: "flag", value: true }]); // speed is modulated, nope is unknown
    const byPath = Object.fromEntries(res.errors.map((x) => [x.path, x.error]));
    expect(byPath.speed).toMatch(/modulated/);
    expect(byPath.nope).toMatch(/unknown param/);
    expect(e.instance.manifest.get("flag")!.value).toBe(true);
  });
});

describe("EngineApi batch", () => {
  it("runs calls serially, re-applies per-call gates, and reports each result", async () => {
    const { api, session, stage } = world();
    session.create(scene, "boot");
    stage.adoptLive("boot");

    const res = (await api.handleRequest(
      req("batch", {
        calls: [
          { tool: "set_params", args: { instance: "boot", values: { flag: true } } },
          { tool: "set_chain", args: { instance: "boot", steps: [{ effect: "glitch" }] } }, // LIVE chain, unarmed → gated
          { tool: "get_session" },
        ],
      }),
      "agent",
    )) as { mode: string; results: Array<{ ok: boolean; tool: string; error?: string }> };

    expect(res.mode).toBe("serial");
    expect(res.results[0]).toMatchObject({ ok: true, tool: "set_params" });
    expect(res.results[1]!.ok).toBe(false); // arming gate still fires inside the batch
    expect(res.results[1]!.error).toMatch(/arming|arm agent commit/);
    expect(res.results[2]).toMatchObject({ ok: true, tool: "get_session" });
  });

  it("rejects nested batch and honors stopOnError", async () => {
    const { api, session } = world();
    session.create(scene, "sandbox");

    const nested = (await api.handleRequest(
      req("batch", { calls: [{ tool: "batch", args: { calls: [{ tool: "get_session" }] } }] }),
      "agent",
    )) as { results: Array<{ ok: boolean; error?: string }> };
    expect(nested.results[0]).toMatchObject({ ok: false });
    expect(nested.results[0]!.error).toMatch(/cannot nest/);

    const stopped = (await api.handleRequest(
      req("batch", {
        stopOnError: true,
        calls: [
          { tool: "set_param", args: { instance: "sandbox", path: "nope", value: 1 } }, // throws
          { tool: "get_session" }, // must NOT run
        ],
      }),
      "agent",
    )) as { results: unknown[] };
    expect(stopped.results).toHaveLength(1);
  });
});

describe("EngineApi MIDI target resolution", () => {
  it("resolves an instance to its scene, rejects set-bindings on bool params and unknown actions", async () => {
    const { api, session, bindings } = world();
    session.create(scene, "boot");

    await api.handleRequest(req("midi_learn", { instance: "boot", path: "speed" }), "human");
    expect(bindings.learning?.scene).toBe("apitest"); // durable scene key, not the instance id

    await expect(
      api.handleRequest(req("midi_learn", { instance: "boot", path: "flag", mode: "set", value: 1 }), "human"),
    ).rejects.toThrow(/bool/);
    await expect(
      api.handleRequest(req("midi_learn", { instance: "actions", path: "live.sideways" }), "human"),
    ).rejects.toThrow(/unknown action/);
    await expect(
      api.handleRequest(req("midi_learn", { instance: "boot", path: "nope" }), "human"),
    ).rejects.toThrow(/unknown param/);
  });
});

describe("EngineApi global palette color channels (R7.4)", () => {
  it("decomposes a stop, modulates a channel, and guards manual set", async () => {
    const { api, deps } = world();

    // Expand primary stop 0 into HSV channels.
    const res = (await api.handleRequest(
      req("set_color_space", { instance: "globals", path: "palette.primary.0", space: "hsv" }),
      "human",
    )) as { added: string[]; removed: string[] };
    expect(res.added).toEqual(["palette.primary.0.h", "palette.primary.0.s", "palette.primary.0.v"]);
    expect(deps.palettes.manifest.get("palette.primary.0.h")).toBeDefined();

    // The globals manifest reports the decomposition + channel params.
    const man = (await api.handleRequest(
      req("get_manifest", { instance: "globals" }),
      "agent",
    )) as { params: Record<string, { type: string; colorSpace?: string; channelOf?: string }> };
    expect(man.params["palette.primary.0"]!.colorSpace).toBe("hsv");
    expect(man.params["palette.primary.0.v"]!.channelOf).toBe("palette.primary.0");

    // The bare stop (still a color) can't be modulated; only its channels.
    await expect(
      api.handleRequest(
        req("modulate_param", { instance: "globals", path: "palette.primary.0", modulator: { type: "sine", periodSeconds: 2 } }),
        "agent",
      ),
    ).rejects.toThrow(/expand a palette stop/);

    // The channel modulates, and manual set is then guarded.
    await api.handleRequest(
      req("modulate_param", { instance: "globals", path: "palette.primary.0.v", modulator: { type: "sine", periodSeconds: 2 } }),
      "agent",
    );
    expect(deps.globalsModulators.active("palette.primary.0.v")).toBe(true);
    await expect(
      api.handleRequest(req("set_param", { instance: "globals", path: "palette.primary.0.v", value: 0.5 }), "agent"),
    ).rejects.toThrow(/modulated/);

    // Collapsing back to hex removes the channels and clears the modulator.
    const back = (await api.handleRequest(
      req("set_color_space", { instance: "globals", path: "palette.primary.0", space: "hex" }),
      "human",
    )) as { removed: string[] };
    expect(back.removed).toContain("palette.primary.0.v");
    expect(deps.palettes.manifest.get("palette.primary.0.v")).toBeUndefined();
    expect(deps.globalsModulators.get("palette.primary.0.v")).toBeUndefined();
  });
});

describe("EngineApi state serialization", () => {
  it("snapshot carries the full per-instance shape", async () => {
    const { api, session, stage } = world();
    const e = session.create(scene, "boot");
    stage.adoptLive("boot");
    e.modulators.attach(e.instance.manifest, "speed", { type: "sine", periodSeconds: 2 });
    session.setChain("boot", [{ effect: "glitch" }], "logo");

    const s = api.snapshot();
    const inst = s.instances.find((i) => i.id === "boot")!;
    expect(inst.scene).toBe("apitest");
    expect(inst.status).toBe("ok");
    expect(inst.paramPaths).toContain("logo.layer.scale");
    expect(inst.modulators[0]).toMatchObject({ path: "speed", type: "sine", error: null });
    expect(inst.nodes[0]).toMatchObject({ id: "logo", parent: null });
    expect(inst.nodes[0]!.chain[0]!.effect).toBe("glitch");
    expect(typeof inst.frameMs).toBe("number");
    expect(inst.fixture).toBeNull();
    expect(s.live).toBe("boot");
  });

  it("liveStep wraps the healthy deck ring, skips pinned reserves, and is mash-safe mid-fade", () => {
    const { api, session, stage, deps } = world();
    session.create(scene, "a");
    stage.adoptLive("a");
    session.create(scene, "b");
    const p = session.create(scene, "warm");
    p.pinned = "panic";

    api.liveStep(1); // a -> b (the pinned reserve is not part of the ring)
    // liveStep commits with a 60-frame fade; finish it so live resolves.
    for (let i = 1; i <= 61; i++) stage.tick({ frame: i, now: i / 60, dt: 1 / 60 });
    expect(stage.live).toBe("b");

    api.liveStep(1); // starts the fade back to a...
    expect(stage.fading).toBe(true);
    api.liveStep(1); // ...and a mid-fade mash is ignored
    expect(stage.staged).toBe("a");
    void deps;
  });

  it("the live_step command steps LIVE for humans and rejects agents", async () => {
    const { api, session, stage } = world();
    session.create(scene, "a");
    stage.adoptLive("a");
    session.create(scene, "b");

    // Human Console button: stages the neighbor and reports the move.
    const res = (await api.handleRequest(req("live_step", { dir: 1 }), "human")) as {
      dir: number;
      from: string | null;
      live: string | null;
    };
    expect(res).toMatchObject({ dir: 1, from: "a" });
    for (let i = 1; i <= 61; i++) stage.tick({ frame: i, now: i / 60, dt: 1 / 60 });
    expect(stage.live).toBe("b");

    // Stage navigation is a performance gesture — human-only, like panic.
    await expect(api.handleRequest(req("live_step", { dir: -1 }), "agent")).rejects.toThrow(/human-only/);
  });
});
