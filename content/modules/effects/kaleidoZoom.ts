import {
  BuildCtx,
  defineModule,
  texNode,
  type FrameCtx,
  type Pass,
  type SignalLike,
  type TexNode,
} from "@loom/runtime";
import {
  abs,
  atan,
  cos,
  exp2,
  float,
  fract,
  length,
  mix,
  mod,
  sin,
  texture,
  uv,
  vec2,
  vec4,
} from "three/tsl";
import {
  HalfFloatType,
  MeshBasicNodeMaterial,
  MirroredRepeatWrapping,
  QuadMesh,
  RenderTarget,
  type WebGPURenderer,
} from "three/webgpu";

const WIDTH = 1280;
const HEIGHT = 720;
const ASPECT = WIDTH / HEIGHT;
const TAU = Math.PI * 2;

export interface KaleidoZoomOpts {
  input: TexNode;
  /**
   * Zoom depth in octaves — feed an ever-growing signal (integrate a rate)
   * and the dive never ends: each +1 doubles in, wrapping seamlessly.
   */
  zoom?: SignalLike;
  /** Mirror-wedge count of the kaleido fold (the fold is what sells infinity). */
  segments?: SignalLike;
  /** Spiral rotation in radians per octave of zoom (0 = straight dive). */
  twist?: SignalLike;
}

/**
 * Infinite kaleidoscopic zoom: the input renders to a buffer, output coords
 * are kaleido-folded, then two copies of the source — one octave apart in
 * scale — are sampled and crossfaded by the fractional zoom phase. As the
 * zoom signal grows the deep layer continuously hands off to the wide one,
 * so the dive loops forever like a fractal. Stateful — owns one render target.
 */
export const kaleidoZoom = defineModule(
  {
    name: "kaleidoZoom",
    kind: "effect",
    description: "Endless fractal-style dive into any input through a mirrored kaleido fold.",
    tags: ["kaleidoscope", "zoom", "infinite", "fractal", "stateful"],
    example: 'kaleidoZoom(ctx, { input: src, zoom: depthSig, segments: 6, twist: 0.5 })',
    chainParams: [
      { name: "zoom", default: 0, min: 0, max: 8, step: 0.01, description: "dive depth in octaves (ride it)" },
      { name: "segments", type: "int", default: 6, min: 2, max: 16, description: "mirror-wedge count" },
      { name: "twist", default: 0.5, min: -3, max: 3, step: 0.01, description: "spiral per octave (radians)" },
    ],
  },
  (ctx: BuildCtx, opts: KaleidoZoomOpts): TexNode => {
    const rt = new RenderTarget(WIDTH, HEIGHT, { type: HalfFloatType });
    rt.texture.wrapS = MirroredRepeatWrapping;
    rt.texture.wrapT = MirroredRepeatWrapping;

    const zoom = ctx.uniformOf(opts.zoom ?? 0);
    const segments = ctx.uniformOf(opts.segments ?? 6);
    const twist = ctx.uniformOf(opts.twist ?? 0.5);

    const srcMaterial = new MeshBasicNodeMaterial();
    srcMaterial.colorNode = opts.input.color;
    const srcQuad = new QuadMesh(srcMaterial);

    // Fold output coords into one mirrored wedge, then spiral with depth.
    const p = uv().sub(0.5).mul(vec2(ASPECT, 1));
    const segAngle = float(TAU).div(segments.max(1));
    const a = abs(mod(atan(p.y, p.x), segAngle.mul(2)).sub(segAngle));
    const ang = a.add(zoom.mul(twist));
    const q = vec2(cos(ang), sin(ang)).mul(length(p));

    // Two nested octave layers, one always handing off to the other.
    const f = fract(zoom);
    const near = q.mul(exp2(f.negate())).div(vec2(ASPECT, 1)).add(0.5);
    const wide = q.mul(exp2(float(1).sub(f))).div(vec2(ASPECT, 1)).add(0.5);
    const col = mix(texture(rt.texture, near), texture(rt.texture, wide), f.smoothstep(0, 1));

    const pass: Pass = {
      render(renderer: WebGPURenderer, _f: FrameCtx) {
        const prev = renderer.getRenderTarget();
        renderer.setRenderTarget(rt);
        srcQuad.render(renderer);
        renderer.setRenderTarget(prev);
      },
      dispose() {
        rt.dispose();
        srcMaterial.dispose();
      },
    };

    return texNode(vec4(col.rgb, 1), [...opts.input.passes, pass]);
  },
);
