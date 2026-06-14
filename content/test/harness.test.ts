import { BuildCtx, defineModule, Signal, texNode, type TexNode } from "@loom/runtime";
import { vec4 } from "three/tsl";
import { describe, expect, it } from "vitest";
import {
  makeCtx,
  markerInput,
  nonFiniteProbes,
  preservesInputPasses,
  tickFrames,
} from "./harness";

/**
 * The roadmap's ship-gate, inverted: deliberately broken modules must be
 * CAUGHT by the harness checks the tier-1/2 sweeps run. If any of these
 * starts passing, the net has a hole.
 */

describe("the harness catches deliberately broken modules", () => {
  it("a NaN-producing param extreme trips the probe sweep", () => {
    const bad = defineModule(
      { name: "badnan", kind: "source", description: "divides by a zero-min param" },
      (ctx: BuildCtx): TexNode => {
        const div = ctx.float("div", { default: 1, min: 0, max: 2 }).signal();
        const sig = new Signal((f) => 1 / div.get(f)); // min=0 → Infinity
        return texNode(vec4(ctx.uniformOf(sig), 0, 0, 1));
      },
    );
    const h = makeCtx();
    bad(h.ctx, undefined as never);
    h.ctx.finalize();
    tickFrames(h, 5);
    expect(nonFiniteProbes(h.ctx)).toEqual([]); // defaults are fine…
    h.ctx.manifest.get("div")!.set(0); // …the min extreme is not
    tickFrames(h, 5, 10);
    expect(nonFiniteProbes(h.ctx).length).toBeGreaterThan(0);
  });

  it("an effect that drops its input's passes trips the ordering check", () => {
    const badfx = defineModule(
      { name: "baddrop", kind: "effect", description: "forgets [...input.passes]" },
      (_ctx: BuildCtx, opts: { input: TexNode }): TexNode => texNode(opts.input.color), // no passes
    );
    const h = makeCtx();
    const { input, marker } = markerInput();
    const out = badfx(h.ctx, { input });
    expect(preservesInputPasses(out, [marker])).toBe(false);
  });

  it("an effect that reorders passes trips the ordering check", () => {
    const ownFirst = defineModule(
      { name: "badorder", kind: "effect", description: "puts its own pass first" },
      (_ctx: BuildCtx, opts: { input: TexNode }): TexNode =>
        texNode(opts.input.color, [{ render() {}, dispose() {} }, ...opts.input.passes]),
    );
    const h = makeCtx();
    const { input, marker } = markerInput();
    const out = ownFirst(h.ctx, { input });
    expect(preservesInputPasses(out, [marker])).toBe(false);
  });

  it("malformed metadata is rejected at definition time", () => {
    expect(() =>
      defineModule({ name: "Bad Name!", kind: "source", description: "d" }, () => null),
    ).toThrow();
    expect(() =>
      defineModule({ name: "x", kind: "wizard" as never, description: "d" }, () => null),
    ).toThrow();
  });

  it("a dishonest param range is rejected by the manifest", () => {
    const h = makeCtx();
    expect(() => h.ctx.float("bad", { default: 5, min: 0, max: 2 })).toThrow(); // default outside
    expect(() => h.ctx.float("worse", { default: 0, min: 2, max: 0 })).toThrow(); // min > max
  });
});
