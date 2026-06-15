import { asSignal, BuildCtx, defineModule, type GeoNode, type SignalLike } from "@loom/runtime";
import {
  Color,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  OctahedronGeometry,
  Quaternion,
  TetrahedronGeometry,
  Vector3,
} from "three/webgpu";

export interface TornadoOpts {
  /** Funnel height in world units (base to mouth). */
  height?: SignalLike;
  /** Radius at the wide mouth (top). */
  topRadius?: SignalLike;
  /** Radius at the narrow base (bottom). */
  baseRadius?: SignalLike;
  /** Swirl speed — how fast the vortex spins (the base whips faster than the mouth). */
  swirl?: SignalLike;
  /** Climb speed — how fast particles rise and recycle through the funnel. */
  rise?: SignalLike;
  /** Storm surge (feed ctx.input("kick")) — flares the swirl + radial scatter on a hit. */
  surge?: SignalLike;
  /** Dust-mote count (fine dim points hugging the wall) — baked at build. */
  dust?: number;
  /** Spark-fleck count (bright warm sparks scattered through the column) — baked. */
  spark?: number;
  /** Debris-chunk count (larger tumbling shards) — baked. */
  debris?: number;
  /** Particle sizes (world units) per species. */
  dustSize?: SignalLike;
  sparkSize?: SignalLike;
  debrisSize?: SignalLike;
  /** Emissive colors "#rrggbb" per species. */
  dustColor?: string;
  sparkColor?: string;
  debrisColor?: string;
  /** Sim seed — deterministic so fixture replays are byte-identical. */
  seed?: number;
}

/** Deterministic PRNG (mulberry32) — no Math.random, so fixture replays match. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One particle species: a pool of instances riding the funnel profile. */
interface Species {
  mesh: InstancedMesh;
  n: number;
  h0: Float32Array; // height phase 0..1
  ang: Float32Array; // base angle
  rad: Float32Array; // radial jitter 0..1
  tumble: Float32Array; // self-spin rate (debris)
  size: ReturnType<typeof asSignal>;
}

/**
 * A literal tornado: a funnel of swirling instanced particles around a vertical
 * axis — narrow at the base, flaring to a wide mouth. "Debris storm" mix of
 * three species (fine dust, bright sparks, tumbling debris). The motion is
 * stateless (position is a pure function of f.now + a fixed per-particle phase),
 * so there's no spawn/cull bookkeeping and fixture replays are byte-identical.
 * The base whips faster than the mouth → the classic vortex shear. Render via
 * render3d; particles are emissive, so they read without lights.
 */
export const tornado = defineModule(
  {
    name: "tornado",
    kind: "geo",
    description:
      "A funnel of swirling instanced particles (dust/spark/debris storm) around a vertical vortex axis — render via render3d.",
    tags: ["3d", "particles", "tornado", "vortex", "storm", "audio-reactive", "geo"],
    example: 'tornado(ctx, { height: 2.4, swirl: 1, surge: ctx.input("kick") })',
  },
  (ctx: BuildCtx, opts: TornadoOpts = {}): GeoNode => {
    const height = asSignal(opts.height ?? 2.4);
    const topRadius = asSignal(opts.topRadius ?? 1.0);
    const baseRadius = asSignal(opts.baseRadius ?? 0.12);
    const swirl = asSignal(opts.swirl ?? 1.0);
    const rise = asSignal(opts.rise ?? 0.18);
    const surge = asSignal(opts.surge ?? 0);
    const rand = mulberry32(opts.seed ?? 0x701ad0);

    const group = new Group();

    const makeSpecies = (
      count: number,
      color: string,
      emissive: number,
      size: SignalLike,
      chunky: boolean,
    ): Species => {
      const n = Math.max(1, Math.min(8000, Math.round(count)));
      const geo = chunky ? new TetrahedronGeometry(1, 0) : new OctahedronGeometry(1, 0);
      const material = new MeshStandardMaterial({
        color: new Color("#000000"),
        emissive: new Color(color),
        emissiveIntensity: emissive,
        roughness: 1,
      });
      const mesh = new InstancedMesh(geo, material, n);
      mesh.frustumCulled = false; // positions live on the CPU; the bbox never updates
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      const h0 = new Float32Array(n);
      const ang = new Float32Array(n);
      const radJ = new Float32Array(n);
      const tumble = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        h0[i] = rand();
        ang[i] = rand() * Math.PI * 2;
        radJ[i] = rand();
        tumble[i] = chunky ? (rand() - 0.5) * 6 : 0;
      }
      group.add(mesh);
      return { mesh, n, h0, ang, rad: radJ, tumble, size: asSignal(size) };
    };

    const species: Species[] = [
      makeSpecies(opts.dust ?? 1400, opts.dustColor ?? "#cdd8ea", 0.7, opts.dustSize ?? 0.018, false),
      makeSpecies(opts.spark ?? 460, opts.sparkColor ?? "#ffd58a", 2.4, opts.sparkSize ?? 0.03, false),
      makeSpecies(opts.debris ?? 200, opts.debrisColor ?? "#7a5436", 0.5, opts.debrisSize ?? 0.05, true),
    ];

    const pos = new Vector3();
    const scl = new Vector3();
    const quat = new Quaternion();
    const axis = new Vector3(0.3, 1, 0.2).normalize();
    const mat = new Matrix4();

    ctx.updaters.push((f) => {
      const t = f.now;
      const H = Math.max(0.2, height.get(f));
      const rTop = Math.max(0.02, topRadius.get(f));
      const rBase = Math.max(0.0, baseRadius.get(f));
      const sw = swirl.get(f);
      const ri = rise.get(f);
      const sg = Math.max(0, surge.get(f));
      const spin = sw * (1 + sg * 1.5);
      const yBottom = -H * 0.5;

      for (let s = 0; s < species.length; s++) {
        const sp = species[s]!;
        const size = Math.max(0.001, sp.size.get(f)) * (1 + sg * 0.25);
        for (let i = 0; i < sp.n; i++) {
          // Height phase rises and wraps (the column climbs and recycles).
          let h = sp.h0[i]! + t * ri;
          h -= Math.floor(h); // frac → 0..1
          // Funnel profile: narrow base, flared mouth, curved wall.
          const profile = rBase + (rTop - rBase) * Math.pow(h, 1.5);
          const jitter = 0.04 + sp.rad[i]! * 0.14 * (1 + sg);
          const radius = profile * (0.86 + sp.rad[i]! * 0.28) + jitter * Math.sin(t * 1.7 + i);
          // Shear: the base spins faster than the mouth → vortex twist.
          const ang = sp.ang[i]! + t * spin * (0.5 + 1.0 / (0.25 + h));
          pos.set(Math.cos(ang) * radius, yBottom + h * H, Math.sin(ang) * radius);
          if (sp.tumble[i]! !== 0) quat.setFromAxisAngle(axis, t * sp.tumble[i]!);
          else quat.identity();
          scl.set(size, size, size);
          mat.compose(pos, quat, scl);
          sp.mesh.setMatrixAt(i, mat);
        }
        sp.mesh.count = sp.n;
        sp.mesh.instanceMatrix.needsUpdate = true;
      }
    });

    return { object: group };
  },
);
