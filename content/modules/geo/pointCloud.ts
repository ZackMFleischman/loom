import { asSignal, BuildCtx, defineModule, type GeoNode, type SignalLike } from "@loom/runtime";
import {
  Color,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  OctahedronGeometry,
  Quaternion,
  Vector3,
  type BufferAttribute,
} from "three/webgpu";

export interface PointCloudOpts {
  /** The GeoNode whose vertices become points. */
  source: GeoNode;
  /** Point size in world units. */
  size?: SignalLike;
  /** Point color "#rrggbb" (emissive — reads without lights). */
  color?: string;
  /** Instance budget (compile-time; vertices are strided down to fit). */
  maxPoints?: number;
  /** Keep following the source every frame (displaced/spinning meshes). */
  follow?: boolean;
}

/**
 * Draws a mesh's VERTICES as glowing instanced points (the SOP-to-points /
 * Rutt-Etra display idiom). Follows the source's world transform — and its
 * live vertex displacement — every frame. Add the source itself to the world
 * too (dim it) or show points alone.
 */
export const pointCloud = defineModule(
  {
    name: "pointCloud",
    kind: "geo",
    description: "A mesh's vertices as glowing instanced points (follows displacement live).",
    tags: ["3d", "points", "wireframe", "rutt-etra", "geo"],
    example: 'pointCloud(ctx, { source: displacedPlane, size: 0.012, color: "#9ae6ff" })',
  },
  (ctx: BuildCtx, opts: PointCloudOpts): GeoNode => {
    const max = Math.max(64, Math.min(20_000, Math.round(opts.maxPoints ?? 6000)));
    const size = asSignal(opts.size ?? 0.012);
    const follow = opts.follow ?? true;

    const material = new MeshStandardMaterial({
      color: new Color("#000000"),
      emissive: new Color(opts.color ?? "#9ae6ff"),
      emissiveIntensity: 1.5,
      roughness: 1,
    });
    const inst = new InstancedMesh(new OctahedronGeometry(1, 0), material, max);
    inst.instanceMatrix.setUsage(DynamicDrawUsage); // M8 lesson: re-upload every frame
    inst.frustumCulled = false;
    inst.count = 0;

    let srcMesh: Mesh | null = null;
    let stride = 1;
    let placed = false;
    const mat = new Matrix4();
    const quat = new Quaternion();
    const p = new Vector3();
    const one = new Vector3();

    ctx.updaters.push((f) => {
      if (srcMesh == null) {
        opts.source.object.traverse((o) => {
          const m = o as Mesh;
          if (srcMesh == null && m.isMesh && m.geometry?.attributes?.position != null) srcMesh = m;
        });
        // (cast: TS can't see the traverse-callback assignment above)
        const found = srcMesh as Mesh | null;
        if (found == null) return;
        const count = (found.geometry.attributes.position as BufferAttribute).count;
        stride = Math.max(1, Math.ceil(count / max));
      }
      const m = srcMesh as Mesh | null;
      if (m == null || (placed && !follow)) return;

      m.updateWorldMatrix(true, false);
      const pos = m.geometry.attributes.position as BufferAttribute;
      const s = Math.max(0.0005, size.get(f));
      one.set(s, s, s);
      let n = 0;
      for (let i = 0; i < pos.count && n < max; i += stride) {
        p.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
        mat.compose(p, quat, one);
        inst.setMatrixAt(n++, mat);
      }
      inst.count = n;
      inst.instanceMatrix.needsUpdate = true;
      placed = true;
    });

    return { object: inst };
  },
);
