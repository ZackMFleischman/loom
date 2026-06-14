import { BuildCtx, defineModule, integrateSignal, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import { atan, cos, float, fract, length, sin, uv, vec2 } from "three/tsl";
import { surfaceAspect } from "../_shared";

export interface GradientOpts {
  /** Ramp shape (compile-time): linear sweep, radial rings, or angular fan. */
  mode?: "linear" | "radial" | "angular";
  /** Linear mode: sweep direction in radians. */
  angle?: SignalLike;
  /** Scroll speed — the ramp drifts through the palette (cycles/sec). */
  scroll?: SignalLike;
  /** How many palette cycles fit across the frame. */
  repeat?: SignalLike;
}

/**
 * A palette ramp field (the TD Ramp TOP, palette-powered): linear/radial/
 * angular gradients across the active palette's five stops. The composable
 * sibling of the `gradient` scene — masks, displacer fodder, backdrops.
 */
export const gradient = defineModule(
  {
    name: "gradient",
    kind: "source",
    description: "Linear/radial/angular palette ramp — scrolling gradients across the active palette.",
    tags: ["gradient", "ramp", "palette", "base"],
    example: 'gradient(ctx, { mode: "radial", scroll: 0.05, repeat: 2 })',
  },
  (ctx: BuildCtx, opts: GradientOpts = {}): TexNode => {
    const angle = ctx.uniformOf(opts.angle ?? 0);
    const repeat = ctx.uniformOf(opts.repeat ?? 1);
    // Frame-clock scroll phase (never TSL time), wrapped so float precision
    // never degrades hours into a set.
    const phaseU = ctx.uniformOf(integrateSignal(opts.scroll ?? 0, { wrap: 1 }));

    const p = uv().sub(0.5).mul(vec2(surfaceAspect(), 1));
    const mode = opts.mode ?? "linear";
    const t =
      mode === "radial"
        ? length(p).mul(1.2)
        : mode === "angular"
          ? atan(p.y, p.x).div(Math.PI * 2).add(0.5)
          : p.x.mul(cos(angle)).add(p.y.mul(sin(angle))).add(0.5);
    return texNode(ctx.palette.ramp(fract(t.mul(repeat.max(0.01)).add(phaseU).add(float(2)))));
  },
);
