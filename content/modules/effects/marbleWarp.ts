import {
  asSignal,
  BuildCtx,
  defineModule,
  integrateSignal,
  texNode,
  type ColorNode,
  type SignalLike,
  type TexNode,
} from "@loom/runtime";
import { texture, uv, vec2 } from "three/tsl";
import { bufferPass, fbm2, surfaceAspect } from "../_shared";

export interface MarbleWarpOpts {
  input: TexNode;
  /** UV displacement strength — how far the marble field smears the image. */
  amount?: SignalLike;
  /** Field scale (bigger = finer swirl). */
  scale?: SignalLike;
  /** Domain-warp folding inside the field (the marbling). */
  warp?: SignalLike;
  /** Evolution speed of the warp field (frame-clocked, never TSL time). */
  evolve?: SignalLike;
  /** FBM octaves (compile-time, 1..6). */
  octaves?: number;
}

/**
 * The effect face of `marble`: warps an input's UVs by an iterated
 * domain-warp noise field, smearing it into liquid-marble / heat-haze
 * swirls. Like `displace`, but the warp vector comes from noise folded
 * through itself (`fbm(p + fbm(p))`), giving paint-marbling motion rather
 * than a single-octave wobble. Buffers the input (it can't be re-sampled at a
 * shifted UV directly) then reads it at the warped coordinate.
 */
export const marbleWarp = defineModule(
  {
    name: "marbleWarp",
    kind: "effect",
    description: "Warps any input through an iterated domain-warp noise field — liquid-marble / heat-haze smear.",
    tags: ["marble", "domain-warp", "displace", "warp", "stateful"],
    example: 'marbleWarp(ctx, { input: src, amount: 0.12, warp: 4 })',
    chainParams: [
      { name: "amount", default: 0.12, min: 0, max: 0.5, step: 0.01, description: "UV displacement strength" },
      { name: "scale", default: 3, min: 0.5, max: 8, step: 0.1, description: "field scale" },
      { name: "warp", default: 4, min: 0, max: 8, step: 0.1, description: "domain-warp folding" },
      { name: "evolve", default: 0.1, min: 0, max: 0.5, step: 0.01, description: "field drift speed" },
    ],
  },
  (ctx: BuildCtx, opts: MarbleWarpOpts): TexNode => {
    const oct = Math.max(1, Math.min(6, Math.round(opts.octaves ?? 4)));
    const amount = ctx.uniformOf(opts.amount ?? 0.12);
    const scale = ctx.uniformOf(opts.scale ?? 3);
    const warp = ctx.uniformOf(opts.warp ?? 4);
    const t = ctx.uniformOf(integrateSignal(asSignal(opts.evolve ?? 0.1)));

    const { rt, pass } = bufferPass(opts.input);

    const p = uv().sub(0.5).mul(vec2(surfaceAspect(), 1)).mul(scale.max(0.1));
    const fbm = (q: Parameters<typeof fbm2>[0]) => fbm2(q, oct);
    // Two-level warp → a centred 2D offset that smears the buffered input.
    const a = vec2(fbm(p.add(t)), fbm(p.add(vec2(5.2, 1.3)).add(t)));
    const b = vec2(fbm(p.add(a.mul(warp))), fbm(p.add(a.mul(warp)).add(vec2(8.3, 2.8))));
    const warpedUv = uv().add(b.sub(0.5).mul(amount));

    return texNode(texture(rt.texture, warpedUv) as unknown as ColorNode, [...opts.input.passes, pass]);
  },
);
