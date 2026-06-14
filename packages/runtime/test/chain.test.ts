import { vec4 } from "three/tsl";
import { describe, expect, it } from "vitest";
import { BuildCtx } from "../src/buildctx";
import {
  ChainHost,
  chainWetSignal,
  type EffectEntry,
  type EffectRegistry,
  type PrimitiveEffectEntry,
  type SourceRef,
  type SourceResolver,
} from "../src/chain";
import type { FrameCtx } from "../src/frame";
import { defineModule } from "../src/module";
import { Signal } from "../src/signal";
import { texNode, type TexNode } from "../src/texnode";

// Bare BuildCtx: chain params never touch audio/time, so minimal fakes suffice.
const ctx = () => new BuildCtx({} as never, {} as never);

const passInput = (ctx: BuildCtx, opts: { input: TexNode }): TexNode => opts.input;

const prim = (
  name: string,
  factory: PrimitiveEffectEntry["factory"],
  chainParams: PrimitiveEffectEntry["chainParams"] = [],
): PrimitiveEffectEntry => ({ name, kind: "primitive", chainParams, factory });

const levels = prim(
  "levels",
  defineModule({ name: "levels", kind: "effect", description: "x" }, passInput),
  [{ name: "gain", type: "float", default: 1, min: 0, max: 2 }],
);
const glitch = prim(
  "glitch",
  defineModule({ name: "glitch", kind: "effect", description: "x" }, passInput),
  [{ name: "amount", type: "float", default: 0.6, min: 0, max: 1 }],
);
const boom = prim(
  "boom",
  defineModule({ name: "boom", kind: "effect", description: "x" }, () => {
    throw new Error("kaboom");
  }),
);

function registry(...entries: EffectEntry[]): EffectRegistry {
  const m = new Map(entries.map((e) => [e.name, e]));
  return { get: (n) => m.get(n), names: () => [...m.keys()] };
}

const base = (): TexNode => texNode(vec4(0, 0, 0, 1));

describe("ChainHost.plan", () => {
  it("assigns stable <effect>-<n> ids and validates effects", () => {
    const host = new ChainHost(() => registry(glitch, levels));
    const steps = host.plan([{ effect: "glitch" }, { effect: "levels" }]);
    expect(steps.map((s) => s.id)).toEqual(["glitch-1", "levels-2"]);
    expect(steps.every((s) => s.params.mix === 1)).toBe(true);
  });

  it("throws on an unknown effect (whole edit rejected)", () => {
    const host = new ChainHost(() => registry(glitch));
    expect(() => host.plan([{ effect: "nope" }])).toThrow(/unknown effect "nope"/);
  });

  it("carries knob values forward by surviving id (reorder preserves knobs)", () => {
    const host = new ChainHost(() => registry(glitch, levels));
    host.steps = host.plan([{ effect: "glitch" }, { effect: "levels" }]);
    host.steps[0]!.params.amount = 0.9; // a live tweak captured into the step
    // Reorder: same ids, flipped order, no params sent.
    const reordered = host.plan([
      { id: "levels-2", effect: "levels" },
      { id: "glitch-1", effect: "glitch" },
    ]);
    expect(reordered.map((s) => s.id)).toEqual(["levels-2", "glitch-1"]);
    expect(reordered.find((s) => s.id === "glitch-1")!.params.amount).toBe(0.9);
  });

  it("honors an explicit mix and explicit params override", () => {
    const host = new ChainHost(() => registry(glitch));
    const [s] = host.plan([{ effect: "glitch", mix: 0.5, params: { amount: 0.2 } }]);
    expect(s!.params.mix).toBe(0.5);
    expect(s!.params.amount).toBe(0.2);
  });
});

describe("ChainHost.fold", () => {
  it("declares fx.<id>.<param> and fx.<id>.mix on the manifest", () => {
    const host = new ChainHost(() => registry(glitch));
    host.steps = host.plan([{ effect: "glitch" }]);
    const c = ctx();
    host.fold(c, base());
    expect(c.manifest.get("fx.glitch-1.amount")?.type).toBe("float");
    expect(c.manifest.get("fx.glitch-1.mix")?.type).toBe("float");
  });

  it("a throwing step throws the whole fold (NFR-5 rejects the rebuild)", () => {
    const host = new ChainHost(() => registry(glitch, boom));
    host.steps = host.plan([{ effect: "glitch" }, { effect: "boom" }]);
    expect(() => host.fold(ctx(), base())).toThrow(/kaboom/);
  });
});

