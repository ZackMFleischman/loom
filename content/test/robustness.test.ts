import { Signal } from "@loom/runtime";
import { describe, expect, it } from "vitest";
import { buildCase, CASES } from "./cases";
import { blackInput, discoverModules, makeCtx, nonFiniteProbes, tickFrames } from "./harness";

/**
 * Tier 2 — robustness. Every module is swept through the extremes of every
 * param it declares (min, max, both bool states), ticking 60 frames per
 * setting. The ProbeCtx uniforms are the complete set of CPU-side signal
 * outputs — any NaN/Infinity in them would reach the GPU in production.
 */

const modules = discoverModules();

describe.each(modules)("tier-2 robustness: $name", (d) => {
  it("param-extremes sweep stays finite and never throws", () => {
    const built = buildCase(d);
    const { h, out } = built;
    let base = 0;

    const settle = (label: string) => {
      const f = tickFrames(h, 60, base);
      base += 61;
      if (out instanceof Signal) {
        expect(Number.isFinite(out.get(f)), `${label}: control signal not finite`).toBe(true);
      }
      expect(nonFiniteProbes(h.ctx), `${label}: non-finite uniform(s)`).toEqual([]);
    };

    settle("defaults");
    for (const path of h.ctx.manifest.paths()) {
      const p = h.ctx.manifest.get(path)!;
      const j = p.toJSON() as { type: string; min?: number; max?: number; default?: unknown };
      if (j.type === "float" || j.type === "int") {
        p.set(j.min);
        settle(`${path}=min(${j.min})`);
        p.set(j.max);
        settle(`${path}=max(${j.max})`);
        p.set(j.default);
      } else if (j.type === "bool") {
        p.set(true);
        settle(`${path}=true`);
        p.set(false);
        settle(`${path}=false`);
        p.set(j.default);
      }
      // color params: no numeric path into uniforms beyond the palette ramp,
      // which fillRamp clamps; nothing to sweep.
    }
  });
});

const effects = modules.filter((m) => m.factory.meta.kind === "effect");

describe.each(effects)("tier-2 degenerate input: $name", (d) => {
  it("builds and ticks against a black constant input", () => {
    const h = makeCtx();
    CASES[d.name]!(h.ctx, blackInput());
    h.ctx.finalize();
    tickFrames(h, 60);
    expect(nonFiniteProbes(h.ctx)).toEqual([]);
  });
});
