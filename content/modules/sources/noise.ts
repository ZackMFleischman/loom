import { BuildCtx, defineModule, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import { mx_fractal_noise_float, uv, vec3, vec4 } from "three/tsl";

export interface NoiseOpts {
  /** Spatial scale (bigger = busier). */
  scale?: SignalLike;
  /** Temporal evolution speed. */
  speed?: SignalLike;
  /** FBM octaves (compile-time constant). */
  octaves?: number;
}

/** Animated fractal value noise, monochrome. */
export const noise = defineModule(
  {
    name: "noise",
    kind: "source",
    description: "Animated FBM noise field (monochrome).",
    tags: ["texture", "organic"],
    example: 'noise(ctx, { scale: 3, speed: 0.2 })',
  },
  (ctx: BuildCtx, opts: NoiseOpts = {}): TexNode => {
    const scale = ctx.uniformOf(opts.scale ?? 3);
    const speed = ctx.uniformOf(opts.speed ?? 0.2);
    // Frame-clock time, NOT TSL `time` (wall clock) — keeps fixture replays deterministic.
    const t = ctx.uniformOf(ctx.time.now);
    const p = vec3(uv().mul(scale), t.mul(speed));
    const n = mx_fractal_noise_float(p, opts.octaves ?? 3).mul(0.5).add(0.5);
    return texNode(vec4(vec3(n), 1));
  },
);
