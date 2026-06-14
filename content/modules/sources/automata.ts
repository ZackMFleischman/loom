import { BuildCtx, defineModule, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import { abs, dot, float, fract, mod, round, sin, step, uv, vec2, vec4 } from "three/tsl";
import { simBuffer } from "../_shared";

/** Simulation grid — fixed; spirals read well at this size. */
const SIM_W = 320;
const SIM_H = 200;

export interface AutomataOpts {
  /** Number of cyclic states n (3..24). More = finer, slower colour cycling through the ramp. */
  states?: SignalLike;
  /** Neighbours at the next state needed to advance a cell (1..4). 1 = classic spiraling waves. */
  threshold?: SignalLike;
  /** Steps per frame — march speed (1..3). */
  iterations?: SignalLike;
  /** Rising past 0.5 re-randomises the field (a trigger). */
  reseed?: SignalLike;
}

/**
 * A cyclic cellular automaton: each cell holds one of n states on a colour
 * wheel and advances to the next when enough neighbours already hold it, so a
 * random field self-organises into endlessly rotating spiral waves (the
 * Greenberg–Hastings look). Discrete, always-alive, and free — stepped in the
 * shared `simBuffer`. Reseed on the beat to detonate fresh spirals.
 *
 * Output channels: .x = state 0..1 (ramp this through the palette), .y =
 * advance front (1 where a cell flipped this step — outline / spark), .z = state.
 */
export const automata = defineModule(
  {
    name: "automata",
    kind: "source",
    description: "Cyclic cellular automaton — random cells self-organise into rotating spiral waves.",
    tags: ["cellular-automata", "cyclic", "spirals", "simulation", "generative"],
    example: 'automata(ctx, { states: 14, reseed: ctx.input("kick") })',
  },
  (ctx: BuildCtx, opts: AutomataOpts = {}): TexNode => {
    const states = ctx.uniformOf(opts.states ?? 14);
    const threshold = ctx.uniformOf(opts.threshold ?? 1);
    const nMax = states.max(3); // guard the n-1 divisor

    const sim = simBuffer(ctx, {
      width: SIM_W,
      height: SIM_H,
      wrap: "repeat",
      iterations: opts.iterations ?? 1,
      reseed: opts.reseed ?? 0,
      // Per-cell random starting state — spirals nucleate out of the noise.
      seed: () => {
        const r = fract(sin(dot(uv().mul(vec2(311.7, 127.1)), vec2(269.5, 183.3))).mul(43758.5453));
        return vec4(round(r.mul(nMax.sub(1))).div(nMax.sub(1)), 0, 0, 1);
      },
      step: ({ sample }) => {
        const denom = nMax.sub(1);
        const s = round(sample(0, 0).x.mul(denom)); // current integer state
        const next = mod(s.add(1), nMax);
        // 1 where a neighbour already holds `next`.
        const atNext = (dx: number, dy: number) =>
          float(1).sub(step(float(0.5), abs(round(sample(dx, dy).x.mul(denom)).sub(next))));
        const count = atNext(1, 0)
          .add(atNext(-1, 0))
          .add(atNext(0, 1))
          .add(atNext(0, -1))
          .add(atNext(1, 1))
          .add(atNext(-1, 1))
          .add(atNext(1, -1))
          .add(atNext(-1, -1));
        const advance = step(threshold.sub(0.5), count); // 1 if count >= threshold
        const outState = s.add(advance.mul(next.sub(s))).div(denom); // mix(s, next, advance)/denom
        return vec4(outState, advance, 0, 1);
      },
    });

    const oc = sim.sampleOut(0, 0);
    return texNode(vec4(oc.x, oc.y, oc.x, 1), [sim.pass]);
  },
);
