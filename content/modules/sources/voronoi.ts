import { asSignal, BuildCtx, defineModule, integrateSignal, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import { add, cos, float, floor, fract, length, min, sin, uv, vec2, vec3, vec4 } from "three/tsl";
import { surfaceAspect } from "../_shared";
import type { Node } from "three/webgpu";

export interface VoronoiOpts {
  /** Cells across the frame (bigger = busier). */
  scale?: SignalLike;
  /** Cell-point wander speed. */
  speed?: SignalLike;
  /** How far points wander from their cell center (0 = rigid grid). */
  jitter?: SignalLike;
}

/** Deterministic per-cell hash → 0..1 (sin-dot lattice, no tables). */
function cellHash(id: Node<"vec2">, k: number) {
  return fract(sin(add(id.x.mul(127.1 + k), id.y.mul(311.7 - k))).mul(43758.5453));
}

/**
 * Animated cellular noise (the TD Voronoi look): F1 distance to wandering
 * cell points, monochrome — compose with `colorize`/`paletteMap`, or feed it
 * to `displace` for organic warps. 3×3 neighborhood, unrolled.
 */
export const voronoi = defineModule(
  {
    name: "voronoi",
    kind: "source",
    description: "Animated Voronoi/cellular noise (F1 distance, monochrome).",
    tags: ["voronoi", "cellular", "organic", "texture"],
    example: 'voronoi(ctx, { scale: 6, speed: 0.4 })',
  },
  (ctx: BuildCtx, opts: VoronoiOpts = {}): TexNode => {
    const scale = ctx.uniformOf(opts.scale ?? 6);
    const jitter = ctx.uniformOf(opts.jitter ?? 1);
    // Frame-clock animation phase (never TSL time).
    const speedSig = asSignal(opts.speed ?? 0.4);
    const phase = ctx.uniformOf(integrateSignal(speedSig));

    const p = uv().mul(vec2(surfaceAspect(), 1)).mul(scale.max(0.5));
    const cell = floor(p);
    const frac = fract(p);

    let d: Node<"float"> = float(8);
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const off = vec2(ox, oy);
        const id = cell.add(off);
        const h1 = cellHash(id, 0);
        const h2 = cellHash(id, 7);
        // The cell point orbits its center — speeds/phases hashed per cell.
        const px = sin(phase.mul(h1.add(0.4)).add(h1.mul(31.4))).mul(0.5).add(0.5);
        const py = cos(phase.mul(h2.add(0.4)).add(h2.mul(27.2))).mul(0.5).add(0.5);
        const point = off.add(vec2(px, py).sub(0.5).mul(jitter).add(0.5));
        d = min(d, length(point.sub(frac)));
      }
    }
    const v = d.clamp(0, 1);
    return texNode(vec4(vec3(v), 1));
  },
);
