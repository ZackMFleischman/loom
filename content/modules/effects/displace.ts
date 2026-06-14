import { asSignal, BuildCtx, defineModule, integrateSignal, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import { mx_fractal_noise_float, texture, uv, vec2, vec3, vec4 } from "three/tsl";
import { bufferPass } from "../_shared";

export interface DisplaceOpts {
  input: TexNode;
  /** Displacer TexNode — its R/G (−0.5-centered) push the input's UVs. Omit for built-in noise. */
  map?: TexNode;
  /** Warp strength in uv units. */
  amount?: SignalLike;
  /** Built-in noise displacer: spatial scale. */
  scale?: SignalLike;
  /** Built-in noise displacer: evolution speed. */
  speed?: SignalLike;
}

/**
 * UV displacement (THE TouchDesigner staple, the Displace TOP): the input is
 * buffered and re-sampled where a displacer map pushes it. Feed `voronoi`/
 * `noise`/`video` as the map in scenes; as a chain step it carries its own
 * animated fractal-noise displacer.
 */
export const displace = defineModule(
  {
    name: "displace",
    kind: "effect",
    description: "Warps the input's UVs by a displacer map (or built-in animated noise).",
    tags: ["displace", "warp", "organic", "stateful"],
    example: 'displace(ctx, { input: src, map: voronoi(ctx, {}), amount: 0.08 })',
    chainParams: [
      { name: "amount", default: 0.06, min: 0, max: 0.4, step: 0.005, description: "warp strength (uv units)" },
      { name: "scale", default: 3, min: 0.5, max: 12, step: 0.1, description: "noise displacer scale" },
      { name: "speed", default: 0.4, min: 0, max: 3, step: 0.05, description: "noise displacer speed" },
    ],
  },
  (ctx: BuildCtx, opts: DisplaceOpts): TexNode => {
    const amount = ctx.uniformOf(opts.amount ?? 0.06);
    const { rt, pass } = bufferPass(opts.input);

    let offset;
    if (opts.map) {
      const m = opts.map.color;
      offset = vec2(m.r.sub(0.5), m.g.sub(0.5));
    } else {
      // Built-in displacer: two decorrelated fractal-noise fields on the frame clock.
      const scale = ctx.uniformOf(opts.scale ?? 3);
      const speedSig = asSignal(opts.speed ?? 0.4);
      const phase = ctx.uniformOf(integrateSignal(speedSig));
      const p = vec3(uv().mul(scale), phase);
      offset = vec2(
        mx_fractal_noise_float(p, 2),
        mx_fractal_noise_float(p.add(vec3(13.7, 5.1, 0)), 2),
      ).mul(0.5);
    }

    const duv = uv().add(offset.mul(amount));
    const s = texture(rt.texture, duv);

    const passes = opts.map ? [...opts.input.passes, ...opts.map.passes, pass] : [...opts.input.passes, pass];
    return texNode(vec4(s.rgb, s.a), passes);
  },
);
