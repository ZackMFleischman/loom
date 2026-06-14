import { BuildCtx, defineModule, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import { cos, length, max, sin, uv, vec2, vec3, vec4 } from "three/tsl";
import { gearSdf, neonStroke, polygonSdf, surfaceAspect } from "../_shared";

export interface VectorShipOpts {
  /** Silhouette: regular polygon ("poly", use `sides`), spiky "star" (use `points`), or "ring". */
  shape?: "poly" | "star" | "ring";
  /** Polygon side count (poly): 3 = arrowhead/delta, 4 = diamond, 5/6 = ringship. */
  sides?: number;
  /** Star points / gear teeth (star). */
  points?: number;
  /** Star spike depth 0..1 (star only). */
  spike?: SignalLike;
  /** Center X / Y in uv (0..1). */
  x?: SignalLike;
  y?: SignalLike;
  /** Half-size in surface-height units. */
  size?: SignalLike;
  /** Heading in radians (the nose direction / spin). */
  rotate?: SignalLike;
  /** Neon stroke half-width in surface-height units. */
  thickness?: SignalLike;
  /** Thrust 0..1 — grows the engine flame behind the tail (feed energy/kick). */
  thrust?: SignalLike;
  /** Body palette stop (0..4). Default 2 (core). */
  colorStop?: number;
  /** Engine-flame palette stop (0..4). Default 4 (accent). */
  flameStop?: number;
  /** Overall brightness. */
  brightness?: SignalLike;
}

/**
 * A single glowing vector protagonist: a neon-outlined geometric hull (swap the
 * `shape`/`sides` to reskin the hero or a boss) with a hot engine flame trailing
 * its tail on the `thrust` signal. Premultiplied alpha — drop it on a `warpGrid`
 * with `over`/`mixer` and let `bloom` flare it. Frame-clocked & deterministic.
 */
export const vectorShip = defineModule(
  {
    name: "vectorShip",
    kind: "source",
    description:
      "A glowing neon vector hull (swappable shape) with a thrust flame — the twin-stick protagonist; premultiplied for over+bloom.",
    tags: ["arcade", "geometry-wars", "neon", "vector", "ship", "overlay", "audio-reactive"],
    example: 'vectorShip(ctx, { shape: "poly", sides: 3, thrust: ctx.input("energy") })',
  },
  (ctx: BuildCtx, opts: VectorShipOpts = {}): TexNode => {
    const kind = opts.shape ?? "poly";
    const sides = Math.max(3, Math.round(opts.sides ?? 3));
    const points = Math.max(3, Math.round(opts.points ?? 5));

    const size = ctx.uniformOf(opts.size ?? 0.12);
    const thickness = ctx.uniformOf(opts.thickness ?? 0.02);
    const rot = ctx.uniformOf(opts.rotate ?? 0);
    const thrust = ctx.uniformOf(opts.thrust ?? 0.3);
    const spike = ctx.uniformOf(opts.spike ?? 0.5);
    const bright = ctx.uniformOf(opts.brightness ?? 1);
    const cx = ctx.uniformOf(opts.x ?? 0.5);
    const cy = ctx.uniformOf(opts.y ?? 0.5);
    const colorStop = Math.max(0, Math.min(4, Math.round(opts.colorStop ?? 2)));
    const flameStop = Math.max(0, Math.min(4, Math.round(opts.flameStop ?? 4)));

    const asp = surfaceAspect();
    const q = uv().sub(vec2(cx, cy)).mul(vec2(asp, 1));
    // Rotate into hull space (nose toward +x).
    const c = cos(rot);
    const s = sin(rot);
    const p = vec2(c.mul(q.x).add(s.mul(q.y)), c.mul(q.y).sub(s.mul(q.x)));

    let sdf;
    if (kind === "ring") sdf = length(p).sub(size);
    else if (kind === "star") sdf = gearSdf(p, points, size, spike);
    else sdf = polygonSdf(p, sides, size);

    const hull = neonStroke(sdf, thickness, ctx.palette.color(colorStop));

    // Engine flame: a hot squashed teardrop trailing the tail (hull-space −x).
    const tail = p.sub(vec2(size.mul(-0.75), 0));
    const fd = length(tail.mul(vec2(0.75, 1.8)));
    const flame = thrust.mul(size.mul(0.7)).div(fd.add(0.03)).clamp(0, 1.6);
    const flameCol = ctx.palette.color(flameStop).add(vec3(0.4)).mul(flame.mul(thrust));

    const rgb = hull.rgb.add(flameCol).mul(bright);
    const a = max(hull.a, flame.clamp(0, 1)).mul(bright).clamp(0, 1);
    return texNode(vec4(rgb, a));
  },
);
