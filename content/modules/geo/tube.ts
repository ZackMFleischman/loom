import { BuildCtx, defineModule, type GeoNode } from "@loom/runtime";
import { CylinderGeometry } from "three/webgpu";
import { primitive, type PrimitiveOpts } from "./_primitive";

export interface TubeOpts extends PrimitiveOpts {
  /** Tube radius. */
  radius?: number;
  /** Tube length. */
  length?: number;
  /** Open-ended (beam) or capped (rod). */
  capped?: boolean;
  /** Lay it along Z (pointing at the camera) instead of upright. */
  axis?: "y" | "z";
}

/** A cylinder/beam — light shafts, tunnel ribs, rave lasers. */
export const tube = defineModule(
  {
    name: "tube",
    kind: "geo",
    description: "A cylinder beam (GeoNode) — light shafts and tunnel ribs, spin/glow live.",
    tags: ["3d", "primitive", "tube", "beam", "geo"],
    example: 'tube(ctx, { radius: 0.05, length: 3, glow: kickEnv, color: "#9ae6ff" })',
  },
  (ctx: BuildCtx, opts: TubeOpts = {}): GeoNode => {
    const geometry = new CylinderGeometry(
      opts.radius ?? 0.08,
      opts.radius ?? 0.08,
      opts.length ?? 2.5,
      24,
      1,
      !(opts.capped ?? false),
    );
    if ((opts.axis ?? "y") === "z") geometry.rotateX(Math.PI / 2);
    return primitive(ctx, geometry, opts);
  },
);
