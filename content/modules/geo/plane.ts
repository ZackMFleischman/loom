import { BuildCtx, defineModule, type GeoNode } from "@loom/runtime";
import { PlaneGeometry } from "three/webgpu";
import { primitive, type PrimitiveOpts } from "./_primitive";

export interface PlaneOpts extends PrimitiveOpts {
  /** Width × depth in world units. */
  size?: [number, number];
  /** Subdivisions per side — displacement (displaceGeo) needs them. */
  segments?: number;
  /** Lay it flat (floor/terrain, default) instead of upright (billboard). */
  flat?: boolean;
}

/** A subdivided plane — the substrate for displaceGeo terrain and pointCloud scanlines. */
export const plane = defineModule(
  {
    name: "plane",
    kind: "geo",
    description: "A subdivided plane mesh (GeoNode) — flat terrain substrate or upright billboard.",
    tags: ["3d", "primitive", "plane", "terrain", "geo"],
    example: 'plane(ctx, { size: [3, 2], segments: 48 })',
  },
  (ctx: BuildCtx, opts: PlaneOpts = {}): GeoNode => {
    const [w, d] = opts.size ?? [3, 2];
    const segs = Math.max(1, Math.min(128, Math.round(opts.segments ?? 48)));
    const geometry = new PlaneGeometry(w, d, segs, segs);
    if (opts.flat ?? true) geometry.rotateX(-Math.PI / 2); // lay it down
    return primitive(ctx, geometry, opts);
  },
);
