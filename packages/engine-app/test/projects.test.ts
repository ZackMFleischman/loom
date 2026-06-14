import {
  defineModule,
  defineScene,
  Stage,
  texNode,
  type BuildCtx,
  type EffectRegistry,
  type PrimitiveEffectEntry,
  type TexNode,
} from "@loom/runtime";
import { vec4 } from "three/tsl";
import { describe, expect, it } from "vitest";
import { ProjectStore } from "../src/projects";
import { SessionStore } from "../src/session";

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
  name: "proj-test",
  description: "round-trip fixture",
  build(ctx) {
    ctx.float("speed", { default: 0.1, min: 0, max: 1 });
    return ctx.layer("logo", texNode(vec4(0, 0, 0, 1)));
  },
});

function world() {
  const session = new SessionStore(
    { audio: {} as never, time: { bpm: 120 } as never },
    () => registry,
  );
  const stage = new Stage();
  const scenes = new Map([[scene.name, scene]]);
  const store = new ProjectStore(session, stage, () => scenes);
  return { session, stage, store };
}

describe("ProjectStore round-trip", () => {
  it("serializes values, modulators, root + node chains and restores them", () => {
    const { session, stage, store } = world();
    const e = session.create(scene, "a");
    stage.adoptLive("a");
    session.setChain("a", [{ effect: "glitch", params: { amount: 0.77 } }]);
    session.setChain("a", [{ effect: "glitch", params: { amount: 0.33 } }], "logo");
    // Live tweaks after the structural edits (in the real engine set_param also
    // persists to the tuned store, which reapplies across chain rebuilds).
    e.instance.manifest.get("speed")!.set(0.42);
    e.instance.manifest.get("logo.layer.scale")!.set(0.6);
    e.modulators.attach(e.instance.manifest, "speed", { type: "sine", periodSeconds: 2 });

    const data = store.serialize("p1", "2026-06-11T00:00:00Z", ["a"]);
    expect(data.live).toBe("a");
    expect(data.instances).toHaveLength(1);
    const inst = data.instances[0]!;
    expect(inst.values.speed).toBe(0.42);
    expect(inst.values["logo.layer.scale"]).toBe(0.6);
    // chain knob values live in the chain data, never in values
    expect(Object.keys(inst.values).some((k) => k.includes("fx."))).toBe(false);
    expect(inst.chain[0]).toMatchObject({ effect: "glitch", params: { amount: 0.77 } });
    expect(inst.nodeChains.logo?.[0]).toMatchObject({ effect: "glitch", params: { amount: 0.33 } });
    expect(inst.modulators[0]).toMatchObject({ path: "speed", spec: { type: "sine" } });

    // Load into the same session: id taken → suffixed; LIVE untouched.
    const out = store.load(data);
    expect(out.created).toEqual(["a~2"]);
    expect(out.replaced).toEqual(["a"]);
    expect(stage.live).toBe("a");
    const copy = session.require("a~2");
    expect(copy.builds).toBe(1); // chains folded into build #1, no rebuild storm
    expect(copy.instance.manifest.get("speed")!.value).toBe(0.42);
    expect(copy.instance.manifest.get("logo.layer.scale")!.value).toBe(0.6);
    expect(copy.instance.manifest.get("fx.glitch-1.amount")!.value).toBe(0.77);
    expect(copy.instance.manifest.get("logo.fx.glitch-1.amount")!.value).toBe(0.33);
    expect(copy.modulators.get("speed")?.error).toBeNull();
  });

  it("skips unknown scenes without failing the load", () => {
    const { store } = world();
    const out = store.load({
      name: "p2",
      savedAt: "2026-06-11T00:00:00Z",
      live: null,
      instances: [
        { id: "x", scene: "gone", values: {}, modulators: [], chain: [], nodeChains: {} },
      ],
    });
    expect(out.created).toEqual([]);
    expect(out.skipped[0]).toMatchObject({ id: "x", reason: expect.stringContaining("unknown scene") });
  });

  it("excludes pinned infra instances from a save", () => {
    const { session, store } = world();
    session.create(scene, "a");
    const p = session.create(scene, "warm-panic");
    p.pinned = "panic";
    const data = store.serialize("p3", "2026-06-11T00:00:00Z");
    expect(data.instances.map((i) => i.id)).toEqual(["a"]);
  });
});
