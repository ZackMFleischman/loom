import { BuildCtx, defineModule, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import { cos, sin, texture, uv, vec2, vec4 } from "three/tsl";
import { bufferPass } from "../_shared";

export interface RgbSplitOpts {
  input: TexNode;
  /** Split distance in uv units (0 = off). */
  amount?: SignalLike;
  /** Split direction in radians. */
  angle?: SignalLike;
}

/**
 * Chromatic aberration on a fader: R and B sample offset along an angle while
 * G holds — `glitch` bundles a pinch of this, but the solo effect rides clean.
 */
export const rgbSplit = defineModule(
  {
    name: "rgbSplit",
    kind: "effect",
    description: "RGB channel split (chromatic aberration) with live amount + angle.",
    tags: ["rgb", "aberration", "split", "glitch", "stateful"],
    example: 'rgbSplit(ctx, { input: src, amount: kickEnv.map((k) => k * 0.02) })',
    chainParams: [
      { name: "amount", default: 0.006, min: 0, max: 0.05, step: 0.0005, description: "split distance (uv)" },
      { name: "angle", default: 0, min: -3.1416, max: 3.1416, step: 0.01, description: "split direction (radians)" },
    ],
  },
  (ctx: BuildCtx, opts: RgbSplitOpts): TexNode => {
    const amount = ctx.uniformOf(opts.amount ?? 0.006);
    const angle = ctx.uniformOf(opts.angle ?? 0);
    const { rt, pass } = bufferPass(opts.input);

    const dir = vec2(cos(angle), sin(angle)).mul(amount);
    const r = texture(rt.texture, uv().add(dir)).r;
    const g = texture(rt.texture, uv());
    const b = texture(rt.texture, uv().sub(dir)).b;
    return texNode(vec4(r, g.g, b, g.a), [...opts.input.passes, pass]);
  },
);
