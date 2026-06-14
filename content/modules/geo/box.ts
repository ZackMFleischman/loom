import { BuildCtx, defineModule, type GeoNode } from "@loom/runtime";
import { BoxGeometry } from "three/webgpu";
import { primitive, type PrimitiveOpts } from "./_primitive";

export interface BoxOpts extends PrimitiveOpts {
  /** Edge lengths (default unit-ish cube). */
  size?: [number, number, number];
}

/** A box mesh as a GeoNode — feed it to render3d (with orbitCam) to get pixels. */
export const box = defineModule(
  {
    name: "box",
    kind: "geo",
    description: "A box mesh (GeoNode) with live spin/tumble/glow/scale — render via render3d.",
    tags: ["3d", "primitive", "mesh", "geo"],
    example: 'box(ctx, { size: [1, 1, 1], spin: 0.8, color: "#3fb7f0" })',
  },
  (ctx: BuildCtx, opts: BoxOpts = {}): GeoNode => {
    const [w, h, d] = opts.size ?? [1, 1, 1];
    return primitive(ctx, new BoxGeometry(w, h, d), opts);
  },
);
