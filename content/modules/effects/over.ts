import { BuildCtx, defineModule, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import { vec4 } from "three/tsl";

export interface OverOpts {
  /** The background layer. */
  input: TexNode;
  /** The foreground layer, composited on top via its alpha channel. */
  overlay: TexNode;
  /** Foreground opacity 0..1 — ride it to fade the overlay in and out. */
  opacity?: SignalLike;
}

/**
 * Alpha-composites one TexNode over another (premultiplied "over" operator —
 * imagePlate emits premultiplied alpha, so logos/stills drop straight on top
 * of any chain). Stateless; passes from both layers are preserved in order.
 */
export const over = defineModule(
  {
    name: "over",
    kind: "effect",
    description: "Alpha-composites an overlay TexNode on top of an input (logo/still overlays).",
    tags: ["composite", "overlay", "blend", "alpha"],
    example: 'over(ctx, { input: chain, overlay: imagePlate(ctx, { url: logoUrl }), opacity: 1 })',
    // Multi-input chain step: `over` is the reference case for a SECOND input
    // slot. The piped `input` is the background; `overlay` is bound per-step to
    // a SourceRef (another live instance, or an earlier step's output) and the
    // fold resolves it to a TexNode. `opacity` is the wet/dry of the overlay.
    chainParams: [
      { name: "opacity", default: 1, min: 0, max: 1, step: 0.01, description: "overlay opacity" },
    ],
    chainInputs: [
      { name: "overlay", kind: "tex", description: "foreground composited over the input" },
    ],
  },
  (ctx: BuildCtx, opts: OverOpts): TexNode => {
    const opacity = ctx.uniformOf(opts.opacity ?? 1);
    const fg = opts.overlay.color;
    const bg = opts.input.color;
    const fgA = fg.a.mul(opacity);
    const rgb = fg.rgb.mul(opacity).add(bg.rgb.mul(fgA.oneMinus()));
    const a = fgA.add(bg.a.mul(fgA.oneMinus()));
    return texNode(vec4(rgb, a), [...opts.input.passes, ...opts.overlay.passes]);
  },
);