describe("ChainHost value round-trip", () => {
  it("captures live values and re-applies them after a rebuild", () => {
    const host = new ChainHost(() => registry(glitch));
    host.steps = host.plan([{ effect: "glitch" }]);
    const c1 = ctx();
    host.fold(c1, base());
    c1.manifest.get("fx.glitch-1.amount")!.set(0.8);
    host.captureValues(c1.manifest);
    expect(host.steps[0]!.params.amount).toBe(0.8);

    const c2 = ctx(); // fresh build (e.g. scene HMR)
    host.fold(c2, base());
    expect(c2.manifest.get("fx.glitch-1.amount")!.value).toBe(0.6); // code default
    host.applyValues(c2.manifest);
    expect(c2.manifest.get("fx.glitch-1.amount")!.value).toBe(0.8); // tuned value restored
  });
});

describe("ChainHost.serialize", () => {
  it("emits primitive steps for save-as", () => {
    const host = new ChainHost(() => registry(glitch, levels));
    host.steps = host.plan([{ effect: "glitch", params: { amount: 0.7 } }]);
    const data = host.serialize();
    expect(data.steps).toEqual([
      { id: "glitch-1", effect: "glitch", params: { amount: 0.7 }, mix: 1 },
    ]);
  });

  it("refuses to save a chain containing a composite (one level deep)", () => {
    const composite: EffectEntry = {
      name: "combo",
      kind: "composite",
      steps: [{ id: "glitch-1", effect: "glitch", params: {} }],
    };
    const host = new ChainHost(() => registry(glitch, composite));
    host.steps = host.plan([{ effect: "combo" }]);
    expect(() => host.serialize()).toThrow(/only primitive effects/);
  });
});

describe("chain step enable/disable with fade", () => {
  it("fold declares fx.<id>.enabled (bool, default on) and fx.<id>.fade", () => {
    const host = new ChainHost(() => registry(glitch));
    host.steps = host.plan([{ effect: "glitch" }]);
    const c = ctx();
    host.fold(c, base());
    const enabled = c.manifest.get("fx.glitch-1.enabled");
    const fade = c.manifest.get("fx.glitch-1.fade");
    expect(enabled?.type).toBe("bool");
    expect(enabled?.value).toBe(true);
    expect(fade?.type).toBe("float");
    expect(fade?.value).toBe(0);
  });

  it("rejects an effect that declares a reserved chain param name", () => {
    const bad = prim(
      "bad",
      defineModule({ name: "bad", kind: "effect", description: "x" }, passInput),
      [{ name: "enabled", type: "bool", default: true }],
    );
    const host = new ChainHost(() => registry(bad));
    host.steps = host.plan([{ effect: "bad" }]);
    expect(() => host.fold(ctx(), base())).toThrow(/reserved chain param "enabled"/);
  });

  it("list() reports enabled (true by default, false once toggled)", () => {
    const host = new ChainHost(() => registry(glitch));
    host.steps = host.plan([{ effect: "glitch" }]);
    expect(host.list()[0]!.enabled).toBe(true);
    const c = ctx();
    host.fold(c, base());
    c.manifest.get("fx.glitch-1.enabled")!.set(false);
    host.captureValues(c.manifest);
    expect(host.list()[0]!.enabled).toBe(false);
  });

  const frames = (n: number, dt: number): FrameCtx[] =>
    Array.from({ length: n }, (_, i) => ({ frame: i + 1, now: (i + 1) * dt, dt }));

  it("fade 0 cuts instantly between mix and 0", () => {
    let enabled = true;
    const wet = chainWetSignal(Signal.of(0.8), new Signal(() => enabled), Signal.of(0));
    const [f1, f2] = frames(2, 1 / 60);
    expect(wet.get(f1!)).toBeCloseTo(0.8);
    enabled = false;
    expect(wet.get(f2!)).toBeCloseTo(0);
  });

  it("fade > 0 ramps linearly toward the new state", () => {
    let enabled = true;
    const wet = chainWetSignal(Signal.of(1), new Signal(() => enabled), Signal.of(1));
    const fs = frames(12, 0.1); // dt 0.1 s, fade 1 s → 0.1 per frame
    expect(wet.get(fs[0]!)).toBe(1); // starts at the current state, no fade-in on build
    enabled = false;
    expect(wet.get(fs[1]!)).toBeCloseTo(0.9);
    expect(wet.get(fs[2]!)).toBeCloseTo(0.8);
    enabled = true; // flip mid-ramp: reverses from where it is
    expect(wet.get(fs[3]!)).toBeCloseTo(0.9);
    for (const f of fs.slice(4)) wet.get(f);
    expect(wet.get(fs[11]!)).toBe(1); // clamps at the target, no overshoot
  });

  it("the envelope scales the mix knob", () => {
    let enabled = true;
    const wet = chainWetSignal(Signal.of(0.5), new Signal(() => enabled), Signal.of(1));
    const fs = frames(3, 0.5);
    expect(wet.get(fs[0]!)).toBeCloseTo(0.5);
    enabled = false;
    expect(wet.get(fs[1]!)).toBeCloseTo(0.25); // env 0.5 × mix 0.5
    expect(wet.get(fs[2]!)).toBeCloseTo(0);
  });
});

