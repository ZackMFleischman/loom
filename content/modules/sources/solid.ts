import { BuildCtx, defineModule, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import { vec3, vec4 } from "three/tsl";
import { parseHex } from "../_shared";

export interface SolidOpts {
  /** Flat color "#rrggbb" (ignored when paletteStop is set). */
  color?: string;
  /** Drive the color from a global palette stop 0..4 instead (retints live). */
  paletteStop?: number;
  /** Brightness multiplier — feed a kick for full-frame flashes. */
  level?: SignalLike;
}


/**
 * A flat color field (the TD Constant TOP). Degenerate but load-bearing: test
 * backdrops, strobe layers via `level`, chain inputs, palette swatches.
 */
export const solid = defineModule(
  {
    name: "solid",
    kind: "source",
    description: "A flat color field — backdrops, kick-driven flashes, palette swatches.",
    tags: ["color", "constant", "flash", "base"],
    example: 'solid(ctx, { paletteStop: 4, level: ctx.input("kick") })',
  },
  (ctx: BuildCtx, opts: SolidOpts = {}): TexNode => {
    const level = ctx.uniformOf(opts.level ?? 1);
    const rgb =
      opts.paletteStop != null ? ctx.palette.color(Math.max(0, Math.min(4, Math.round(opts.paletteStop)))) : vec3(...parseHex(opts.color ?? "#ffffff"));
    return texNode(vec4(rgb.mul(level.max(0)), 1));
  },
);
