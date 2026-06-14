import { BuildCtx, defineModule, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import { mix, vec3, vec4 } from "three/tsl";

export interface InvertOpts {
  input: TexNode;
  /** 0 = unchanged · 1 = fully inverted (ride it on a kick). */
  amount?: SignalLike;
}

/** Color inversion with a blend amount — the negative flash. */
export const invert = defineModule(
  {
    name: "invert",
    kind: "effect",
    description: "Inverts colors, blendable 0..1 — the negative flash.",
    tags: ["invert", "negative", "flash"],
    example: 'invert(ctx, { input: src, amount: ctx.input("kick") })',
    chainParams: [
      { name: "amount", default: 1, min: 0, max: 1, step: 0.01, description: "inversion blend" },
    ],
  },
  (ctx: BuildCtx, opts: InvertOpts): TexNode => {
    const amount = ctx.uniformOf(opts.amount ?? 1).clamp(0, 1);
    const c = opts.input.color;
    return texNode(vec4(mix(c.rgb, vec3(1, 1, 1).sub(c.rgb), amount), c.a), opts.input.passes);
  },
);
