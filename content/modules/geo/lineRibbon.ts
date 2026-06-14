import { asSignal, BuildCtx, defineModule, type GeoNode, type SignalLike } from "@loom/runtime";
import {
  BoxGeometry,
  Color,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from "three/webgpu";

/** A polyline: an ordered list of points. Closed loops repeat the first point. */
export type RibbonPath = Vector3[];

export interface RibbonStyle {
  /** Hue position 0..1 along this ribbon's life — colorize via the consumer's ramp. */
  hue?: number;
}

export interface LineRibbonOpts {
  /**
   * Per-frame path provider. Return the polylines to draw THIS frame — the
   * growth/lsystem modules rebuild their geometry each frame and hand it here.
   * Called once per updater tick; keep it allocation-light (reuse arrays).
   */
  paths: () => RibbonPath[];
  /** Stroke half-thickness in world units (Signal-able — ride it on the bass). */
  width?: SignalLike;
  /** Instanced-segment budget (compile-time). Segments past this are dropped. */
  maxSegments?: number;
  /** Stroke colour "#rrggbb" (emissive — reads without scene lights). */
  color?: string;
  /** Emissive intensity (Signal-able — flare the whole stroke on the kick). */
  glow?: SignalLike;
}

/**
 * THE shared thin-stroke renderer (family-3 primitive): draws a set of
 * polylines as glowing instanced segment quads — one flat, thin box per edge,
 * oriented along the segment and joined end-to-end into a continuous ribbon.
 * The path set is rebuilt every frame from the `paths()` provider, so a growing
 * vertex set (differentialGrowth, lsystem) is re-uploaded each frame — hence
 * `DynamicDrawUsage` (the particleEmitter lesson). Returns a GeoNode: feed it to
 * `render3d` with an `orbitCam`. Both differentialGrowth and lsystem build on
 * this one renderer; a scene can also drive it directly with a static path set.
 */
export const lineRibbon = defineModule(
  {
    name: "lineRibbon",
    kind: "geo",
    description: "Polylines as glowing instanced segment-quad strokes (rebuilt per frame) — the shared ribbon renderer; render via render3d.",
    tags: ["3d", "line", "ribbon", "stroke", "polyline", "geo", "generative"],
    example: 'render3d(ctx, { world: [lineRibbon(ctx, { paths: () => myPolylines, width: 0.01 })], cam: orbitCam(ctx, {}) })',
  },
  (ctx: BuildCtx, opts: LineRibbonOpts): GeoNode => {
    const max = Math.max(16, Math.min(60_000, Math.round(opts.maxSegments ?? 12_000)));
    const width = asSignal(opts.width ?? 0.01);
    const glow = asSignal(opts.glow ?? 1.4);

    const material = new MeshStandardMaterial({
      color: new Color("#000000"),
      emissive: new Color(opts.color ?? "#9ae6ff"),
      emissiveIntensity: 1.4,
      roughness: 1,
    });
    // A unit segment box along +X, flat in Z (thin ribbon). Scaled to length×width.
    const geometry = new BoxGeometry(1, 1, 0.18);
    const inst = new InstancedMesh(geometry, material, max);
    inst.instanceMatrix.setUsage(DynamicDrawUsage); // rewritten every frame
    inst.frustumCulled = false;
    inst.count = 0;

    // Scratch — no per-frame allocation.
    const a = new Vector3();
    const b = new Vector3();
    const mid = new Vector3();
    const dir = new Vector3();
    const xAxis = new Vector3(1, 0, 0);
    const quat = new Quaternion();
    const scl = new Vector3();
    const mat = new Matrix4();

    ctx.updaters.push((f) => {
      const w = Math.max(0.0008, width.get(f));
      material.emissiveIntensity = Math.max(0, glow.get(f));
      const paths = opts.paths();
      let n = 0;
      for (let pi = 0; pi < paths.length && n < max; pi++) {
        const pts = paths[pi]!;
        for (let i = 0; i + 1 < pts.length && n < max; i++) {
          a.copy(pts[i]!);
          b.copy(pts[i + 1]!);
          dir.subVectors(b, a);
          const len = dir.length();
          if (len < 1e-6) continue;
          dir.divideScalar(len);
          quat.setFromUnitVectors(xAxis, dir);
          mid.addVectors(a, b).multiplyScalar(0.5);
          // Overlap segments slightly (len + w) so joints read as continuous.
          scl.set(len + w, w * 2, w * 2);
          mat.compose(mid, quat, scl);
          inst.setMatrixAt(n++, mat);
        }
      }
      inst.count = n;
      inst.instanceMatrix.needsUpdate = true;
    });

    return { object: inst };
  },
);
