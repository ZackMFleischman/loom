import { BuildCtx, defineModule, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import { cos, dot, exp, float, length, sin, uv, vec2, vec4 } from "three/tsl";
import { simBuffer } from "../_shared";

/** Simulation grid — fixed; waves read fine at this size and VRAM stays tiny. */
const SIM_W = 384;
const SIM_H = 256;
/** Drop tightness for injected impulses (smaller = sharper splash). */
const DROP_R2 = 0.0016;

export interface WaveFieldOpts {
  /** Wave speed c² (CFL-stable below ~0.49) — higher ripples travel faster. */
  speed?: SignalLike;
  /** Per-step energy retention (<1 bleeds the pool calm) — lower damps faster. */
  damping?: SignalLike;
  /** Drop impulses from orbiting points — wire ctx.input("kick") for splashes on the beat (0..1). */
  impact?: SignalLike;
  /** Solver iterations per frame — propagation speed (1..6). */
  iterations?: SignalLike;
  /** Rising past 0.5 re-stills the pool and re-drops the seed (a trigger). */
  reseed?: SignalLike;
}

/**
 * A 2D wave-equation ripple tank: a real height field stepped by finite
 * differences in a ping-ponged HalfFloat buffer (the shared `simBuffer`), so
 * wavefronts genuinely propagate, interfere and reflect — where the procedural
 * `ripples` source only draws expanding rings. Drop impulses on the beat via
 * `impact` and the splashes ring out and cross. Toroidal boundaries by default.
 *
 * Output channels: .x = height 0..1 (ramp this), .y = slope magnitude (foam /
 * caustic highlight along the fronts), .z = raw signed height.
 */
export const waveField = defineModule(
  {
    name: "waveField",
    kind: "source",
    description: "2D wave-equation ripple tank: real propagating, interfering wavefronts; beat drops splashes.",
    tags: ["wave", "ripples", "simulation", "water", "interference", "audio-reactive"],
    example: 'waveField(ctx, { speed: 0.3, impact: ctx.input("kick") })',
  },
  (ctx: BuildCtx, opts: WaveFieldOpts = {}): TexNode => {
    const speed = ctx.uniformOf(opts.speed ?? 0.3);
    const damping = ctx.uniformOf(opts.damping ?? 0.996);
    const impact = ctx.uniformOf(opts.impact ?? 0);

    const sim = simBuffer(ctx, {
      width: SIM_W,
      height: SIM_H,
      wrap: "repeat",
      iterations: opts.iterations ?? 2,
      reseed: opts.reseed ?? 0,
      // A few still drops so ripples ring out from frame 0 (non-black on its own).
      seed: () => {
        const drop = (cx: number, cy: number) => {
          const d = uv().sub(vec2(cx, cy));
          return exp(dot(d, d).div(0.004).negate());
        };
        const h = drop(0.5, 0.5).mul(0.9).add(drop(0.28, 0.62)).add(drop(0.72, 0.36));
        return vec4(h, h, 0, 1); // height in .x, previous height in .y (zero initial velocity)
      },
      step: ({ sample, phase }) => {
        const c = sample(0, 0);
        const h = c.x;
        const hPrev = c.y;
        // 4-point Laplacian of the height channel.
        const lap = sample(1, 0).x.add(sample(-1, 0).x).add(sample(0, 1).x).add(sample(0, -1).x).sub(h.mul(4));

        // Two orbiting drops; `impact` rings the pool on the beat.
        const c1 = vec2(cos(phase.mul(0.017)).mul(0.32).add(0.5), sin(phase.mul(0.013)).mul(0.32).add(0.5));
        const c2 = vec2(cos(phase.mul(-0.011).add(1.7)).mul(0.34).add(0.5), sin(phase.mul(0.019).add(0.6)).mul(0.34).add(0.5));
        const d1 = uv().sub(c1);
        const d2 = uv().sub(c2);
        const drops = exp(dot(d1, d1).div(DROP_R2).negate()).add(exp(dot(d2, d2).div(DROP_R2).negate()));

        // hNew = (2h − hPrev + c²∇²h)·damp, then add the impulse.
        const hNew = h.mul(2).sub(hPrev).add(speed.mul(lap)).mul(damping).add(impact.mul(drops).mul(0.6));
        return vec4(hNew, h, 0, 1);
      },
    });

    // Output: height → 0..1, plus a slope magnitude for foam / caustic shading.
    const h = sim.sampleOut(0, 0).x;
    const gx = sim.sampleOut(1, 0).x.sub(sim.sampleOut(-1, 0).x);
    const gy = sim.sampleOut(0, 1).x.sub(sim.sampleOut(0, -1).x);
    const slope = length(vec2(gx, gy)).mul(6).clamp(0, 1);
    return texNode(vec4(h.mul(0.5).add(0.5).clamp(0, 1), slope, h, 1), [sim.pass]);
  },
);
