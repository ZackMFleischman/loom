import { BuildCtx, defineModule, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import { float, uv, vec2, vec4 } from "three/tsl";
import type { Node } from "three/webgpu";
import { surfaceAspect } from "../_shared";
import type { GridInfluence } from "./warpGrid";

export interface WarpFieldOpts {
  /**
   * The crowd: one emitter per moving point (uv 0..1), each carrying the data a
   * visualization knows about it — `mass` (push/pull), `radius` (reach),
   * `swirl` (curl), `vx/vy` (velocity). Same shape as warpGrid's `GridInfluence`,
   * so a particle system feeds the field and `warpGrid` with one list.
   */
  emitters?: GridInfluence[];
  /** Vector gain before the signed encode — turn it up to make dents deeper. Default 3. */
  gain?: SignalLike;
  /** Glow (B channel) gain. Default 1. */
  glowGain?: SignalLike;
}

/**
 * Bakes a crowd of point emitters into a DISPLACEMENT FIELD texture: RG carry a
 * signed warp vector (0.5 = neutral), B a glow magnitude — exactly the format
 * `warpGrid`'s `field` input consumes. This is the reusable bridge for
 * "an arbitrary visualization bends the grid": render any particle system's
 * position/velocity/mass/curl into one of these (wrap it in `ctx.layer` so the
 * grid samples it once) and feed it to `warpGrid({ field })`. The field is also
 * a normal TexNode you can blur, scroll, or mix like any other. Frame-clocked.
 */
export const warpField = defineModule(
  {
    name: "warpField",
    kind: "source",
    description:
      "Bakes point emitters (position/mass/velocity/curl) into a displacement-field texture (RG = warp vector, B = glow) for warpGrid's `field` input — the bridge any visualization uses to bend the grid.",
    tags: ["grid", "warp", "field", "displacement", "particles", "geometry-wars", "utility"],
    example: 'warpGrid(ctx, { field: ctx.layer("wf", warpField(ctx, { emitters: crowd })) })',
  },
  (ctx: BuildCtx, opts: WarpFieldOpts = {}): TexNode => {
    const emitters = opts.emitters ?? [];
    const gain = ctx.uniformOf(opts.gain ?? 3);
    const glowGain = ctx.uniformOf(opts.glowGain ?? 1);

    const asp = surfaceAspect();
    const p = uv().sub(0.5).mul(vec2(asp, 1));

    let disp: Node<"vec2"> = vec2(0, 0);
    let glow: Node<"float"> = float(0);
    for (let i = 0; i < emitters.length; i++) {
      const e = emitters[i]!;
      const mass = ctx.uniformOf(e.mass ?? 1);
      const radius = ctx.uniformOf(e.radius ?? 0.2);
      const swirl = ctx.uniformOf(e.swirl ?? 0);
      const vx = ctx.uniformOf(e.vx ?? 0);
      const vy = ctx.uniformOf(e.vy ?? 0);
      const w = vec2(ctx.uniformOf(e.x).sub(0.5).mul(asp), ctx.uniformOf(e.y).sub(0.5));
      const toW = w.sub(p);
      const r2 = radius.mul(radius).add(1e-4);
      const fall = r2.div(toW.dot(toW).add(r2)); // 1 at the emitter → 0 past its radius
      disp = disp.add(toW.mul(mass.mul(fall))); // radial pull toward it
      disp = disp.add(vec2(toW.y.negate(), toW.x).mul(swirl.mul(fall))); // curl around it
      disp = disp.add(vec2(vx, vy).mul(fall)); // drag along its motion
      glow = glow.add(fall.mul(mass));
    }

    // Encode the signed warp vector into 0..1 RG (0.5 = neutral); B = glow.
    const rg = disp.mul(gain).clamp(-1, 1).mul(0.5).add(0.5);
    return texNode(vec4(rg.x, rg.y, glow.mul(glowGain).clamp(0, 1), 1));
  },
);
