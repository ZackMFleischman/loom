import { asSignal, BuildCtx, type GeoNode, type SignalLike } from "@loom/runtime";
import { Color, DoubleSide, Mesh, MeshStandardMaterial, type BufferGeometry } from "three/webgpu";

/** Shared looks/motion options for the geo primitives (box/sphere/torus). */
export interface PrimitiveOpts {
  /** Base color "#rrggbb". */
  color?: string;
  /** 0 = matte dielectric, 1 = mirror metal. */
  metalness?: number;
  /** Microsurface roughness 0..1. */
  roughness?: number;
  /** Emissive intensity 0..~2 — makes the mesh glow without lights (Signal-able). */
  glow?: SignalLike;
  /** Spin speed around Y in rad/s (integrated — speed changes never jump). */
  spin?: SignalLike;
  /** Tumble speed around X in rad/s. */
  tumble?: SignalLike;
  /** Static placement. */
  position?: [number, number, number];
  /** Uniform scale multiplier (Signal-able — feed a kick for size punches). */
  scale?: SignalLike;
}

/**
 * Wrap a BufferGeometry as a GeoNode with a standard material and integrated
 * spin/tumble plus live glow/scale updaters (CPU-side, ticked per frame like
 * every registered updater — deterministic under a fixture clock).
 */
export function primitive(ctx: BuildCtx, geometry: BufferGeometry, opts: PrimitiveOpts = {}): GeoNode {
  const material = new MeshStandardMaterial({
    color: new Color(opts.color ?? "#cccccc"),
    metalness: opts.metalness ?? 0.1,
    roughness: opts.roughness ?? 0.55,
    side: DoubleSide, // planes/ribbons must read from both sides
  });
  const mesh = new Mesh(geometry, material);
  if (opts.position) mesh.position.set(...opts.position);

  const spin = asSignal(opts.spin ?? 0);
  const tumble = asSignal(opts.tumble ?? 0);
  const glow = asSignal(opts.glow ?? 0);
  const scale = asSignal(opts.scale ?? 1);
  ctx.updaters.push((f) => {
    mesh.rotation.y += spin.get(f) * f.dt;
    mesh.rotation.x += tumble.get(f) * f.dt;
    mesh.scale.setScalar(Math.max(0.001, scale.get(f)));
    material.emissive.copy(material.color).multiplyScalar(Math.max(0, glow.get(f)));
  });

  return { object: mesh };
}
