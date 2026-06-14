import { BuildCtx, defineModule, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import { abs, atan, cos, float, length, max, sin, smoothstep, uv, vec2, vec4 } from "three/tsl";
import { surfaceAspect } from "../_shared";

export interface ShapeOpts {
  /** Outline (compile-time): filled circle, ring, rect, or regular polygon. */
  kind?: "circle" | "ring" | "rect" | "poly";
  /** Polygon side count (compile-time, poly only). */
  sides?: number;
  /** Half-size in surface-height units (1 spans the frame's height). */
  radius?: SignalLike;
  /** Ring stroke width (ring only). */
  thickness?: SignalLike;
  /** Edge softness — 0 hard, ~0.2 glow-soft. */
  soft?: SignalLike;
  /** Center in uv space (0..1). */
  x?: SignalLike;
  y?: SignalLike;
  /** In-plane spin (radians) — visible on rect/poly. */
  rotate?: SignalLike;
  /** Fill from a palette stop 0..4 (default stop 4, the accent). */
  paletteStop?: number;
}

/**
 * A parametric 2D shape with premultiplied alpha (the TD Circle/Rectangle
 * TOP): SDF circle/ring/rect/polygon, soft-edged, palette-colored — the
 * "I just need a dot/ring/frame" primitive. Layer with `over`.
 */
export const shape = defineModule(
  {
    name: "shape",
    kind: "source",
    description: "SDF circle/ring/rect/polygon with soft edges and palette fill (premultiplied alpha).",
    tags: ["shape", "circle", "ring", "mask", "base"],
    example: 'shape(ctx, { kind: "ring", radius: kickEnv, thickness: 0.04, soft: 0.05 })',
  },
  (ctx: BuildCtx, opts: ShapeOpts = {}): TexNode => {
    const radius = ctx.uniformOf(opts.radius ?? 0.3);
    const thickness = ctx.uniformOf(opts.thickness ?? 0.05);
    const soft = ctx.uniformOf(opts.soft ?? 0.02);
    const cx = ctx.uniformOf(opts.x ?? 0.5);
    const cy = ctx.uniformOf(opts.y ?? 0.5);
    const rot = ctx.uniformOf(opts.rotate ?? 0);

    const q = uv().sub(vec2(cx, cy)).mul(vec2(surfaceAspect(), 1));
    const c = cos(rot);
    const s = sin(rot);
    const p = vec2(c.mul(q.x).add(s.mul(q.y)), c.mul(q.y).sub(s.mul(q.x)));

    const kind = opts.kind ?? "circle";
    let d; // signed-ish distance to the shape edge (negative inside)
    if (kind === "rect") {
      const b = abs(p).sub(radius.max(0.001));
      d = max(b.x, b.y);
    } else if (kind === "poly") {
      const n = Math.max(3, Math.round(opts.sides ?? 6));
      const ang = atan(p.y, p.x);
      const seg = (Math.PI * 2) / n;
      const a = ang.sub(ang.div(seg).floor().mul(seg)).sub(seg / 2);
      d = length(p).mul(cos(a)).sub(radius.max(0.001));
    } else {
      d = length(p).sub(radius.max(0.001));
    }
    const edge = kind === "ring" ? abs(d).sub(thickness.mul(0.5)) : d;
    const a = smoothstep(soft.max(1e-4), float(0), edge);

    const fill = ctx.palette.color(Math.max(0, Math.min(4, Math.round(opts.paletteStop ?? 4))));
    return texNode(vec4(fill.mul(a), a)); // premultiplied
  },
);
