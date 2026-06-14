import { asSignal, BuildCtx, defineModule, type GeoNode, type SignalLike } from "@loom/runtime";
import { MeshSurfaceSampler } from "three/examples/jsm/math/MeshSurfaceSampler.js";
import {
  Color,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix3,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  OctahedronGeometry,
  Quaternion,
  Vector3,
} from "three/webgpu";

export interface ParticleEmitterOpts {
  /** The mesh whose SURFACE spawns particles (any GeoNode — primitives or loaded models). */
  surface: GeoNode;
  /** Particles spawned per second. */
  rate?: SignalLike;
  /** Particle lifetime in seconds. */
  lifetime?: SignalLike;
  /** Launch speed along the surface normal (world units/s). */
  speed?: SignalLike;
  /** Swirl-field strength — feed an input channel (hats!) for audio-driven chaos. */
  turbulence?: SignalLike;
  /** Particle size (world units, shrinks to 0 over the lifetime). */
  size?: SignalLike;
  /** Downward pull (negative lifts). */
  gravity?: SignalLike;
  /** Particle color "#rrggbb" (emissive — particles read without lights). */
  color?: string;
  /** Pool ceiling baked at build time (rebuild to change). */
  maxParticles?: number;
  /** Sim seed — deterministic by default so fixture replays are byte-identical. */
  seed?: number;
}

/** Deterministic PRNG (mulberry32): the sim must replay identically under fixtures. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Cheap divergence-free-ish swirl field (sin/cos lattice — no noise tables). */
function swirl(out: Vector3, p: Vector3, t: number): Vector3 {
  const x = p.x * 2.1 + t * 0.7;
  const y = p.y * 2.3 - t * 0.55;
  const z = p.z * 1.9 + t * 0.62;
  return out.set(
    Math.sin(y) * Math.cos(z),
    Math.sin(z) * Math.cos(x),
    Math.sin(x) * Math.cos(y),
  );
}

/**
 * The M8 flagship: particles boil off the SURFACE of any mesh. CPU sim over a
 * GPU-instanced pool — runs (and validates) on the WebGL2 fallback everywhere;
 * a TSL-compute pool is the WebGPU upgrade path. Sampling waits for async
 * models: the sampler builds the moment the surface has geometry. Driven by
 * the frame clock with a seeded PRNG, so fixture replays are deterministic.
 */
