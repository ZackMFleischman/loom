import { BuildCtx, defineModule, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import { length, smoothstep, uv, vec2, vec4 } from "three/tsl";
import { surfaceAspect } from "../_shared";

export interface VignetteOpts {
  input: TexNode;
  /** Darkening strength at the corners. */
  amount?: SignalLike;
  /** Radius where the falloff starts (in half-frame units). */
  radius?: SignalLike;
  /** Falloff width past the radius. */
  softness?: SignalLike;
}

/** Corner darkening — the finishing touch on almost any chain. Stateless. */
export const vignette = defineModule(
  {
    name: "vignette",
    kind: "effect",
    description: "Darkens the frame's corners (radius/softness/amount) — the classic finish.",
    tags: ["vignette", "finish", "frame"],
    example: 'vignette(ctx, { input: src, amount: 0.7 })',
    chainParams: [
      { name: "amount", default: 0.6, min: 0, max: 1, step: 0.01, description: "corner darkening" },
      { name: "radius", default: 0.7, min: 0.1, max: 1.5, step: 0.01, description: "falloff start" },
      { name: "softness", default: 0.5, min: 0.05, max: 1.5, step: 0.01, description: "falloff width" },
    ],
  },
  (ctx: BuildCtx, opts: VignetteOpts): TexNode => {
    const amount = ctx.uniformOf(opts.amount ?? 0.6).clamp(0, 1);
    const radius = ctx.uniformOf(opts.radius ?? 0.7);
    const softness = ctx.uniformOf(opts.softness ?? 0.5);
    const c = opts.input.color;
    const d = length(uv().sub(0.5).mul(vec2(surfaceAspect(), 1)));
    const fall = smoothstep(radius, radius.add(softness.max(0.01)), d);
    const dim = fall.mul(amount).oneMinus();
    return texNode(vec4(c.rgb.mul(dim), c.a), opts.input.passes);
  },
);
