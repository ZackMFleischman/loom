import {
  BuildCtx,
  defineModule,
  texNode,
  type FrameCtx,
  type Pass,
  type SignalLike,
  type TexNode,
} from "@loom/runtime";
import { cos, dot, exp, float, floor, fract, length, sin, step, texture, uniform, uv, vec2, vec4 } from "three/tsl";
import {
  HalfFloatType,
  MeshBasicNodeMaterial,
  NoBlending,
  QuadMesh,
  RenderTarget,
  RepeatWrapping,
  type WebGPURenderer,
} from "three/webgpu";

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
 * Two chemicals diffuse and react in a ping-ponged HalfFloat field, stepped
 * several iterations a frame; feed/kill rates reshape the whole organism live
 * and `inject` sprays new growth on the beat. Stateful — a code change (NFR-5)
 * resets the field, which re-seeds on the next frame.
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
    const rtOpts = { type: HalfFloatType, depthBuffer: false } as const;
    const rtA = new RenderTarget(SIM_W, SIM_H, rtOpts);
    const rtB = new RenderTarget(SIM_W, SIM_H, rtOpts);
    for (const rt of [rtA, rtB]) {
      rt.texture.wrapS = RepeatWrapping; // toroidal field — seamless, no edge seams
      rt.texture.wrapT = RepeatWrapping;
    }
    let read = rtA;
    let write = rtB;

    const feed = ctx.uniformOf(opts.feed ?? 0.037);
    const kill = ctx.uniformOf(opts.kill ?? 0.06);
    const dA = ctx.uniformOf(opts.diffuseA ?? 1.0);
    const dB = ctx.uniformOf(opts.diffuseB ?? 0.5);
    const inject = ctx.uniformOf(opts.inject ?? 0);
    const iterU = ctx.uniformOf(opts.iterations ?? 12);
    const reseedU = ctx.uniformOf(opts.reseed ?? 0);
    const phase = uniform(0); // frame-clocked injection orbit (deterministic, never TSL time)

    const texel = vec2(1 / SIM_W, 1 / SIM_H);

    // --- simulation step: read `simSrc`, integrate one Gray-Scott iteration ----
    const simSrc = texture(rtA.texture); // base node; .value swapped each iteration
    const tap = (dx: number, dy: number) => simSrc.sample(uv().add(texel.mul(vec2(dx, dy))));
    const c = simSrc.sample(uv());
    const lap = c
      .mul(-1)
      .add(tap(1, 0).add(tap(-1, 0)).add(tap(0, 1)).add(tap(0, -1)).mul(0.2))
      .add(tap(1, 1).add(tap(-1, 1)).add(tap(1, -1)).add(tap(-1, -1)).mul(0.05));

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

    const simMaterial = new MeshBasicNodeMaterial();
    simMaterial.colorNode = vec4(nextA.clamp(0, 1), nextB.clamp(0, 1), 0, 1);
    simMaterial.transparent = true;
    simMaterial.blending = NoBlending;
    const simQuad = new QuadMesh(simMaterial);

    // --- seed: substrate A=1 everywhere, reactant B in a sparse speckle --------
    const speck = fract(sin(dot(floor(uv().mul(72)), vec2(127.1, 311.7))).mul(43758.5453));
    const seedMaterial = new MeshBasicNodeMaterial();
    seedMaterial.colorNode = vec4(1, step(float(0.86), speck), 0, 1);
    seedMaterial.transparent = true;
    seedMaterial.blending = NoBlending;
    const seedQuad = new QuadMesh(seedMaterial);

    // --- output: sample the freshly written state, derive an edge rim ----------
    const outTex = texture(rtA.texture); // .value set to the latest read target each frame
    const oc = outTex.sample(uv());
    const oR = outTex.sample(uv().add(vec2(texel.x, 0))).y;
    const oL = outTex.sample(uv().sub(vec2(texel.x, 0))).y;
    const oU = outTex.sample(uv().add(vec2(0, texel.y))).y;
    const oD = outTex.sample(uv().sub(vec2(0, texel.y))).y;
    const edge = length(vec2(oR.sub(oL), oU.sub(oD))).mul(4).clamp(0, 1);

    let seeded = false;
    let reseedWas = false;
    const pass: Pass = {
      render(renderer: WebGPURenderer, f: FrameCtx) {
        phase.value = f.frame;
        const prev = renderer.getRenderTarget();

        const reseedHigh = (reseedU.value as number) > 0.5;
        if (!seeded || (reseedHigh && !reseedWas)) {
          renderer.setRenderTarget(read);
          seedQuad.render(renderer);
          seeded = true;
        }
        reseedWas = reseedHigh;

        const iters = Math.max(1, Math.min(24, Math.round(iterU.value as number)));
        for (let i = 0; i < iters; i++) {
          simSrc.value = read.texture;
          renderer.setRenderTarget(write);
          simQuad.render(renderer);
          [read, write] = [write, read];
        }
        renderer.setRenderTarget(prev);
        outTex.value = read.texture; // freshly written this frame
      },
      dispose() {
        rtA.dispose();
        rtB.dispose();
        simMaterial.dispose();
        seedMaterial.dispose();
      },
    };

    return texNode(vec4(oc.y, edge, oc.x, 1), [pass]);
  },
);
