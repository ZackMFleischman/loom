import { BuildCtx, defineModule, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import { dot, fract, vec3 } from "three/tsl";

export interface PaletteMapOpts {
  /** Any source/effect output to recolor. */
  input: TexNode;
  /** Scroll offset added to the ramp lookup coordinate (wraps 0..1). */
  shift?: SignalLike;
  /** Luminance multiplier before the ramp lookup (banding/contrast). */
  gain?: SignalLike;
}

/**
 * Recolors an input's luminance through the active GLOBAL palette ramp (R7) —
 * the palette-native sibling of colorize (which only knows the cosine PALETTES
 * presets). Because it calls ctx.palette.ramp, any scene using it auto-declares
 * palette.source and is live-retintable (flip primary/secondary/own, no rebuild).
 */
export const paletteMap = defineModule(
  {
    name: "paletteMap",
    kind: "effect",
    description: "Recolors an input's luminance through the active global palette ramp.",
    tags: ["color", "palette", "ramp", "grade"],
    example: 'paletteMap(ctx, { input: src, shift: scrollSig })',
    chainParams: [
      { name: "shift", default: 0, min: 0, max: 1, step: 0.01, description: "scroll along the palette ramp" },
      { name: "gain", default: 1, min: 0, max: 4, step: 0.01, description: "luminance gain before lookup" },
    ],
  },
  (ctx: BuildCtx, opts: PaletteMapOpts): TexNode => {
    const shift = ctx.uniformOf(opts.shift ?? 0);
    const gain = ctx.uniformOf(opts.gain ?? 1);
    const lum = dot(opts.input.color.rgb, vec3(0.299, 0.587, 0.114));
    const t = fract(lum.mul(gain).add(shift));
    return texNode(ctx.palette.ramp(t), opts.input.passes);
  },
);
