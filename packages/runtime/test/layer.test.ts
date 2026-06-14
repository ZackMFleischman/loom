import { vec4 } from "three/tsl";
import { describe, expect, it } from "vitest";
import { BuildCtx } from "../src/buildctx";
import { ChainHost, type EffectRegistry, type PrimitiveEffectEntry } from "../src/chain";
import { defineModule } from "../src/module";
import { texNode, type TexNode } from "../src/texnode";

// Bare BuildCtx: the rig's params/uniforms never touch audio/time at build time.
const ctx = (hooks?: ConstructorParameters<typeof BuildCtx>[4]) =>
  new BuildCtx({} as never, {} as never, undefined, undefined, hooks);

const base = (): TexNode => texNode(vec4(0, 0, 0, 1));

const glitch: PrimitiveEffectEntry = {
  name: "glitch",
  kind: "primitive",
  chainParams: [{ name: "amount", type: "float", default: 0.6, min: 0, max: 1 }],
  factory: defineModule(
    { name: "glitch", kind: "effect", description: "x" },
    (_c: BuildCtx, opts: { input: TexNode }) => opts.input,
  ),
};
const registry: EffectRegistry = {
  get: (n) => (n === "glitch" ? glitch : undefined),
  names: () => ["glitch"],
};

describe("ctx.layer", () => {
  it("declares the rig params at <name>.layer.* with identity defaults", () => {
    const c = ctx();
    c.layer("logo", base());
    expect(c.manifest.get("logo.layer.x")?.value).toBe(0.5);
    expect(c.manifest.get("logo.layer.y")?.value).toBe(0.5);
    expect(c.manifest.get("logo.layer.scale")?.value).toBe(1);
    expect(c.manifest.get("logo.layer.rotate")?.value).toBe(0);
    expect(c.manifest.get("logo.layer.opacity")?.value).toBe(1);
  });

  it("registers the node and appends the rig pass to the input's passes", () => {
    const c = ctx();
    const input = base();
    const out = c.layer("logo", input);
    expect(c.nodes).toEqual([{ id: "logo", parent: null }]);
    expect(out.passes.length).toBe(input.passes.length + 1);
  });

  it("rejects duplicate, reserved, and malformed names (NFR-5 contains the throw)", () => {
    const c = ctx();
    c.layer("logo", base());
    expect(() => c.layer("logo", base())).toThrow(/duplicate node name/);
    expect(() => c.layer("fx", base())).toThrow(/reserved/);
    expect(() => c.layer("9lives", base())).toThrow(/invalid node name/);
    expect(() => c.layer("a.b", base())).toThrow(/invalid node name/);
  });

  it("resolves immediate parents on nested wraps (registration is bottom-up)", () => {
    const c = ctx();
    const inner = c.layer("inner", base());
    const mid = c.layer("mid", inner);
    // A sibling that never nests inside anything.
    c.layer("solo", base());
    c.layer("outer", mid);
    const byId = new Map(c.nodes.map((n) => [n.id, n.parent]));
    expect(byId.get("inner")).toBe("mid");
    expect(byId.get("mid")).toBe("outer");
    expect(byId.get("solo")).toBe(null);
    expect(byId.get("outer")).toBe(null);
  });

  it("parents through pass-merging composition (over-style nodes)", () => {
    const c = ctx();
    const a = c.layer("a", base());
    const b = c.layer("b", base());
    // Composite the two branches the way `over` does: merge pass lists.
    const merged = texNode(vec4(0, 0, 0, 1), [...a.passes, ...b.passes]);
    c.layer("stack", merged);
    const byId = new Map(c.nodes.map((n) => [n.id, n.parent]));
    expect(byId.get("a")).toBe("stack");
    expect(byId.get("b")).toBe("stack");
  });

  it("invokes the session's foldNode hook with the rigged output", () => {
    const seen: string[] = [];
    const c = ctx({
      foldNode: (_ctx, node, tex) => {
        seen.push(node);
        return tex;
      },
    });
    c.layer("logo", base());
    expect(seen).toEqual(["logo"]);
  });
});

describe("ChainHost with a node prefix", () => {
  it("declares params at <node>.fx.<id>.* and round-trips values", () => {
    const host = new ChainHost(() => registry, "logo.fx");
    host.steps = host.plan([{ effect: "glitch" }]);
    const c1 = ctx();
    host.fold(c1, base());
    expect(c1.manifest.get("logo.fx.glitch-1.amount")?.type).toBe("float");
    expect(c1.manifest.get("logo.fx.glitch-1.mix")?.type).toBe("float");

    c1.manifest.get("logo.fx.glitch-1.amount")!.set(0.9);
    host.captureValues(c1.manifest);
    expect(host.steps[0]!.params.amount).toBe(0.9);

    const c2 = ctx();
    host.fold(c2, base());
    host.applyValues(c2.manifest);
    expect(c2.manifest.get("logo.fx.glitch-1.amount")!.value).toBe(0.9);
  });

  it("the root host keeps the M6 fx prefix", () => {
    const host = new ChainHost(() => registry);
    host.steps = host.plan([{ effect: "glitch" }]);
    const c = ctx();
    host.fold(c, base());
    expect(c.manifest.get("fx.glitch-1.amount")?.type).toBe("float");
  });
});
