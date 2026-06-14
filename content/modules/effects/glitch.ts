import {
  BuildCtx,
  defineModule,
  texNode,
  type FrameCtx,
  type Pass,
  type SignalLike,
  type TexNode,
} from "@loom/runtime";
import { floor, hash, sin, step, texture, uv, vec2, vec3, vec4 } from "three/tsl";
import {
  HalfFloatType,
  MeshBasicNodeMaterial,
  QuadMesh,
  RenderTarget,
  type WebGPURenderer,
} from "three/webgpu";

const WIDTH = 1280;
const HEIGHT = 720;

export interface GlitchOpts {
  input: TexNode;
  /** Overall glitch amount 0..1: tear distance, scanline depth, dropout rate. */
  amount?: SignalLike;
  /** Transient boost on top of amount — feed a kick envelope for beat-locked tears. */
  burst?: SignalLike;
  /** Horizontal tear band count (low = chunky tears, high = fine shredding). */
  slices?: SignalLike;
  /** RGB channel separation 0..1 (widens with burst). */
  split?: SignalLike;
}

/**
 * Datamosh-style glitch over any input: the input renders to a buffer, then
 * is re-sampled with per-row slice tearing (rows re-roll offsets ~9x/sec),
 * an RGB split, scanline flicker and occasional row dropouts. Stateful —
 * owns one render target so it can warp arbitrary upstream content.
 */
export const glitch = defineModule(
  {
    name: "glitch",
    kind: "effect",
    description: "Slice tearing, RGB split, scanlines and row dropouts over any input.",
    tags: ["glitch", "datamosh", "distortion", "stateful"],
    example: 'glitch(ctx, { input: src, amount: 0.6, burst: kickEnv, split: 0.5 })',
    chainParams: [
      { name: "amount", default: 0.6, min: 0, max: 1, description: "tear/scanline/dropout amount" },
      { name: "burst", default: 0, min: 0, max: 2, description: "transient boost (bind to a kick)" },
      { name: "slices", type: "int", default: 28, min: 1, max: 64, description: "tear band count" },
      { name: "split", default: 0.5, min: 0, max: 1, description: "RGB channel separation" },
    ],
  },
  (ctx: BuildCtx, opts: GlitchOpts): TexNode => {
    const rt = new RenderTarget(WIDTH, HEIGHT, { type: HalfFloatType });
    const amount = ctx.uniformOf(opts.amount ?? 0.6);
    const burst = ctx.uniformOf(opts.burst ?? 0);
    const slices = ctx.uniformOf(opts.slices ?? 28);
    const split = ctx.uniformOf(opts.split ?? 0.5);

    const srcMaterial = new MeshBasicNodeMaterial();
    srcMaterial.colorNode = opts.input.color;
    const srcQuad = new QuadMesh(srcMaterial);

    // Frame-clock time, NOT TSL `time` (wall clock) — keeps fixture replays deterministic.
    const t = ctx.uniformOf(ctx.time.now);
    // Per-row tear offsets, re-rolled ~9x/sec; only some rows tear.
    const row = floor(uv().y.mul(slices));
    const seed = row.mul(57.0).add(floor(t.mul(9)).mul(113.0));
    const tear = hash(seed).sub(0.5);
    const rowActive = step(0.65, hash(seed.add(13.0)));
    const tearAmt = amount.mul(burst.mul(1.6).add(0.12)).mul(0.35);
    const guv = uv().add(vec2(tear.mul(rowActive).mul(tearAmt), 0));

    const chroma = split.mul(burst.mul(0.03).add(0.004));
    const r = texture(rt.texture, guv.add(vec2(chroma, 0))).r;
    const g = texture(rt.texture, guv).g;
    const b = texture(rt.texture, guv.sub(vec2(chroma, 0))).b;

    const scan = sin(uv().y.mul(560).add(t.mul(24))).mul(0.5).add(0.5);
    const rowDrop = step(0.93, hash(seed.add(31.0))).mul(amount).mul(0.7);
    const dim = scan.mul(amount).mul(0.22).oneMinus().mul(rowDrop.oneMinus());

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

    return texNode(vec4(vec3(r, g, b).mul(dim), 1), [...opts.input.passes, pass]);
  },
);
