import { BuildCtx, defineModule, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import { exp2, float, floor, fract, mix, screenSize, step, texture, uv, vec2 } from "three/tsl";
import type { Node } from "three/webgpu";
import { bufferPass } from "../_shared";

const BASE_ROWS = 720; // finest grid — visually identity at today's resolutions
const OCTAVES = 9; // amount 1 => BASE_ROWS / 2^9 ~ 1.4 giant blocks

export interface PixelateOpts {
  input: TexNode;
  /** Mosaic amount 0..1 — 0 is a true no-op (the buffer pass is skipped). */
  amount?: SignalLike;
}

/**
 * Mosaic pixelation: the input renders to a buffer and is re-sampled on a
 * block grid whose density slides down in octaves with `amount`. Two
 * adjacent grids are crossfaded by the fractional octave, so riding the
 * slider morphs smoothly instead of stepping. At amount 0 the output is the
 * untouched input and the buffer render is skipped — zero cost until used.
 */
export const pixelate = defineModule(
  {
    name: "pixelate",
    kind: "effect",
    description: "Smooth slider-driven mosaic pixelation; free when amount is 0.",
    tags: ["pixelate", "mosaic", "retro", "stateful"],
    example: 'pixelate(ctx, { input: src, amount: 0.4 })',
    chainParams: [{ name: "amount", default: 0.4, min: 0, max: 1, description: "mosaic amount (0 = off)" }],
  },
  (ctx: BuildCtx, opts: PixelateOpts): TexNode => {
    const amountIn = opts.amount ?? 0;
    const amount = ctx.uniformOf(amountIn);

    const { rt, pass } = bufferPass(opts.input, {
      // Idle gate: at amount 0 the buffer render is skipped — zero cost.
      skip: (f) => (typeof amountIn === "number" ? amountIn : amountIn.get(f)) <= 1e-5,
    });

    // Block grids one octave apart, crossfaded by the fractional level.
    const aspect = screenSize.x.div(screenSize.y);
    const level = amount.clamp(0, 1).mul(OCTAVES);
    const blockUv = (rows: Node<"float">) => {
      const n = vec2(rows.mul(aspect), rows);
      return floor(uv().mul(n)).add(0.5).div(n); // sample each block's center
    };
    const rows = float(BASE_ROWS).div(exp2(floor(level)));
    const coarse = texture(rt.texture, blockUv(rows));
    const coarser = texture(rt.texture, blockUv(rows.mul(0.5)));
    const mosaic = mix(coarse, coarser, fract(level).smoothstep(0, 1));

    // Uniform gate: identical input passthrough while the effect is idle.
    const active = step(float(1e-5), amount);
    const col = mix(opts.input.color, mosaic, active);
    return texNode(col, [...opts.input.passes, pass]);
  },
);
