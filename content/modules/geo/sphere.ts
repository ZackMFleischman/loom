import { BuildCtx, defineModule, type GeoNode } from "@loom/runtime";
import { SphereGeometry } from "three/webgpu";
import { primitive, type PrimitiveOpts } from "./_primitive";

export interface SphereOpts extends PrimitiveOpts {
  /** Sphere radius. */
  radius?: number;
  /** Mesh resolution (width segments; height follows). */
  detail?: number;
}

/** A sphere mesh as a GeoNode — feed it to render3d (with orbitCam) to get pixels. */
export const sphere = defineModule(
  {
    name: "sphere",
    kind: "geo",
    description: "A sphere mesh (GeoNode) with live spin/tumble/glow/scale — render via render3d.",
    tags: ["3d", "primitive", "mesh", "geo"],
    example: 'sphere(ctx, { radius: 0.6, glow: kickEnv, color: "#f03fb7" })',
  },
  (ctx: BuildCtx, opts: SphereOpts = {}): GeoNode => {
    const seg = Math.max(8, Math.round(opts.detail ?? 32));
    return primitive(ctx, new SphereGeometry(opts.radius ?? 0.6, seg, Math.round(seg * 0.75)), opts);
  },
);
