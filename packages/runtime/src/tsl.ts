/**
 * TSL/WebGPU adapter seam (architecture refactor, Phase 6).
 *
 * The kernel renders through three's TSL node system on the WebGPU backend, and
 * `three` is pinned EXACT (a flagged upgrade risk — see CLAUDE.md). Every
 * kernel-side TSL primitive and WebGPU class is funneled through this one module
 * so the whole coupling surface to `three/tsl` + `three/webgpu` is visible — and
 * swappable — in a single file. A `three` major bump now lands here first
 * instead of being scattered across texnode/instance/buildctx/chain/layer/
 * palette/geo.
 *
 * This is NOT a full abstraction layer (that payoff only lands on an actual
 * upgrade, and over-abstracting risks more than it saves): the symbols are
 * re-exported verbatim — same names, same types — so the seam is zero-cost and
 * behaviour-identical. The value is the single chokepoint, not insulation.
 *
 * Scope is the kernel only. Content (`content/`) imports `three/tsl` directly by
 * design — `TexNode.color` is a TSL `vec4` node by contract — so scenes/modules
 * are not routed through here; the exact pin is what this seam protects in
 * `packages/`.
 */

// TSL node-builder primitives the kernel composes with.
export { abs, cos, float, mix, screenSize, sin, step, texture, uniform, uv, vec2, vec4 } from "three/tsl";

// WebGPU backend classes the kernel constructs directly (renderer, render
// targets, fullscreen-quad materials, palette ramp textures).
export {
  Color,
  DataTexture,
  HalfFloatType,
  LinearFilter,
  MeshBasicNodeMaterial,
  NoBlending,
  QuadMesh,
  RenderTarget,
  SRGBColorSpace,
  Vector2,
  WebGPURenderer,
} from "three/webgpu";

// Node-graph + scene-graph types the kernel references in signatures.
export type { Camera, Node, Object3D } from "three/webgpu";