describe("ChainHost composite fold", () => {
  it("namespaces inner step params under fx.<id>.<inner>.<param>", () => {
    const composite: EffectEntry = {
      name: "combo",
      kind: "composite",
      steps: [{ id: "glitch-1", effect: "glitch", params: { amount: 0.3 } }],
    };
    const host = new ChainHost(() => registry(glitch, composite));
    host.steps = host.plan([{ effect: "combo" }]);
    const c = ctx();
    host.fold(c, base());
    expect(c.manifest.get("fx.combo-1.glitch-1.amount")?.type).toBe("float");
    expect(c.manifest.get("fx.combo-1.mix")?.type).toBe("float");
  });
});

// ── Multi-input chain steps ──────────────────────────────────────────────────
// An effect with one extra TexNode slot ("overlay"). The fold wraps each step's
// factory output in a wet/dry blend, so we can't tag the RETURN; instead the
// factory records the overlay it received into a closure side-channel, proving
// exactly WHICH TexNode the fold resolved into the slot.
let receivedOverlay: TexNode | undefined;
const over: PrimitiveEffectEntry = {
  name: "over",
  kind: "primitive",
  chainParams: [],
  chainInputs: [{ name: "overlay", kind: "tex" }],
  factory: defineModule(
    { name: "over", kind: "effect", description: "x", chainInputs: [{ name: "overlay", kind: "tex" }] },
    (_c: BuildCtx, opts: { input: TexNode; overlay?: TexNode }) => {
      if (!opts.overlay) throw new Error("overlay missing");
      receivedOverlay = opts.overlay;
      return texNode(opts.input.color, opts.input.passes);
    },
  ),
};

// A resolver that knows a fixed map of instance id → TexNode.
const liveTex = texNode(vec4(1, 0, 0, 1));
const resolver = (known: Record<string, TexNode>): SourceResolver => ({
  instance: (id) => known[id] ?? null,
});

describe("multi-input chain steps — plan (ordering/cycle guard)", () => {
  it("accepts an {instance} source on a declared slot", () => {
    const host = new ChainHost(() => registry(over), undefined, resolver({ live: liveTex }));
    const steps = host.plan([{ effect: "over", inputs: { overlay: { instance: "live" } } }]);
    expect(steps[0]!.inputs).toEqual({ overlay: { instance: "live" } });
  });

  it("accepts a {step} source that taps an EARLIER step", () => {
    const host = new ChainHost(() => registry(glitch, over), undefined, resolver({}));
    const steps = host.plan([
      { effect: "glitch" },
      { effect: "over", inputs: { overlay: { step: "glitch-1" } } },
    ]);
    expect(steps[1]!.inputs).toEqual({ overlay: { step: "glitch-1" } });
  });

  it("rejects a {step} source that taps ITSELF (cycle guard)", () => {
    const host = new ChainHost(() => registry(over));
    expect(() =>
      host.plan([{ id: "over-1", effect: "over", inputs: { overlay: { step: "over-1" } } }]),
    ).toThrow(/cannot tap itself/);
  });

  it("rejects a {step} source that taps a LATER step (forward/ordering guard)", () => {
    const host = new ChainHost(() => registry(glitch, over));
    expect(() =>
      host.plan([
        { effect: "over", inputs: { overlay: { step: "glitch-2" } } },
        { effect: "glitch" },
      ]),
    ).toThrow(/not an EARLIER step/);
  });

  it("rejects a binding to an undeclared slot", () => {
    const host = new ChainHost(() => registry(over), undefined, resolver({ live: liveTex }));
    expect(() =>
      host.plan([{ effect: "over", inputs: { bogus: { instance: "live" } } }]),
    ).toThrow(/no input slot "bogus"/);
  });

  it("rejects an {asset} source (deferred — needs M10)", () => {
    const host = new ChainHost(() => registry(over));
    expect(() =>
      host.plan([{ effect: "over", inputs: { overlay: { asset: "logo.png" } } as never }]),
    ).toThrow(/asset source is not yet supported/);
  });
});

