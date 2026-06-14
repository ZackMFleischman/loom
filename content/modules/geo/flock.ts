import { asSignal, BuildCtx, defineModule, type GeoNode, type SignalLike } from "@loom/runtime";
import {
  Color,
  ConeGeometry,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from "three/webgpu";

export interface FlockOpts {
  /** Number of boids (compile-time; CPU O(n²) neighbour search — keep ≤ ~400). */
  count?: number;
  /** Overall flight speed multiplier. */
  speed?: SignalLike;
  /** Separation weight — push off close neighbours (avoid collisions). */
  separation?: SignalLike;
  /** Alignment weight — match neighbours' heading. */
  alignment?: SignalLike;
  /** Cohesion weight — steer toward the local centre of mass. */
  cohesion?: SignalLike;
  /** Boid size (cone length in world units). */
  size?: SignalLike;
  /** Boid colour "#rrggbb" (emissive — reads without lights). */
  color?: string;
}

/** Seeded PRNG (mulberry32) — deterministic init, no Math.random (fixture-safe). */
const mulberry32 = (seed: number) => () => {
  let t = (seed += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/**
 * A boids flock as a GeoNode: classic separation / alignment / cohesion
 * steering simulated on the CPU each frame, drawn as oriented cones (each
 * points along its heading) through `render3d`. The three weights ride live as
 * signals — wire audio to `cohesion`/`separation` to make the swarm gather and
 * scatter. Seeded + frame-clocked, so fixture replays match.
 */
export const flock = defineModule(
  {
    name: "flock",
    kind: "geo",
    description: "A boids flock (separation/alignment/cohesion) as oriented instances — render via render3d.",
    tags: ["3d", "boids", "flocking", "agents", "particles", "audio-reactive", "geo"],
    example: 'render3d(ctx, { world: [flock(ctx, { count: 220, cohesion: ctx.input("bass") })], cam: orbitCam(ctx, {}) })',
  },
  (ctx: BuildCtx, opts: FlockOpts = {}): GeoNode => {
    const n = Math.max(8, Math.min(400, Math.round(opts.count ?? 220)));
    const speed = asSignal(opts.speed ?? 1);
    const sepW = asSignal(opts.separation ?? 1.4);
    const aliW = asSignal(opts.alignment ?? 1.0);
    const cohW = asSignal(opts.cohesion ?? 0.9);
    const sizeS = asSignal(opts.size ?? 0.05);

    const BOUND = 1.6; // soft spherical cage radius
    const RADIUS = 0.45; // neighbour perception radius
    const rng = mulberry32(0x5eed);

    const pos: Vector3[] = [];
    const vel: Vector3[] = [];
    for (let i = 0; i < n; i++) {
      pos.push(new Vector3((rng() - 0.5) * 2, (rng() - 0.5) * 2, (rng() - 0.5) * 2).multiplyScalar(BOUND * 0.7));
      vel.push(new Vector3(rng() - 0.5, rng() - 0.5, rng() - 0.5).multiplyScalar(0.4));
    }

    const material = new MeshStandardMaterial({
      color: new Color("#000000"),
      emissive: new Color(opts.color ?? "#ffd166"),
      emissiveIntensity: 1.4,
      roughness: 1,
    });
    const geometry = new ConeGeometry(0.4, 1, 8); // axis +Y; oriented to heading
    const inst = new InstancedMesh(geometry, material, n);
    inst.instanceMatrix.setUsage(DynamicDrawUsage);
    inst.frustumCulled = false;

    // Scratch objects reused each frame (no per-frame allocation).
    const sep = new Vector3();
    const ali = new Vector3();
    const coh = new Vector3();
    const acc = new Vector3();
    const d = new Vector3();
    const up = new Vector3(0, 1, 0);
    const quat = new Quaternion();
    const mat = new Matrix4();
    const scl = new Vector3();
    const heading = new Vector3();

    ctx.updaters.push((f) => {
      const dt = Math.min(f.dt, 0.05);
      const sw = Math.max(0, sepW.get(f));
      const aw = Math.max(0, aliW.get(f));
      const cw = Math.max(0, cohW.get(f));
      const sp = Math.max(0, speed.get(f));
      const s = Math.max(0.002, sizeS.get(f));

      for (let i = 0; i < n; i++) {
        sep.set(0, 0, 0);
        ali.set(0, 0, 0);
        coh.set(0, 0, 0);
        let neighbours = 0;
        for (let j = 0; j < n; j++) {
          if (j === i) continue;
          d.subVectors(pos[i]!, pos[j]!);
          const dist = d.length();
          if (dist > 0 && dist < RADIUS) {
            sep.addScaledVector(d, 1 / (dist * dist)); // push away, stronger when closer
            ali.add(vel[j]!);
            coh.add(pos[j]!);
            neighbours++;
          }
        }
        acc.set(0, 0, 0);
        if (neighbours > 0) {
          ali.multiplyScalar(1 / neighbours);
          coh.multiplyScalar(1 / neighbours).sub(pos[i]!);
          acc.addScaledVector(sep, sw).addScaledVector(ali, aw * 0.5).addScaledVector(coh, cw);
        }
        // Soft containment: steer back inside the cage.
        const r = pos[i]!.length();
        if (r > BOUND) acc.addScaledVector(pos[i]!, -((r - BOUND) * 2) / r);

        vel[i]!.addScaledVector(acc, dt);
        // Clamp speed to a sane band so the flock neither freezes nor explodes.
        const cur = vel[i]!.length();
        const lo = 0.2 * sp;
        const hi = 0.8 * sp;
        if (cur > 1e-4 && cur < lo) vel[i]!.multiplyScalar(lo / cur);
        else if (cur > hi) vel[i]!.multiplyScalar(hi / cur);

        pos[i]!.addScaledVector(vel[i]!, dt);

        heading.copy(vel[i]!);
        if (heading.lengthSq() < 1e-8) heading.set(0, 1, 0);
        heading.normalize();
        quat.setFromUnitVectors(up, heading);
        scl.set(s * 0.5, s, s * 0.5);
        mat.compose(pos[i]!, quat, scl);
        inst.setMatrixAt(i, mat);
      }
      inst.count = n;
      inst.instanceMatrix.needsUpdate = true;
    });

    return { object: inst };
  },
);
