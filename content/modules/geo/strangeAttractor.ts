import { BuildCtx, defineModule, type GeoNode } from "@loom/runtime";
import { BufferGeometry, Float32BufferAttribute } from "three/webgpu";
import { primitive, type PrimitiveOpts } from "./_primitive";

export type AttractorKind = "lorenz" | "aizawa" | "thomas" | "halvorsen";

export interface StrangeAttractorOpts extends PrimitiveOpts {
  /** Which chaotic system to trace (each a distinct silhouette). */
  kind?: AttractorKind;
  /** How many trajectory points to plot (256..40000; pointCloud strides to fit its budget). */
  points?: number;
}

type Vec3 = [number, number, number];
interface System {
  start: Vec3;
  dt: number;
  deriv: (x: number, y: number, z: number) => Vec3;
}

/** Each system's tuned constants, step and a deterministic start (no Math.random). */
const SYSTEMS: Record<AttractorKind, System> = {
  lorenz: {
    start: [0.1, 0, 0],
    dt: 0.006,
    deriv: (x, y, z) => [10 * (y - x), x * (28 - z) - y, x * y - (8 / 3) * z],
  },
  aizawa: {
    start: [0.1, 0, 0],
    dt: 0.01,
    deriv: (x, y, z) => {
      const a = 0.95, b = 0.7, c = 0.6, d = 3.5, e = 0.25, ff = 0.1;
      return [
        (z - b) * x - d * y,
        d * x + (z - b) * y,
        c + a * z - (z * z * z) / 3 - (x * x + y * y) * (1 + e * z) + ff * z * x * x * x,
      ];
    },
  },
  thomas: {
    start: [1.1, 1.1, -0.01],
    dt: 0.05,
    deriv: (x, y, z) => {
      const b = 0.208;
      return [Math.sin(y) - b * x, Math.sin(z) - b * y, Math.sin(x) - b * z];
    },
  },
  halvorsen: {
    start: [-5, 0, 0],
    dt: 0.005,
    deriv: (x, y, z) => {
      const a = 1.89;
      return [-a * x - 4 * y - 4 * z - y * y, -a * y - 4 * z - 4 * x - z * z, -a * z - 4 * x - 4 * y - x * x];
    },
  },
};

/**
 * Plots a strange attractor's trajectory as a glowing 3D point set: a chaotic
 * ODE is integrated CPU-side into a vertex buffer (deterministic from a fixed
 * start — no Math.random), centred and normalised to a unit cube. Returns a
 * GeoNode — feed it to `pointCloud` and `render3d` with an `orbitCam` to reveal
 * the filamentary structure; spin/scale ride live like any primitive.
 *
 * Constants are baked per `kind` (changing the system rebuilds); the camera
 * orbit, point size, glow and spin are the live performance surface.
 */
export const strangeAttractor = defineModule(
  {
    name: "strangeAttractor",
    kind: "geo",
    description: "A chaotic attractor (Lorenz/Aizawa/Thomas/Halvorsen) traced as a glowing 3D point set — render via pointCloud.",
    tags: ["3d", "attractor", "chaos", "points", "strange-attractor", "generative", "geo"],
    example: 'pointCloud(ctx, { source: strangeAttractor(ctx, { kind: "lorenz", points: 16000 }) })',
  },
  (ctx: BuildCtx, opts: StrangeAttractorOpts = {}): GeoNode => {
    const sys = SYSTEMS[opts.kind ?? "lorenz"];
    const n = Math.max(256, Math.min(40_000, Math.round(opts.points ?? 16_000)));
    const warmup = 1000; // discard the transient before it settles onto the attractor

    let [x, y, z] = sys.start;
    const step = () => {
      const [dx, dy, dz] = sys.deriv(x, y, z);
      x += dx * sys.dt;
      y += dy * sys.dt;
      z += dz * sys.dt;
    };
    for (let i = 0; i < warmup; i++) step();

    const pos = new Float32Array(n * 3);
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; i++) {
      step();
      pos[i * 3] = x;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = z;
      const c: Vec3 = [x, y, z];
      for (let k = 0; k < 3; k++) {
        if (c[k]! < min[k]!) min[k] = c[k]!;
        if (c[k]! > max[k]!) max[k] = c[k]!;
      }
    }

    // Centre on the bounding box and normalise so the largest span fits [-1, 1].
    const center: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const span = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 1e-4);
    const s = 2 / span;
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (pos[i * 3]! - center[0]) * s;
      pos[i * 3 + 1] = (pos[i * 3 + 1]! - center[1]) * s;
      pos[i * 3 + 2] = (pos[i * 3 + 2]! - center[2]) * s;
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(pos, 3));
    // primitive() gives spin/tumble/scale; the mesh itself isn't added to the
    // world — pointCloud reads its vertices and follows its transform.
    return primitive(ctx, geometry, opts);
  },
);
