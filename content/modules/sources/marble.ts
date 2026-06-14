import { asSignal, BuildCtx, defineModule, integrateSignal, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import { uv, vec2, vec4 } from "three/tsl";
import { fbm2, surfaceAspect } from "../_shared";

export interface MarbleOpts {
  /** Field scale (bigger = finer veining). */
  scale?: SignalLike;
  /** Domain-warp strength — how hard the noise folds itself (the marbling). */
  warp?: SignalLike;
  /** FBM octaves per noise lookup (compile-time, 1..6). */
  octaves?: number;
  /** Evolution speed of the marble (frame-clocked, never TSL time). */
  evolve?: SignalLike;
  /** Output contrast into the palette ramp. */
  contrast?: SignalLike;
}

/**
 * Iterated domain-warp "marble": fractal noise warped by fractal noise warped
 * by fractal noise — `fbm(p + fbm(p + fbm(p)))` — which folds flat FBM into
 * the swirled veins of marble, agate and oil-on-water. Outputs grayscale (the
 * fold value in every channel) — compose with `colorize`, `paletteMap` or a
 * scene palette ramp. Bass-breathe the `warp` or `scale` for a living slab.
 * Distinct from `noiseField` (a single-pass field) and `displace` (warps an
 * external input) — here the noise warps *itself*.
 */
export const marble = defineModule(
  {
    name: "marble",
    kind: "source",
    description: "Iterated domain-warp marble: fractal noise folded through itself into agate/oil veins (grayscale — colorize).",
    tags: ["marble", "domain-warp", "fbm", "noise", "organic", "generative"],
    example: 'marble(ctx, { scale: 3, warp: 4, evolve: 0.1 })',
  },
  (ctx: BuildCtx, opts: MarbleOpts = {}): TexNode => {
    const oct = Math.max(1, Math.min(6, Math.round(opts.octaves ?? 4)));
    const scale = ctx.uniformOf(opts.scale ?? 3);
    const warp = ctx.uniformOf(opts.warp ?? 4);
    const contrast = ctx.uniformOf(opts.contrast ?? 1.1);
    const t = ctx.uniformOf(integrateSignal(asSignal(opts.evolve ?? 0.1)));

    const p = uv().sub(0.5).mul(vec2(surfaceAspect(), 1)).mul(scale.max(0.1));
    const fbm = (q: Parameters<typeof fbm2>[0]) => fbm2(q, oct);

    // Two-level domain warp (IQ pattern), the inner level drifting on the clock.
    const q = vec2(fbm(p.add(vec2(0, 0))), fbm(p.add(vec2(5.2, 1.3)).add(t)));
    const r = vec2(
      fbm(p.add(q.mul(warp)).add(vec2(1.7, 9.2))),
      fbm(p.add(q.mul(warp)).add(vec2(8.3, 2.8)).add(t.mul(0.7))),
    );
    const v = fbm(p.add(r.mul(warp)));

    // Push contrast around mid; lace finer veins in from the first warp level.
    const shade = v.sub(0.5).mul(contrast).add(0.5).add(q.x.sub(0.5).mul(0.15)).clamp(0, 1);
    return texNode(vec4(shade, shade, shade, 1));
  },
);
