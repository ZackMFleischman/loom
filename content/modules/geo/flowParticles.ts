import { asSignal, BuildCtx, defineModule, type GeoNode, type SignalLike } from "@loom/runtime";
import {
  Color,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  OctahedronGeometry,
  Quaternion,
  Vector3,
} from "three/webgpu";

export interface FlowParticlesOpts {
  /** Number of particles (compile-time). */
  count?: number;
  /** Flow strength — how fast particles ride the field. */
  speed?: SignalLike;
  /** Field scale (bigger = tighter vortices). */
  scale?: SignalLike;
  /** Slow evolution of the field itself (frame-clocked). */
  evolve?: SignalLike;
  /** Particle lifetime in seconds before it respawns (keeps the stream flowing). */
  lifetime?: SignalLike;
  /** Particle size in world units. */
  size?: SignalLike;
  /** Particle colour "#rrggbb" (emissive — reads without lights). */
  color?: string;
}

/** Seeded PRNG (mulberry32) — deterministic, no Math.random (fixture-safe). */
const mulberry32 = (seed: number) => () => {
  seed += 0x6d2b79f5;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/**
 * Particles advected through an ABC (Arnold–Beltrami–Childress) flow — a
 * divergence-free, chaotic vector field — so they stream along silky,
 * never-clumping streamlines, drawn as glowing points through `render3d`. The
 * field slowly evolves; particles respawn at their lifetime to keep the flow
 * alive. CPU advection (no neighbour interaction → cheap), seeded +
 * frame-clocked for fixture-identical replays. Distinct from the static
 * `noiseField` texture: here the motion *is* the visual.
 */
export const flowParticles = defineModule(
  {
    name: "flowParticles",
    kind: "geo",
    description: "Particles advected through a divergence-free ABC flow field — silky streamlines; render via render3d.",
    tags: ["3d", "particles", "flow", "curl", "advection", "audio-reactive", "geo"],
    example: 'render3d(ctx, { world: [flowParticles(ctx, { count: 3000, speed: ctx.input("bass") })], cam: orbitCam(ctx, {}) })',
  },
  (ctx: BuildCtx, opts: FlowParticlesOpts = {}): GeoNode => {
    const n = Math.max(16, Math.min(8000, Math.round(opts.count ?? 3000)));
    const speed = asSignal(opts.speed ?? 1);
    const scale = asSignal(opts.scale ?? 1.6);
    const evolve = asSignal(opts.evolve ?? 0.15);
    const lifetime = asSignal(opts.lifetime ?? 4);
    const sizeS = asSignal(opts.size ?? 0.012);

    const SPAN = 1.7; // particles live in a cube of this half-extent
    const rng = mulberry32(0x1eaf);

    const pos: Vector3[] = [];
    const age: number[] = [];
    const ttl: number[] = [];
    const spawn = (i: number) => {
      pos[i] = new Vector3((rng() - 0.5) * 2, (rng() - 0.5) * 2, (rng() - 0.5) * 2).multiplyScalar(SPAN);
      age[i] = 0;
      ttl[i] = 0.4 + rng() * 0.6; // fraction of the lifetime knob, scattered
    };
    for (let i = 0; i < n; i++) spawn(i);

    const material = new MeshStandardMaterial({
      color: new Color("#000000"),
      emissive: new Color(opts.color ?? "#7fd0ff"),
      emissiveIntensity: 1.5,
      roughness: 1,
    });
    const inst = new InstancedMesh(new OctahedronGeometry(1, 0), material, n);
    inst.instanceMatrix.setUsage(DynamicDrawUsage);
    inst.frustumCulled = false;

    let phase = 0;
    const v = new Vector3();
    const quat = new Quaternion();
    const mat = new Matrix4();
    const scl = new Vector3();

    ctx.updaters.push((f) => {
      const dt = Math.min(f.dt, 0.05);
      phase += evolve.get(f) * dt;
      const sp = speed.get(f);
      const k = Math.max(0.1, scale.get(f));
      const life = Math.max(0.2, lifetime.get(f));
      const s = Math.max(0.0008, sizeS.get(f));
      scl.set(s, s, s);

      for (let i = 0; i < n; i++) {
        const p = pos[i]!;
        // ABC flow (divergence-free): velocity from sines of the other axes.
        const x = p.x * k + phase;
        const y = p.y * k + phase;
        const z = p.z * k + phase;
        v.set(
          Math.sin(z) + Math.cos(y),
          Math.sin(x) + Math.cos(z),
          Math.sin(y) + Math.cos(x),
        ).multiplyScalar(sp * 0.35);
        p.addScaledVector(v, dt);

        age[i]! += dt;
        if (age[i]! > ttl[i]! * life || p.length() > SPAN * 1.6) spawn(i);

        mat.compose(p, quat, scl);
        inst.setMatrixAt(i, mat);
      }
      inst.count = n;
      inst.instanceMatrix.needsUpdate = true;
    });

    return { object: inst };
  },
);
