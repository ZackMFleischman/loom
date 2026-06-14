import {
  BuildCtx,
  defineModule,
  texNode,
  type FrameCtx,
  type Pass,
  type SignalLike,
  type TexNode,
} from "@loom/runtime";
import { abs, atan, cos, float, length, mix, mod, sin, texture, uv, vec2, vec4 } from "three/tsl";
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

export interface KaleidoOpts {
  input: TexNode;
  /** Mirror-wedge count around the center (2 = one mirror, 6+ = classic mandala). */
  segments?: SignalLike;
  /** Pattern rotation in radians — feed an integrating signal for steady spin. */
  rotate?: SignalLike;
  /** Radial zoom into the source before folding (>1 magnifies the center). */
  zoom?: SignalLike;
  /** Blend with the unfolded input: 0 = bypass, 1 = full kaleidoscope. */
  amount?: SignalLike;
}

/**
 * Kaleidoscope: renders the input to a buffer, then re-samples it through a
 * mirrored polar fold — N wedges reflected around the center, rotatable and
 * zoomable. Stateful — owns one render target so it can warp arbitrary
 * upstream content (same shape as glitch).
 */
export const kaleido = defineModule(
  {
    name: "kaleido",
    kind: "effect",
    description: "Mirrored polar-fold kaleidoscope over any input, with rotation and zoom.",
    tags: ["kaleidoscope", "mirror", "symmetry", "stateful"],
    example: 'kaleido(ctx, { input: src, segments: 6, rotate: spinSig, amount: 0.9 })',
    chainParams: [
      { name: "segments", type: "int", default: 6, min: 2, max: 16, description: "mirror-wedge count" },
      { name: "rotate", default: 0, min: 0, max: 6.2832, step: 0.01, description: "pattern rotation (radians)" },
      { name: "zoom", default: 1, min: 0.5, max: 3, step: 0.01, description: "radial zoom into the source" },
      { name: "amount", default: 1, min: 0, max: 1, description: "fold blend (0 = bypass)" },
    ],
  },
  (ctx: BuildCtx, opts: KaleidoOpts): TexNode => {
    const rt = new RenderTarget(WIDTH, HEIGHT, { type: HalfFloatType });
    rt.texture.wrapS = MirroredRepeatWrapping;
    rt.texture.wrapT = MirroredRepeatWrapping;

    const segments = ctx.uniformOf(opts.segments ?? 6);
    const rotate = ctx.uniformOf(opts.rotate ?? 0);
    const zoom = ctx.uniformOf(opts.zoom ?? 1);
    const amount = ctx.uniformOf(opts.amount ?? 1);

    const srcMaterial = new MeshBasicNodeMaterial();
    srcMaterial.colorNode = opts.input.color;
    const srcQuad = new QuadMesh(srcMaterial);

    // Polar fold: angle mirrored into one wedge, radius zoomed.
    const p = uv().sub(0.5).mul(vec2(ASPECT, 1));
    const r = length(p).div(zoom.max(0.001));
    const segAngle = float(Math.PI * 2).div(segments.max(1));
    const a0 = atan(p.y, p.x).add(rotate);
    const a = abs(mod(a0, segAngle.mul(2)).sub(segAngle)); // mirrored into one wedge
    const suv = vec2(cos(a), sin(a)).mul(r).div(vec2(ASPECT, 1)).add(0.5);

    const folded = texture(rt.texture, suv);
    const straight = texture(rt.texture, uv());
    const col = mix(straight, folded, amount);

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
