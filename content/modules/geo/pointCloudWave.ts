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

export interface PointCloudWaveOpts {
  source: GeoNode;
  size?: SignalLike;
  color?: string;
  maxPoints?: number;
  follow?: boolean;
  /** Radial wave displacement amplitude in world units. */
  waveAmplitude?: SignalLike;
  /** Wave propagation speed — wave-fronts per second. */
  waveSpeed?: SignalLike;
  /** Wave frequency — cycles per world unit (higher = tighter rings). */
  waveFreq?: SignalLike;
}

/**
 * Like pointCloud but each point is radially displaced by a propagating
 * spherical wave: amplitude * sin(2π*(r*freq − time*speed)). Ripples emanate
 * outward from the attractor's centre, making the filamentary structure
 * breathe and pulse without rebuilding.
 */
export const pointCloudWave = defineModule(
  {
    name: "pointCloudWave",
    kind: "geo",
    description:
      "pointCloud with a live radial wave — spherical ripples push each point outward by a sinusoidal displacement; ride waveAmplitude/Speed/Freq live.",
    tags: ["3d", "points", "wave", "pulse", "audio-reactive", "geo"],
    example:
      'pointCloudWave(ctx, { source: strangeAttractor(ctx, {}), waveAmplitude: 0.15, waveSpeed: 1, waveFreq: 3 })',
  },
  (ctx: BuildCtx, opts: PointCloudWaveOpts): GeoNode => {
    const max = Math.max(64, Math.min(20_000, Math.round(opts.maxPoints ?? 6000)));
    const size = asSignal(opts.size ?? 0.012);
    const follow = opts.follow ?? true;
    const waveAmplitude = asSignal(opts.waveAmplitude ?? 0.1);
    const waveSpeed = asSignal(opts.waveSpeed ?? 1.0);
    const waveFreq = asSignal(opts.waveFreq ?? 2.5);

    const material = new MeshStandardMaterial({
      color: new Color("#000000"),
      emissive: new Color(opts.color ?? "#9ae6ff"),
      emissiveIntensity: 1.5,
      roughness: 1,
    });
    const inst = new InstancedMesh(new OctahedronGeometry(1, 0), material, max);
    inst.instanceMatrix.setUsage(DynamicDrawUsage);
    inst.frustumCulled = false;
    inst.count = 0;

    let srcMesh: Mesh | null = null;
    let stride = 1;
    let placed = false;
    let waveTime = 0;
    const mat = new Matrix4();
    const quat = new Quaternion();
    const p = new Vector3();
    const dir = new Vector3();
    const one = new Vector3();

    ctx.updaters.push((f) => {
      waveTime += Math.min(f.dt, 0.05);

      if (srcMesh == null) {
        opts.source.object.traverse((o) => {
          const m = o as Mesh;
          if (srcMesh == null && m.isMesh && m.geometry?.attributes?.position != null) srcMesh = m;
        });
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
      const amp = waveAmplitude.get(f);
      const spd = waveSpeed.get(f);
      const freq = waveFreq.get(f);
      const TWO_PI = 2 * Math.PI;
      one.set(s, s, s);

      let n = 0;
      for (let i = 0; i < pos.count && n < max; i += stride) {
        p.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);

        // Spherical ripple: displacement travels radially outward from origin.
        const r = p.length();
        if (r > 1e-6) {
          const wave = amp * Math.sin(TWO_PI * (r * freq - waveTime * spd));
          dir.copy(p).divideScalar(r).multiplyScalar(wave);
          p.add(dir);
        }

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
