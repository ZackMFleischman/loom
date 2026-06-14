import { asSignal, BuildCtx, defineModule, type GeoNode, type SignalLike } from "@loom/runtime";
import {
  Box3,
  Color,
  Group,
  Mesh,
  MeshStandardMaterial,
  Vector3,
  type Material,
  type Object3D,
  type Texture,
} from "three/webgpu";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

/** Path-style URL for a model OUTSIDE the repo, served by loom:media's mediafs
 * route — relative texture references resolve naturally. `rootIndex` indexes
 * content/state/media-roots.json's roots; `relPath` is relative to that root. */
export function mediaFsUrl(rootIndex: number, relPath: string): string {
  const rel = relPath.split(/[\\/]+/).map(encodeURIComponent).join("/");
  return `/loom/mediafs/${rootIndex}/${rel}`;
}

export interface ModelOpts {
  /** Model URL — .glb/.gltf or .fbx; repo asset URL or mediaFsUrl(...). */
  url: string;
  /** Normalized height after loading (the model is recentered + scaled to this). */
  fit?: number;
  /** Spin speed around Y in rad/s (integrated). */
  spin?: SignalLike;
  /** Uniform scale multiplier on top of `fit` (Signal-able). */
  scale?: SignalLike;
  /** Static placement. */
  position?: [number, number, number];
}

/**
 * Load a 3D model file as a GeoNode: glTF (.glb/.gltf) or FBX (.fbx, textures
 * resolve relative to the model). Loads async into a placeholder group — the
 * mesh pops in when ready, recentered on its bounding-box center and scaled so
 * its height equals `fit`. A missing/unparseable file logs and stays empty
 * (never throws the build).
 */
export const model = defineModule(
  {
    name: "model",
    kind: "geo",
    description: "A glTF/FBX model file as a GeoNode (auto-centered + height-normalized), spin live.",
    tags: ["3d", "model", "gltf", "fbx", "mesh", "geo"],
    example: 'model(ctx, { url: mediaFsUrl(0, "3DModels/Hippo3D/Hippopotamus 3D Model.fbx"), spin: 0.5 })',
  },
  (ctx: BuildCtx, opts: ModelOpts): GeoNode => {
    const group = new Group();
    const inner = new Group();
    group.add(inner);

    const fit = opts.fit ?? 1;
    const attach = (object: Object3D) => {
      // Normalize every material to MeshStandardMaterial (keep color + diffuse
      // map). Loader-specific materials — FBX phong with layered/exotic
      // textures — can throw inside the render backend, which would freeze the
      // instance (NFR-2). Plain standard materials render everywhere.
      object.traverse((o) => {
        const mesh = o as Mesh;
        if (!mesh.isMesh) return;
        const src = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as
          | (Material & { color?: Color; map?: Texture | null })
          | undefined;
        mesh.material = new MeshStandardMaterial({
          color: src?.color instanceof Color ? src.color.clone() : new Color("#bcbcbc"),
          map: src?.map ?? null,
          metalness: 0.05,
          roughness: 0.7,
        });
      });
      const bounds = new Box3().setFromObject(object);
      const size = bounds.getSize(new Vector3());
      const center = bounds.getCenter(new Vector3());
      const s = size.y > 1e-6 ? fit / size.y : 1;
      object.position.sub(center); // recenter on the bbox center
      inner.scale.setScalar(s);
      inner.add(object);
    };
    const fail = (err: unknown) =>
      console.warn(`[loom] model "${opts.url}" failed to load — node stays empty`, err);

    const lower = opts.url.toLowerCase().split("?")[0] ?? "";
    try {
      if (lower.endsWith(".fbx")) {
        new FBXLoader().load(opts.url, attach, undefined, fail);
      } else {
        new GLTFLoader().load(opts.url, (gltf) => attach(gltf.scene), undefined, fail);
      }
    } catch (err) {
      fail(err); // a loader throwing synchronously must never kill the build
    }

    if (opts.position) group.position.set(...opts.position);
    const spin = asSignal(opts.spin ?? 0);
    const scale = asSignal(opts.scale ?? 1);
    ctx.updaters.push((f) => {
      group.rotation.y += spin.get(f) * f.dt;
      group.scale.setScalar(Math.max(0.001, scale.get(f)));
    });

    return { object: group };
  },
);
