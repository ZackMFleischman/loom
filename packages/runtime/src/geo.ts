import type { Camera, Object3D } from "./tsl";

/**
 * The 3D path (M7). Geo modules return scene-graph fragments instead of
 * TexNodes; the `render3d` bridge module renders a set of them through a
 * camera into a render target and re-enters the TexNode world — so meshes
 * compose with every 2D effect, chain and layer exactly like any source.
 */

/** A scene-graph fragment: one Object3D subtree (mesh, group, loaded model). */
export interface GeoNode {
  readonly object: Object3D;
}

/** A camera rig (e.g. orbitCam) — animated via BuildCtx updaters. */
export interface CamNode {
  readonly camera: Camera;
}

export function isGeoNode(v: unknown): v is GeoNode {
  return v != null && typeof v === "object" && (v as { object?: { isObject3D?: boolean } }).object?.isObject3D === true;
}

export function isCamNode(v: unknown): v is CamNode {
  return v != null && typeof v === "object" && (v as { camera?: { isCamera?: boolean } }).camera?.isCamera === true;
}
