import {
  defineModule,
  defineScene,
  Stage,
  texNode,
  type BuildCtx,
  type EffectRegistry,
  type FrameCtx,
  type PrimitiveEffectEntry,
  type TexNode,
} from "@loom/runtime";
import { vec4 } from "three/tsl";
import { describe, expect, it } from "vitest";
import { SessionStore } from "../src/session";
import { SessionSnapshot, type SessionData } from "../src/session-snapshot";
import { StateClient } from "../src/state";

const passInput = defineModule(
  { name: "glitch", kind: "effect", description: "x" },
  (_c: BuildCtx, opts: { input: TexNode }) => opts.input,
);
const glitch: PrimitiveEffectEntry = {
  name: "glitch",
  kind: "primitive",
  chainParams: [{ name: "amount", type: "float", default: 0.6, min: 0, max: 1 }],
  factory: passInput,
};
const registry: EffectRegistry = {
  get: (n) => (n === "glitch" ? glitch : undefined),
  names: () => ["glitch"],
};

const scene = defineScene({
  name: "snap-test",
  description: "session-restore fixture",
  build(ctx) {
    ctx.float("speed", { default: 0.1, min: 0, max: 1 });
    return ctx.layer("logo", texNode(vec4(0, 0, 0, 1)));
  },
});

function world() {
  const session = new SessionStore({ audio: {} as never, time: { bpm: 120 } as never }, () => registry);
  const stage = new Stage();
  const scenes = new Map([[scene.name, scene]]);
  // Persistence disabled — we drive serialize()/restore() directly (no fetch).
  const snap = new SessionSnapshot({ session, stage, scenes: () => scenes, state: new StateClient(false) });
  return { session, stage, scenes, snap };
}

const frame = (n: number): FrameCtx => ({ frame: n }) as never;

describe("SessionSnapshot", () => {
  it("serializes the full working set with the slot pointers", () => {
    const { session, stage, snap } = world();
    session.create(scene, "boot");
    stage.adoptLive("boot");
    const a = session.create(scene, "a");
    a.instance.manifest.get("speed")!.set(0.5);
    stage.stage("a");

    const data = snap.serialize();
    expect(data.instances.map((i) => i.id)).toEqual(["boot", "a"]);
    expect(data.live).toBe("boot");
    expect(data.staged).toBe("a");
  });

  it("records a commit's TARGET as live while the crossfade is in flight", () => {
    const { session, stage, snap } = world();
    session.create(scene, "boot");
    stage.adoptLive("boot");
    session.create(scene, "a");
    stage.stage("a");
    stage.commit(frame(10)); // fade started; live flips a frame later

    const data = snap.serialize();
    expect(stage.fading).toBe(true);
    expect(data.live).toBe("a"); // the committed scene, not the old one
    expect(data.staged).toBeNull();
  });

  it("rebuilds non-boot instances under their id and routes live where it was", () => {
    // Author a snapshot in one world...
    const src = world();
    src.session.create(scene, "boot");
    src.stage.adoptLive("boot");
    const a = src.session.create(scene, "a");
    a.instance.manifest.get("speed")!.set(0.7);
    a.modulators.attach(a.instance.manifest, "speed", { type: "sine", periodSeconds: 2 });
    src.stage.restoreLive("a"); // pretend "a" was committed live last session
    const data = src.snap.serialize();
    expect(data.live).toBe("a");

    // ...and restore it into a freshly booted one.
    const next = world();
    next.session.create(scene, "boot");
    next.stage.adoptLive("boot");
    const out = next.snap.restore(data, "boot");

    expect(out.created).toEqual(["a"]);
    expect(out.skipped).toEqual([]);
    const copy = next.session.require("a");
    expect(copy.instance.manifest.get("speed")!.value).toBe(0.7);
    expect(copy.modulators.get("speed")?.error).toBeNull();
    expect(next.stage.live).toBe("a"); // hard-routed back to output (no audience at boot)
  });

  it("reapplies the boot instance's saved chain + modulators onto the new boot", () => {
    const src = world();
    const boot = src.session.create(scene, "boot");
    src.stage.adoptLive("boot");
    src.session.setChain("boot", [{ effect: "glitch", params: { amount: 0.42 } }]);
    boot.modulators.attach(boot.instance.manifest, "speed", { type: "sine", periodSeconds: 2 });
    const data = src.snap.serialize();

    const next = world();
    next.session.create(scene, "boot");
    next.stage.adoptLive("boot");
    next.snap.restore(data, "boot");

    const nb = next.session.require("boot");
    expect(nb.instance.manifest.get("fx.glitch-1.amount")!.value).toBe(0.42);
    expect(nb.modulators.get("speed")?.error).toBeNull();
  });

  it("skips an unknown scene and an id clash without failing the restore", () => {
    const next = world();
    next.session.create(scene, "boot");
    next.stage.adoptLive("boot");
    next.session.create(scene, "a"); // already taken

    const data: SessionData = {
      name: "__session__",
      savedAt: "2026-06-15T00:00:00Z",
      live: null,
      staged: null,
      instances: [
        { id: "x", scene: "gone", values: {}, modulators: [], chain: [], nodeChains: {} },
        { id: "a", scene: "snap-test", values: {}, modulators: [], chain: [], nodeChains: {} },
      ],
    };
    const out = next.snap.restore(data, "boot");
    expect(out.created).toEqual([]);
    expect(out.skipped.map((s) => s.id)).toEqual(["x", "a"]);
    expect(out.skipped[0]!.reason).toContain("unknown scene");
    expect(out.skipped[1]!.reason).toContain("already exists");
    expect(next.stage.live).toBe("boot"); // null live target → boot keeps output
  });
});
