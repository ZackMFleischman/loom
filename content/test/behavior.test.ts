import { Signal } from "@loom/runtime";
import { describe, expect, it } from "vitest";
import { counter } from "../modules/control/counter";
import { envelope } from "../modules/control/envelope";
import { gate } from "../modules/control/gate";
import { remap } from "../modules/control/remap";
import { sampleHold } from "../modules/control/sampleHold";
import { spring } from "../modules/control/spring";
import { makeCtx } from "./harness";

/**
 * Tier 2.5 — control-module SEMANTICS. The contract/robustness sweeps prove
 * these build and never NaN; this proves they do what their descriptions
 * claim (counters wrap, envelopes are asymmetric, gates don't chatter…).
 */

const f = (frame: number) => ({ frame, now: frame / 60, dt: 1 / 60 });
/** Pull a signal across frames [0, n), returning every value. */
const run = (sig: Signal<number>, n: number) => Array.from({ length: n }, (_, i) => sig.get(f(i)));

describe("control-module behavior", () => {
  it("envelope rises fast and falls slow (asymmetric attack/release)", () => {
    const { ctx } = makeCtx();
    const input = new Signal((fr) => (fr.frame < 30 ? 1 : 0)); // half a second on, then off
    const env = envelope(ctx, { input, attack: 0.01, release: 0.5 });
    const v = run(env, 90);
    expect(v[5]!).toBeGreaterThan(0.7); // ~5 frames in, nearly there (attack 10ms)
    expect(v[31]!).toBeGreaterThan(0.85); // one frame after release starts: barely moved
    expect(v[89]!).toBeGreaterThan(0.1); // a second later: still audibly falling
    expect(v[89]!).toBeLessThan(v[31]!);
  });

  it("spring overshoots its target and rings back (lag never does)", () => {
    const { ctx } = makeCtx();
    const input = new Signal(() => 1);
    const s = spring(ctx, { input, stiffness: 200, damping: 6 });
    const v = run(s, 120);
    expect(Math.max(...v)).toBeGreaterThan(1.1); // the overshoot IS the point
    expect(v[119]!).toBeGreaterThan(0.85); // and it settles toward the target
    expect(v[119]!).toBeLessThan(1.15);
  });

  it("gate opens at threshold and holds through the hysteresis band (no chatter)", () => {
    const { ctx } = makeCtx();
    let level = 0;
    const g = gate(ctx, { input: new Signal(() => level), threshold: 0.5, hysteresis: 0.2 });
    level = 0.45;
    expect(g.get(f(0))).toBe(0); // below threshold: closed
    level = 0.55;
    expect(g.get(f(1))).toBe(1); // crossed: open
    level = 0.4;
    expect(g.get(f(2))).toBe(1); // inside the hysteresis band: STILL open
    level = 0.25;
    expect(g.get(f(3))).toBe(0); // below threshold − hysteresis: released
  });

  it("counter counts rising edges only and wraps at N", () => {
    const { ctx } = makeCtx();
    // A kick every 10 frames, 3 frames wide — width must not double-count.
    const trigger = new Signal((fr) => (fr.frame % 10 < 3 ? 1 : 0));
    const c = counter(ctx, { trigger, wrap: 3 });
    const v = run(c, 61);
    expect(v[5]).toBe(1); // edge at frame 0 counted once
    expect(v[15]).toBe(2);
    expect(v[25]).toBe(0); // wrapped at 3
    expect(v[35]).toBe(1);
  });

  it("sampleHold freezes the input on each trigger edge and holds between", () => {
    const { ctx } = makeCtx();
    const input = new Signal((fr) => fr.frame); // a ramp: easy to read off
    const trigger = new Signal((fr) => (fr.frame % 20 === 0 ? 1 : 0));
    const sh = sampleHold(ctx, { input, trigger });
    const v = run(sh, 50);
    expect(v[0]).toBe(0); // sampled at the frame-0 edge
    expect(v[19]).toBe(0); // held, not following the ramp
    expect(v[20]).toBe(20); // resampled on the next edge
    expect(v[39]).toBe(20);
  });

  it("remap maps ranges (inverting allowed) and shapes with the curve", () => {
    const { ctx } = makeCtx();
    const half = new Signal(() => 0.5);
    expect(remap(ctx, { input: half, outMin: 10, outMax: 20 }).get(f(0))).toBe(15);
    expect(remap(ctx, { input: half, outMin: 20, outMax: 10 }).get(f(0))).toBe(15);
    expect(remap(ctx, { input: new Signal(() => 2) }).get(f(0))).toBe(1); // clamped
    expect(remap(ctx, { input: half, curve: "exp" }).get(f(0))).toBe(0.25);
    expect(remap(ctx, { input: half, curve: "smooth" }).get(f(0))).toBe(0.5); // smoothstep midpoint
  });
});
