import { BuildCtx, defineModule, type GeoNode } from "@loom/runtime";
import { TorusGeometry } from "three/webgpu";
import { primitive, type PrimitiveOpts } from "./_primitive";

export interface TorusOpts extends PrimitiveOpts {
  /** Ring radius (center to tube center). */
  radius?: number;
  /** Tube thickness. */
  tube?: number;
}

/** A torus mesh as a GeoNode — feed it to render3d (with orbitCam) to get pixels. */
export const torus = defineModule(
  {
    name: "torus",
    kind: "geo",
    description: "A torus mesh (GeoNode) with live spin/tumble/glow/scale — render via render3d.",
    tags: ["3d", "primitive", "mesh", "geo"],
    example: 'torus(ctx, { radius: 0.7, tube: 0.22, tumble: 0.5 })',
  },
  (ctx: BuildCtx, opts: TorusOpts = {}): GeoNode => {
    return primitive(ctx, new TorusGeometry(opts.radius ?? 0.7, opts.tube ?? 0.22, 24, 64), opts);
  },
);
