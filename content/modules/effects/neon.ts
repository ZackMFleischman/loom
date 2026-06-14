import { BuildCtx, defineModule, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import { clamp, mix, vec3, vec4 } from "three/tsl";

export interface NeonOpts {
  input: TexNode;
  /** Overall tube brightness (~1). Drive with a kick envelope to surge the sign. */
  intensity?: SignalLike;
  /** 0..1 multiply on the glow — feed a flicker signal for failing-neon dropouts (default 1 = steady). */
  flicker?: SignalLike;
  /** Palette stop (0..4) for the tube's saturated body color (compile-time, default 4 = accent). */
  bodyStop?: number;
  /** How white-hot the tube core burns, 0..1 (default 0.85). */
  core?: SignalLike;
}

/**
 * Turns a premultiplied stroke/mask source (text, shapes, line art) into a
 * glowing neon tube: the coverage becomes a saturated palette-colored body
 * with a white-hot center, multiplied by a flicker term so the sign can buzz
 * and drop out. Emits premultiplied alpha with HDR-bright cores (rgb > alpha)
 * so a following `bloom` blooms the halo and `over` drops it onto a dark wall.
 * Pair it with bloom for the full storefront-neon look.
 */
export const neon = defineModule(
  {
    name: "neon",
    kind: "effect",
    description: "Turns a stroke/mask source into a glowing neon tube (white-hot core, palette body, flicker) — premultiplied for over+bloom.",
    tags: ["neon", "glow", "tube", "sign", "stylize"],
    example: 'neon(ctx, { input: text(ctx, { text: "PHO" }), intensity: kickEnv, flicker })',
    chainParams: [
      { name: "intensity", default: 1, min: 0, max: 3, description: "overall tube brightness" },
      { name: "flicker", default: 1, min: 0, max: 1, description: "0..1 glow multiply (failing-neon dropout)" },
      { name: "core", default: 0.85, min: 0, max: 1, description: "white-hot center amount" },
    ],
  },
  (ctx: BuildCtx, opts: NeonOpts): TexNode => {
    const intensity = ctx.uniformOf(opts.intensity ?? 1);
    const flicker = ctx.uniformOf(opts.flicker ?? 1);
    const coreAmt = ctx.uniformOf(opts.core ?? 0.3);

    // Coverage of the stroke art is the tube mask (premultiplied sources put it
    // in alpha). Flat coverage carries no cross-section, so the tube keeps its
    // saturated body color with a slight white lift — the bloom that follows is
    // what reads as the hot gas glow, and it stays tinted at a moderate level.
    const mask = opts.input.color.a;
    const bodyCol = ctx.palette.color(Math.max(0, Math.min(4, Math.round(opts.bodyStop ?? 4))));
    const tube = mix(bodyCol, vec3(1, 1, 1), coreAmt);

    const drive = flicker.mul(intensity);
    const alpha = clamp(mask.mul(flicker), 0, 1);
    // Premultiplied; rgb can exceed alpha (HDR) so a following bloom catches the tube.
    const rgb = tube.mul(mask).mul(drive);
    return texNode(vec4(rgb, alpha), opts.input.passes);
  },
);
