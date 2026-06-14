import {
  abs,
  cos,
  HalfFloatType,
  MeshBasicNodeMaterial,
  NoBlending,
  QuadMesh,
  RenderTarget,
  screenSize,
  sin,
  step,
  texture,
  uv,
  vec2,
  vec4,
  Vector2,
  type WebGPURenderer,
} from "./tsl";
import type { BuildCtx } from "./buildctx";
import type { FrameCtx } from "./frame";
import { layerRigPath } from "./paths";
import { texNode, type Pass, type TexNode } from "./texnode";

/**
 * A named node registered by `ctx.layer(name, tex)` (Layers milestone): grab
 * anything inside a scene — transform it, fade it, chain FX onto it — without
 * the scene author having pre-surfaced params for it. `parent` is the closest
 * enclosing layer (null = feeds the root output directly).
 */
export interface LayerNodeInfo {
  id: string;
  parent: string | null;
}

/** Hooks injected by the session so per-node runtime data folds into the build. */
export interface LayerHooks {
  /** Fold the named node's FX chain over its rigged output (chains are session data). */
  foldNode?: (ctx: BuildCtx, node: string, tex: TexNode) => TexNode;
}

// Node ids that would collide with a manifest namespace or instance alias —
// defined with the namespace constants in ./paths, re-exported here for callers.
export { RESERVED_NODE_NAMES } from "./paths";

export const NODE_NAME_RE = /^[a-z][a-z0-9_-]*$/i;

// The aspect of whatever surface is being rendered, resolved per draw on the GPU.
const surfaceAspect = () => screenSize.x.div(screenSize.y);

/**
 * The uniform-driven layer rig: every wrapped node gets `<name>.layer.x/y/
 * scale/rotate/opacity` params (identity by default), applied by re-sampling
 * the node through a buffer — `set_param` on any of them never rebuilds.
 * Mirrors the `transform` effect's pass mechanics (2D affine + opacity; the
 * full 3D tilt stays in the chainable `transform` effect).
 */
export function layerRig(ctx: BuildCtx, name: string, input: TexNode): TexNode {
  const x = ctx.float(layerRigPath(name, "x"), { default: 0.5, min: 0, max: 1, step: 0.01, description: "center x (uv)" });
  const y = ctx.float(layerRigPath(name, "y"), { default: 0.5, min: 0, max: 1, step: 0.01, description: "center y (uv)" });
  const scale = ctx.float(layerRigPath(name, "scale"), { default: 1, min: 0.05, max: 4, step: 0.01, description: "uniform scale" });
  const rotate = ctx.float(layerRigPath(name, "rotate"), { default: 0, min: -3.1416, max: 3.1416, step: 0.01, description: "spin (radians)" });
  const opacity = ctx.float(layerRigPath(name, "opacity"), { default: 1, min: 0, max: 1, step: 0.01, description: "layer fade" });

  const ux = ctx.uniformOf(x.signal());
  const uy = ctx.uniformOf(y.signal());
  const us = ctx.uniformOf(scale.signal());
  const ur = ctx.uniformOf(rotate.signal());
  const uo = ctx.uniformOf(opacity.signal());

  // Sized to match the live destination on first render — no assumed resolution.
  const rt = new RenderTarget(1, 1, { type: HalfFloatType });
  const destSize = new Vector2();

  const srcMaterial = new MeshBasicNodeMaterial();
  srcMaterial.colorNode = input.color;
  // Raw RGBA write: transparent layers must keep their alpha in the buffer.
  srcMaterial.transparent = true;
  srcMaterial.blending = NoBlending;
  const srcQuad = new QuadMesh(srcMaterial);

  // Inverse affine map: screen-uv → the layer's local frame (identity at defaults).
  const q = uv().sub(vec2(ux, uy)).mul(vec2(surfaceAspect(), 1));
  const c = cos(ur);
  const s = sin(ur);
  const l = vec2(c.mul(q.x).add(s.mul(q.y)), s.negate().mul(q.x).add(c.mul(q.y))).div(us.max(0.001));
  const suv = l.div(vec2(surfaceAspect(), 1)).add(0.5);
  const d = abs(suv.sub(0.5));
  const inside = step(d.x, 0.5).mul(step(d.y, 0.5));
  const samp = texture(rt.texture, suv);

  const pass: Pass = {
    render(renderer: WebGPURenderer, _f: FrameCtx) {
      const prev = renderer.getRenderTarget();
      // Track the destination's actual resolution so the buffer is 1:1.
      if (prev) destSize.set(prev.width, prev.height);
      else renderer.getDrawingBufferSize(destSize);
      if (rt.width !== destSize.x || rt.height !== destSize.y) rt.setSize(destSize.x, destSize.y);
      renderer.setRenderTarget(rt);
      srcQuad.render(renderer);
      renderer.setRenderTarget(prev);
    },
    dispose() {
      rt.dispose();
      srcMaterial.dispose();
    },
  };

  const fade = inside.mul(uo);
  return texNode(vec4(samp.rgb.mul(fade), samp.a.mul(fade)), [...input.passes, pass]);
}
