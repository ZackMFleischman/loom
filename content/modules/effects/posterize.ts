import { BuildCtx, defineModule, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import { floor, vec4 } from "three/tsl";

export interface PosterizeOpts {
  input: TexNode;
  /** Color steps per channel (2 = poster crush, 32 ≈ unnoticeable). */
  steps?: SignalLike;
}

/** Color quantization (the TD Quantize idiom) — pairs hilariously with paletteMap. */
export const posterize = defineModule(
  {
    name: "posterize",
    kind: "effect",
    description: "Quantizes colors to N steps per channel (poster/print-crush look).",
    tags: ["posterize", "quantize", "crush", "retro"],
    example: 'posterize(ctx, { input: src, steps: 4 })',
    chainParams: [
      { name: "steps", type: "int", default: 5, min: 2, max: 32, description: "color steps per channel" },
    ],
  },
  (ctx: BuildCtx, opts: PosterizeOpts): TexNode => {
    const steps = ctx.uniformOf(opts.steps ?? 5).max(2);
    const c = opts.input.color;
    const q = floor(c.rgb.mul(steps)).add(0.5).div(steps);
    return texNode(vec4(q, c.a), opts.input.passes);
  },
);