export const particleEmitter = defineModule(
  {
    name: "particleEmitter",
    kind: "geo",
    description: "Particles emitted from a mesh's surface (rate/lifetime/speed/turbulence live).",
    tags: ["3d", "particles", "emitter", "surface", "audio-reactive", "geo"],
    example: 'particleEmitter(ctx, { surface: hippo, rate: 400, turbulence: ctx.input("hats") })',
  },
  (ctx: BuildCtx, opts: ParticleEmitterOpts): GeoNode => {
    const max = Math.max(16, Math.min(20_000, Math.round(opts.maxParticles ?? 2000)));
    const rate = asSignal(opts.rate ?? 200);
    const lifetime = asSignal(opts.lifetime ?? 1.6);
    const speed = asSignal(opts.speed ?? 0.45);
    const turbulence = asSignal(opts.turbulence ?? 0);
    const size = asSignal(opts.size ?? 0.035);
    const gravity = asSignal(opts.gravity ?? -0.15);
    const rand = mulberry32(opts.seed ?? 1337);

    const material = new MeshStandardMaterial({
      color: new Color("#000000"),
      emissive: new Color(opts.color ?? "#9ae6ff"),
      emissiveIntensity: 1.6,
      roughness: 1,
    });
    const mesh = new InstancedMesh(new OctahedronGeometry(1, 0), material, max);
    mesh.frustumCulled = false; // positions live on the CPU; the bbox never updates
    mesh.instanceMatrix.setUsage(DynamicDrawUsage); // re-uploaded every frame
    mesh.count = 0;

    // Pool state (struct-of-arrays keeps the per-frame loop allocation-free).
    const px = new Float32Array(max), py = new Float32Array(max), pz = new Float32Array(max);
    const vx = new Float32Array(max), vy = new Float32Array(max), vz = new Float32Array(max);
    const age = new Float32Array(max), life = new Float32Array(max);
    let alive = 0;
    let spawnDebt = 0;

    // Surface sampling — lazy: loaded models attach their meshes async.
    let sampler: MeshSurfaceSampler | null = null;
    let sampledMesh: Mesh | null = null;
    const findMesh = (): Mesh | null => {
      let found: Mesh | null = null;
      opts.surface.object.traverse((o) => {
        const m = o as Mesh;
        if (found == null && m.isMesh && m.geometry?.attributes?.position != null) found = m;
      });
      return found;
    };

    const point = new Vector3();
    const normal = new Vector3();
    const normalMat = new Matrix3();
    const tmp = new Vector3();
    const mat = new Matrix4();
    const quat = new Quaternion();
    const one = new Vector3();

    ctx.updaters.push((f) => {
      // 1. Acquire (or refresh) the sampler once geometry exists.
      if (sampler == null) {
        const m = findMesh();
        if (m != null) {
          // The sampler's default randomness is Math.random — swap in the
          // seeded PRNG or fixture replays stop being byte-identical.
          // (setRandomGenerator exists at runtime; @types/three omits it.)
          const s = new MeshSurfaceSampler(m);
          (s as unknown as { setRandomGenerator(fn: () => number): void }).setRandomGenerator(rand);
          sampler = s.build();
          sampledMesh = m;
        }
      }

      const dt = Math.min(0.1, f.dt); // a hitch must not dump the whole pool at once
      const lifeNow = Math.max(0.05, lifetime.get(f));
      const speedNow = speed.get(f);
      const turb = turbulence.get(f);
      const grav = gravity.get(f);
      const sizeNow = Math.max(0.001, size.get(f));

      // 2. Spawn from the surface (world space — the surface may spin/scale live).
      if (sampler != null && sampledMesh != null) {
        spawnDebt += Math.max(0, rate.get(f)) * dt;
        if (spawnDebt >= 1) sampledMesh.updateWorldMatrix(true, false);
        normalMat.getNormalMatrix(sampledMesh.matrixWorld);
        while (spawnDebt >= 1 && alive < max) {
          spawnDebt -= 1;
          sampler.sample(point, normal);
          point.applyMatrix4(sampledMesh.matrixWorld);
          normal.applyMatrix3(normalMat).normalize();
          const i = alive++;
          px[i] = point.x; py[i] = point.y; pz[i] = point.z;
          const v = speedNow * (0.6 + rand() * 0.8);
          vx[i] = normal.x * v; vy[i] = normal.y * v; vz[i] = normal.z * v;
          age[i] = 0;
          life[i] = lifeNow * (0.7 + rand() * 0.6);
        }
        if (spawnDebt >= 1) spawnDebt = 0; // pool full — drop the surplus
      }

      // 3. Integrate + cull (swap-with-last keeps the pool dense).
      for (let i = 0; i < alive; i++) {
        age[i]! += dt;
        if (age[i]! >= life[i]!) {
          const l = --alive;
          px[i] = px[l]!; py[i] = py[l]!; pz[i] = pz[l]!;
          vx[i] = vx[l]!; vy[i] = vy[l]!; vz[i] = vz[l]!;
          age[i] = age[l]!; life[i] = life[l]!;
          i--;
          continue;
        }
        swirl(tmp, point.set(px[i]!, py[i]!, pz[i]!), f.now);
        vx[i]! += (tmp.x * turb + 0) * dt;
        vy[i]! += (tmp.y * turb + grav) * dt;
        vz[i]! += tmp.z * turb * dt;
        px[i]! += vx[i]! * dt;
        py[i]! += vy[i]! * dt;
        pz[i]! += vz[i]! * dt;
      }

      // 4. Write the instance buffer: position + age-shrunk scale.
      for (let i = 0; i < alive; i++) {
        const s = sizeNow * (1 - age[i]! / life[i]!);
        mat.compose(point.set(px[i]!, py[i]!, pz[i]!), quat, one.set(s, s, s));
        mesh.setMatrixAt(i, mat);
      }
      mesh.count = alive;
      mesh.instanceMatrix.needsUpdate = true;
    });

    return { object: mesh };
  },
);
