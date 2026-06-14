import { asSignal, BuildCtx, defineModule, type CamNode, type SignalLike } from "@loom/runtime";
import { PerspectiveCamera, Vector3 } from "three/webgpu";

export interface OrbitCamOpts {
  /** Orbit radius from the target. */
  radius?: SignalLike;
  /** Camera height above the target. */
  height?: SignalLike;
  /** Orbit speed in rad/s (integrated — speed changes never jump the angle). */
  speed?: SignalLike;
  /** Vertical field of view in degrees. */
  fov?: number;
  /** Point the camera looks at. */
  target?: [number, number, number];
  /** Start angle in radians. */
  phase?: number;
}

/**
 * An orbiting perspective camera as a CamNode — the standard rig for
 * render3d. Driven by the frame clock through a registered updater, so it
 * pauses with PANIC and replays deterministically under a fixture.
 */
export const orbitCam = defineModule(
  {
    name: "orbitCam",
    kind: "geo",
    description: "An orbiting perspective camera (CamNode) for render3d — radius/height/speed live.",
    tags: ["3d", "camera", "orbit", "geo"],
    example: 'render3d(ctx, { world: torus(ctx, {}), cam: orbitCam(ctx, { radius: 2.5, speed: 0.4 }) })',
  },
  (ctx: BuildCtx, opts: OrbitCamOpts = {}): CamNode => {
    const camera = new PerspectiveCamera(opts.fov ?? 50, 16 / 9, 0.05, 100);
    const target = new Vector3(...(opts.target ?? [0, 0, 0]));
    const radius = asSignal(opts.radius ?? 2.5);
    const height = asSignal(opts.height ?? 0.8);
    const speed = asSignal(opts.speed ?? 0.4);
    let angle = opts.phase ?? 0;
    ctx.updaters.push((f) => {
      angle += speed.get(f) * f.dt;
      const r = Math.max(0.1, radius.get(f));
      camera.position.set(Math.sin(angle) * r, height.get(f), Math.cos(angle) * r);
      camera.lookAt(target);
    });
    return { camera };
  },
);
