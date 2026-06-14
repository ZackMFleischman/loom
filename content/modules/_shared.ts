import type { ColorNode, FrameCtx, Pass, TexNode } from "@loom/runtime";
import { screenSize } from "three/tsl";
import {
  HalfFloatType,
  MeshBasicNodeMaterial,
  NoBlending,
  QuadMesh,
  RenderTarget,
  Vector2,
  type WebGPURenderer,
} from "three/webgpu";

/**
 * Shared module plumbing. Not a module file itself (lives outside the
 * {control,sources,effects,geo} folders, so discovery never sweeps it).
 */

/**
 * The aspect of whatever surface is being rendered — canvas, preview target,
 * or an upstream effect's buffer — resolved on the GPU per draw. Use this
 * instead of hardcoding 16/9 in TSL math: modules then track the destination
 * (1920×1080 output, 640×360 previews, anything later) automatically.
 * CPU-side layout math can't use it (it's a shader node) — those modules take
 * an explicit `aspect` opt instead.
 */
export const surfaceAspect = () => screenSize.x.div(screenSize.y);

/** Parse "#rrggbb" (or "#rgb"-less strict 6-digit) to 0..1 rgb floats. */
export function parseHex(c: string, fallback = 0xffffff): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
  const n = m ? parseInt(m[1]!, 16) : fallback;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export interface BufferPassOpts {
  /** What gets written into the buffer (default: the input's color). */
  colorNode?: ColorNode;
  /** Return true to skip the buffer render entirely this frame (idle gates). */
  skip?: (f: FrameCtx) => boolean;
  /** Keep sibling render targets sized with the buffer (multi-pass effects). */
  onResize?: (w: number, h: number) => void;
  /** Extra GPU work after the buffer render, same frame (e.g. a blur H pass). */
  afterRender?: (renderer: WebGPURenderer, f: FrameCtx) => void;
  /** Extra cleanup alongside the buffer's own. */
  onDispose?: () => void;
}

/**
 * THE warping-effect skeleton: render the input TexNode into an owned
 * HalfFloat RenderTarget sized to the live destination, so the effect can
 * re-sample it at transformed UVs (`texture(rt.texture, warpedUv)`). An
 * input's color is a node graph, not a function of uv — this buffer is the
 * only honest way to move arbitrary upstream content. Raw RGBA write
 * (transparent + NoBlending) so layered content keeps its alpha.
 */
export function bufferPass(input: TexNode, opts: BufferPassOpts = {}): { rt: RenderTarget; pass: Pass } {
  const rt = new RenderTarget(1, 1, { type: HalfFloatType });
  const destSize = new Vector2();

  const srcMaterial = new MeshBasicNodeMaterial();
  srcMaterial.colorNode = opts.colorNode ?? input.color;
  srcMaterial.transparent = true;
  srcMaterial.blending = NoBlending;
  const srcQuad = new QuadMesh(srcMaterial);

  const pass: Pass = {
    render(renderer: WebGPURenderer, f: FrameCtx) {
      if (opts.skip?.(f)) return;
      const prev = renderer.getRenderTarget();
      // Track the destination's actual resolution so the buffer is 1:1.
      if (prev) destSize.set(prev.width, prev.height);
      else renderer.getDrawingBufferSize(destSize);
      if (rt.width !== destSize.x || rt.height !== destSize.y) {
        rt.setSize(destSize.x, destSize.y);
        opts.onResize?.(destSize.x, destSize.y);
      }
      renderer.setRenderTarget(rt);
      srcQuad.render(renderer);
      renderer.setRenderTarget(prev);
      opts.afterRender?.(renderer, f);
    },
    dispose() {
      rt.dispose();
      srcMaterial.dispose();
      opts.onDispose?.();
    },
  };

  return { rt, pass };
}
