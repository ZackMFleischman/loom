import { asSignal, BuildCtx, defineModule, texNode, type CamNode, type GeoNode, type Pass, type SignalLike, type TexNode } from "@loom/runtime";
import { texture, uv, vec4 } from "three/tsl";
import {
  Color,
  DirectionalLight,
  HalfFloatType,
  HemisphereLight,
  PerspectiveCamera,
  RenderTarget,
  Scene,
  Vector2,
  type WebGPURenderer,
} from "three/webgpu";

export interface Render3dOpts {
  /** The scene-graph fragments to render (geo modules' outputs). */
  world: GeoNode | GeoNode[];
  /** Camera rig (orbitCam); omitted = a static front camera. */
  cam?: CamNode;
  /** Hemisphere fill intensity (Signal-able). */
  ambient?: SignalLike;
  /** Directional key-light intensity (Signal-able). */
  key?: SignalLike;
  /** Background "#rrggbb"; omitted = transparent (composites over anything). */
  background?: string;
}

/**
 * The 3D→2D bridge (M7): renders GeoNodes through a camera into an owned
 * render target and returns a TexNode — meshes then flow through every 2D
 * effect, FX chain and layer like any other source. Owns the scene + default
 * lights; transparent outside the geometry unless a background is set.
 */
export const render3d = defineModule(
  {
    name: "render3d",
    kind: "source",
    description: "Renders GeoNodes (meshes/models) through a camera into the TexNode chain.",
    tags: ["3d", "bridge", "render", "scene", "stateful"],
    example: 'render3d(ctx, { world: [torus(ctx, { spin: 0.6 })], cam: orbitCam(ctx, {}) })',
  },
  (ctx: BuildCtx, opts: Render3dOpts): TexNode => {
    const scene = new Scene();
    if (opts.background != null) scene.background = new Color(opts.background);
    const hemi = new HemisphereLight(0xffffff, 0x202028, 0.6);
    const keyLight = new DirectionalLight(0xffffff, 1.4);
    keyLight.position.set(3, 5, 2);
    scene.add(hemi, keyLight);
    const nodes = Array.isArray(opts.world) ? opts.world : [opts.world];
    for (const n of nodes) scene.add(n.object);

    const fallbackCam = new PerspectiveCamera(50, 16 / 9, 0.05, 100);
    fallbackCam.position.set(0, 0.7, 2.6);
    fallbackCam.lookAt(0, 0, 0);
    const camera = opts.cam?.camera ?? fallbackCam;

    const ambient = asSignal(opts.ambient ?? 0.6);
    const key = asSignal(opts.key ?? 1.4);

    // Sized to the destination on first render (like transform). No MSAA: the
    // WebGL backend's multisample resolve proved unreliable outside the rAF
    // loop (frozen pixels in fixture offline passes) — the full-res live
    // render keeps edges acceptable without it.
    const rt = new RenderTarget(1, 1, { type: HalfFloatType });
    const destSize = new Vector2();
    const clearColor = new Color();

    const pass: Pass = {
      render(renderer: WebGPURenderer, f) {
        hemi.intensity = Math.max(0, ambient.get(f));
        keyLight.intensity = Math.max(0, key.get(f));
        const prev = renderer.getRenderTarget();
        if (prev) destSize.set(prev.width, prev.height);
        else renderer.getDrawingBufferSize(destSize);
        if (rt.width !== destSize.x || rt.height !== destSize.y) {
          rt.setSize(destSize.x, destSize.y);
          if (camera instanceof PerspectiveCamera) {
            camera.aspect = destSize.x / Math.max(1, destSize.y);
            camera.updateProjectionMatrix();
          }
        }
        // Transparent clear so the bridge composites over anything (M7).
        // (getClearColor wants three's internal Color4, not exported from
        // three/webgpu — a Color target works at runtime; alpha read separately.)
        renderer.getClearColor(clearColor as never);
        const prevAlpha = renderer.getClearAlpha();
        renderer.setClearColor(0x000000, opts.background != null ? 1 : 0);
        renderer.setRenderTarget(rt);
        renderer.render(scene, camera);
        renderer.setRenderTarget(prev);
        renderer.setClearColor(clearColor, prevAlpha);
      },
      dispose() {
        rt.dispose();
      },
    };

    const s = texture(rt.texture, uv());
    return texNode(vec4(s.rgb, s.a), [pass]);
  },
);
