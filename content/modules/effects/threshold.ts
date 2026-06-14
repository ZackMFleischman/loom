import { BuildCtx, defineModule, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import { dot, smoothstep, vec3, vec4 } from "three/tsl";

export interface ThresholdOpts {
  input: TexNode;
  /** Luma level that survives (0..1). */
  level?: SignalLike;
  /** Edge softness around the level. */
  softness?: SignalLike;
}

/**
 * Luma threshold (the TD Threshold TOP): keeps pixels brighter than `level`,
 * masking the rest to transparent black — mask-maker and the bright-pass half
 * of bloom. Stateless.
 */
export const threshold = defineModule(
  {
    name: "threshold",
    kind: "effect",
    description: "Keeps pixels above a luma level (soft edge), masks the rest to transparent.",
    tags: ["threshold", "mask", "luma"],
    example: 'threshold(ctx, { input: src, level: 0.6, softness: 0.1 })',
    chainParams: [
      { name: "level", default: 0.5, min: 0, max: 1, step: 0.01, description: "luma cutoff" },
      { name: "softness", default: 0.05, min: 0, max: 0.5, step: 0.01, description: "edge softness" },
    ],
  },
  (ctx: BuildCtx, opts: ThresholdOpts): TexNode => {
    const level = ctx.uniformOf(opts.level ?? 0.5);
    const softness = ctx.uniformOf(opts.softness ?? 0.05);
    const c = opts.input.color;
    const luma = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
    const m = smoothstep(level.sub(softness).sub(0.0001), level.add(softness), luma);
    return texNode(vec4(c.rgb.mul(m), c.a.mul(m)), opts.input.passes);
  },
);
