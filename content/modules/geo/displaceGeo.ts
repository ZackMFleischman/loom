import { asSignal, BuildCtx, defineModule, type GeoNode, type SignalLike } from "@loom/runtime";
import { DynamicDrawUsage, Mesh, type BufferAttribute } from "three/webgpu";

export interface DisplaceGeoOpts {
  /** The GeoNode whose vertices get displaced (give it segments — see plane). */
  input: GeoNode;
  /** Displacement amplitude along the vertex normal (world units). */
  amount?: SignalLike;
  /** Spatial scale of the displacement field. */
  scale?: SignalLike;
  /** Field evolution speed. */
  speed?: SignalLike;
}

/** Smooth deterministic 3D field (sin/cos lattice — no tables, no Math.random). */
function field(x: number, y: number, z: number, t: number): number {
  return (
    Math.sin(x * 1.7 + t) * Math.cos(z * 1.3 - t * 0.7) * 0.6 +
    Math.sin(x * 3.1 - t * 0.5 + y * 2.2) * 0.25 +
    Math.cos(z * 4.3 + t * 1.1) * 0.15
  );
}

/**
 * Vertex displacement (the Noise SOP / Rutt-Etra idiom): pushes the input's
 * vertices along their normals through an animated field — feed a subdivided
 * `plane` for terrain, anything else for a breathing mesh. CPU-side on the
 * frame clock (fixture-deterministic); normals recompute per frame.
 */
export const displaceGeo = defineModule(
  {
    name: "displaceGeo",
    kind: "geo",
    description: "Displaces a mesh's vertices through an animated field (terrain, breathing meshes).",
    tags: ["3d", "displace", "terrain", "noise", "geo"],
    example: 'displaceGeo(ctx, { input: plane(ctx, { segments: 48 }), amount: ctx.input("bass") })',
  },
  (ctx: BuildCtx, opts: DisplaceGeoOpts): GeoNode => {
    const amount = asSignal(opts.amount ?? 0.35);
    const scale = asSignal(opts.scale ?? 1.6);
    const speed = asSignal(opts.speed ?? 0.5);

    // Lazily capture the rest pose (loaded models attach meshes async).
    let mesh: Mesh | null = null;
    let rest: Float32Array | null = null;
    let restNormals: Float32Array | null = null;
    let t = 0;

    ctx.updaters.push((f) => {
      if (mesh == null) {
        opts.input.object.traverse((o) => {
          const m = o as Mesh;
          if (mesh == null && m.isMesh && m.geometry?.attributes?.position != null) mesh = m;
        });
        // (cast: TS can't see the traverse-callback assignment above)
        const found = mesh as Mesh | null;
        if (found == null) return;
        const pos = found.geometry.attributes.position as BufferAttribute;
        if (pos.count > 40_000) {
          console.warn("[loom] displaceGeo: mesh too dense (>40k verts) — skipping displacement");
          rest = null;
          return;
        }
        pos.setUsage(DynamicDrawUsage); // re-uploaded every frame (M8 lesson)
        rest = new Float32Array(pos.array as Float32Array);
        const nor = found.geometry.attributes.normal as BufferAttribute | undefined;
        restNormals = nor ? new Float32Array(nor.array as Float32Array) : null;
      }
      const m = mesh as Mesh | null;
      if (m == null || rest == null) return;

      t += speed.get(f) * f.dt;
      const amp = amount.get(f);
      const s = Math.max(0.01, scale.get(f));
      const pos = m.geometry.attributes.position as BufferAttribute;
      const arr = pos.array as Float32Array;
      for (let i = 0; i < arr.length; i += 3) {
        const x = rest[i]!;
        const y = rest[i + 1]!;
        const z = rest[i + 2]!;
        const d = field(x * s, y * s, z * s, t) * amp;
        const nx = restNormals ? restNormals[i]! : 0;
        const ny = restNormals ? restNormals[i + 1]! : 1;
        const nz = restNormals ? restNormals[i + 2]! : 0;
        arr[i] = x + nx * d;
        arr[i + 1] = y + ny * d;
        arr[i + 2] = z + nz * d;
      }
      pos.needsUpdate = true;
      m.geometry.computeVertexNormals(); // relight the displaced surface
      m.geometry.attributes.normal!.needsUpdate = true;
    });

    return { object: opts.input.object };
  },
);