describe("multi-input chain steps — fold (SourceRef resolution)", () => {
  it("resolves an {instance} ref to the resolver's TexNode and feeds the slot", () => {
    receivedOverlay = undefined;
    const host = new ChainHost(() => registry(over), undefined, resolver({ live: liveTex }));
    host.steps = host.plan([{ effect: "over", inputs: { overlay: { instance: "live" } } }]);
    host.fold(ctx(), base());
    expect(receivedOverlay).toBe(liveTex); // the exact TexNode the resolver returned
  });

  it("resolves a {step} ref to an earlier step's folded output", () => {
    receivedOverlay = undefined;
    const host = new ChainHost(() => registry(glitch, over), undefined, resolver({}));
    host.steps = host.plan([
      { effect: "glitch" },
      { effect: "over", inputs: { overlay: { step: "glitch-1" } } },
    ]);
    const b = base();
    host.fold(ctx(), b);
    // The overlay slot received glitch-1's FOLDED output — a distinct wet/dry-
    // wrapped node, never the raw base nor undefined (proves step-tap resolution).
    expect(receivedOverlay).toBeDefined();
    expect(receivedOverlay).not.toBe(b);
  });

  it("rejects (throws) when an {instance} source can't resolve — NFR-5", () => {
    const host = new ChainHost(() => registry(over), undefined, resolver({})); // no instances
    host.steps = host.plan([{ effect: "over", inputs: { overlay: { instance: "ghost" } } }]);
    expect(() => host.fold(ctx(), base())).toThrow(/cannot resolve instance source "ghost"/);
  });

  it("rejects (throws) with no resolver at all (host can't sample instances)", () => {
    const host = new ChainHost(() => registry(over)); // no resolver passed
    host.steps = host.plan([{ effect: "over", inputs: { overlay: { instance: "live" } } }]);
    expect(() => host.fold(ctx(), base())).toThrow(/cannot resolve instance source "live"/);
  });

  it("throws when a declared slot is left unbound", () => {
    const host = new ChainHost(() => registry(over), undefined, resolver({}));
    host.steps = host.plan([{ effect: "over" }]); // overlay not bound
    expect(() => host.fold(ctx(), base())).toThrow(/needs input slot "overlay" bound/);
  });
});

describe("multi-input chain steps — single-input unchanged", () => {
  it("a classic single-input step carries NO inputs key (byte-for-byte)", () => {
    const host = new ChainHost(() => registry(glitch));
    host.steps = host.plan([{ effect: "glitch" }]);
    expect("inputs" in host.steps[0]!).toBe(false);
    expect(host.list()[0]).not.toHaveProperty("inputs");
  });

  it("serialize() refuses to save a step with input bindings (not composable yet)", () => {
    const host = new ChainHost(() => registry(over), undefined, resolver({ live: liveTex }));
    host.steps = host.plan([{ effect: "over", inputs: { overlay: { instance: "live" } } }]);
    expect(() => host.serialize()).toThrow(/multi-input chain steps/);
  });

  it("list() surfaces bound inputs for get_session", () => {
    const host = new ChainHost(() => registry(over), undefined, resolver({ live: liveTex }));
    host.steps = host.plan([{ effect: "over", inputs: { overlay: { instance: "live" } } }]);
    const info = host.list()[0]!;
    expect(info.inputs).toEqual({ overlay: { instance: "live" } });
  });
});

// Exercise the SourceRef type import.
const _exampleRef: SourceRef = { instance: "live" };
void _exampleRef;
