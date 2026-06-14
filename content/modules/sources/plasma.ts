import { asSignal, BuildCtx, defineModule, integrateSignal, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import { add, length, sin, uv, vec2 } from "three/tsl";
import { surfaceAspect } from "../_shared";

export interface PlasmaOpts {
  /** Field scale (bigger = tighter interference). */
  scale?: SignalLike;
  /** Evolution speed. */
  speed?: SignalLike;
}

/**
 * The classic demo-scene plasma: four interfering sine fields, colored
 * through the active palette's ramp — instant retro warmth, retints live.
 */
export const plasma = defineModule(
  {
    name: "plasma",
    kind: "source",
    description: "Classic sine-interference plasma, colored through the palette ramp.",
    tags: ["plasma", "retro", "interference", "palette"],
    example: 'plasma(ctx, { scale: 3, speed: 0.5 })',
  },
  (ctx: BuildCtx, opts: PlasmaOpts = {}): TexNode => {
    const scale = ctx.uniformOf(opts.scale ?? 3);
    // Frame-clock evolution (never TSL time).
    const speedSig = asSignal(opts.speed ?? 0.5);
    const phase = ctx.uniformOf(integrateSignal(speedSig));

    const p = uv().mul(vec2(surfaceAspect(), 1)).mul(scale.max(0.1));
    const v = add(
      add(sin(p.x.add(phase)), sin(p.y.add(phase.mul(1.31)))),
      add(sin(add(p.x, p.y).mul(0.7).add(phase.mul(0.7))), sin(length(p.sub(vec2(0.9, 0.5))).mul(2.1).sub(phase))),
    )
      .mul(0.125)
      .add(0.5);
    return texNode(ctx.palette.ramp(v.clamp(0, 1)));
  },
);
