import { BuildCtx, defineModule, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import { dot, length, smoothstep, vec3, vec4 } from "three/tsl";
import { parseHex } from "../_shared";

export interface KeyOpts {
  input: TexNode;
  /** Keying mode (compile-time): color distance or luma range. */
  mode?: "chroma" | "luma";
  /** Chroma mode: the color keyed OUT, "#rrggbb" (default green screen). */
  keyColor?: string;
  /** Match tolerance — how far from the key still keys out. */
  tolerance?: SignalLike;
  /** Edge softness past the tolerance. */
  softness?: SignalLike;
}


/**
 * Chroma/luma keyer (the TD Chroma Key TOP): keys a color (or dark lumas) to
 * transparency — any clip or camera becomes an `over` layer. Premultiplied
 * output. Stateless.
 */
export const key = defineModule(
  {
    name: "key",
    kind: "effect",
    description: "Keys a color (chroma) or dark pixels (luma) to transparency for layering.",
    tags: ["key", "chroma", "luma", "alpha", "layer"],
    example: 'key(ctx, { input: cam, mode: "luma", tolerance: 0.25 })',
    chainParams: [
      { name: "tolerance", default: 0.3, min: 0, max: 1, step: 0.01, description: "how much keys out" },
      { name: "softness", default: 0.1, min: 0.001, max: 0.5, step: 0.01, description: "edge softness" },
    ],
  },
  (ctx: BuildCtx, opts: KeyOpts): TexNode => {
    const tolerance = ctx.uniformOf(opts.tolerance ?? 0.3);
    const softness = ctx.uniformOf(opts.softness ?? 0.1);
    const c = opts.input.color;

    // 0 = keyed out, 1 = kept.
    const keep =
      (opts.mode ?? "chroma") === "luma"
        ? smoothstep(tolerance, tolerance.add(softness.max(0.001)), dot(c.rgb, vec3(0.2126, 0.7152, 0.0722)))
        : smoothstep(tolerance, tolerance.add(softness.max(0.001)), length(c.rgb.sub(vec3(...parseHex(opts.keyColor ?? "#00ff00")))));

    return texNode(vec4(c.rgb.mul(keep), c.a.mul(keep)), opts.input.passes);
  },
);
