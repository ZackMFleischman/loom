import { BuildCtx, defineModule, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import { cos, dot, exp, float, floor, fract, length, sin, step, uv, vec2, vec4 } from "three/tsl";
import { simBuffer } from "../_shared";

/** Simulation grid — fixed and square-ish so Turing patterns stay isotropic and VRAM tiny. */
const SIM_W = 360;
const SIM_H = 240;
/** Injection spot tightness (smaller = pin-prick sparks). */
const SPOT_R2 = 0.0009;

export interface ReactionDiffusionOpts {
  /** Feed rate F — how fast substrate is replenished. The pattern's genus (0.01..0.1). */
  feed?: SignalLike;
  /** Kill rate K — how fast reactant decays. Pair with feed to pick coral/spots/mitosis (0.03..0.07). */
  kill?: SignalLike;
  /** Substrate diffusion DA (≈1.0). */
  diffuseA?: SignalLike;
  /** Reactant diffusion DB (≈0.5). Lower = chunkier blobs. */
  diffuseB?: SignalLike;
  /** Solver iterations per frame — evolution speed (1..24). More = faster growth, heavier frame. */
  iterations?: SignalLike;
  /** Spray fresh reactant from orbiting points — wire ctx.input("kick") here for blooming growth (0..1). */
  inject?: SignalLike;
  /** Rising past 0.5 re-seeds the field from scratch (a trigger). */
  reseed?: SignalLike;
}

/**
 * Gray-Scott reaction-diffusion: a living chemical simulation that grows
 * coral, fingerprints, mitosing cells and labyrinths from a speckle of seed.
 * Two chemicals diffuse and react in a ping-ponged HalfFloat field (the shared
 * `simBuffer`), stepped several iterations a frame; feed/kill rates reshape the
 * whole organism live and `inject` sprays new growth on the beat.
 *
 * Output channels: .x = reactant B (the "ink"), .y = edge (gradient rim for
 * line-art lighting), .z = substrate A. Colorize in the scene through the
 * palette; the bare field reads non-black on its own.
 */
export const reactionDiffusion = defineModule(
  {
    name: "reactionDiffusion",
    kind: "source",
    description: "Gray-Scott reaction-diffusion: living coral/fingerprint Turing patterns, feed/kill reshape live.",
    tags: ["reaction-diffusion", "gray-scott", "simulation", "organic", "generative", "audio-reactive"],
    example: 'reactionDiffusion(ctx, { feed: 0.037, kill: 0.06, inject: ctx.input("kick") })',
  },
  (ctx: BuildCtx, opts: ReactionDiffusionOpts = {}): TexNode => {
    const feed = ctx.uniformOf(opts.feed ?? 0.037);
    const kill = ctx.uniformOf(opts.kill ?? 0.06);
    const dA = ctx.uniformOf(opts.diffuseA ?? 1.0);
    const dB = ctx.uniformOf(opts.diffuseB ?? 0.5);
    const inject = ctx.uniformOf(opts.inject ?? 0);

    const sim = simBuffer(ctx, {
      width: SIM_W,
      height: SIM_H,
      wrap: "repeat", // toroidal field — seamless, no edge seams
      iterations: opts.iterations ?? 12,
      reseed: opts.reseed ?? 0,
      // Substrate A=1 everywhere, reactant B in a sparse deterministic speckle.
      seed: () => {
        const speck = fract(sin(dot(floor(uv().mul(72)), vec2(127.1, 311.7))).mul(43758.5453));
        return vec4(1, step(float(0.86), speck), 0, 1);
      },
      step: ({ sample, phase }) => {
        const c = sample(0, 0);
        const lap = c
          .mul(-1)
          .add(sample(1, 0).add(sample(-1, 0)).add(sample(0, 1)).add(sample(0, -1)).mul(0.2))
          .add(sample(1, 1).add(sample(-1, 1)).add(sample(1, -1)).add(sample(-1, -1)).mul(0.05));

        const A = c.x;
        const B = c.y;
        const abb = A.mul(B).mul(B);

        // Two orbiting injection spots — `inject` sprays reactant on the beat.
        const c1 = vec2(cos(phase.mul(0.013)).mul(0.3).add(0.5), sin(phase.mul(0.017)).mul(0.3).add(0.5));
        const c2 = vec2(cos(phase.mul(-0.019).add(2.1)).mul(0.32).add(0.5), sin(phase.mul(0.011).add(1.3)).mul(0.32).add(0.5));
        const d1 = uv().sub(c1);
        const d2 = uv().sub(c2);
        const g1 = exp(dot(d1, d1).div(SPOT_R2).negate());
        const g2 = exp(dot(d2, d2).div(SPOT_R2).negate());
        const spray = inject.mul(g1.add(g2)).mul(0.6);

        const nextA = A.add(dA.mul(lap.x).sub(abb).add(feed.mul(float(1).sub(A))));
        const nextB = B.add(dB.mul(lap.y).add(abb).sub(kill.add(feed).mul(B))).add(spray);
        return vec4(nextA.clamp(0, 1), nextB.clamp(0, 1), 0, 1);
      },
    });

    // Output: sample the freshly written state, derive an edge rim from B's gradient.
    const oc = sim.sampleOut(0, 0);
    const oR = sim.sampleOut(1, 0).y;
    const oL = sim.sampleOut(-1, 0).y;
    const oU = sim.sampleOut(0, 1).y;
    const oD = sim.sampleOut(0, -1).y;
    const edge = length(vec2(oR.sub(oL), oU.sub(oD))).mul(4).clamp(0, 1);

    return texNode(vec4(oc.y, edge, oc.x, 1), [sim.pass]);
  },
);
