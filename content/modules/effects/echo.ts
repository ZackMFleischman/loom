import { BuildCtx, defineModule, texNode, type Pass, type SignalLike, type TexNode } from "@loom/runtime";
import { mix, texture, vec4 } from "three/tsl";
import { HalfFloatType, MeshBasicNodeMaterial, NoBlending, QuadMesh, RenderTarget, type WebGPURenderer } from "three/webgpu";

export interface EchoOpts {
  input: TexNode;
  /** How far back the echo reads, in frames (0..maxFrames−1). */
  delay?: SignalLike;
  /** Echo blend over the live frame (0 = off). */
  amount?: SignalLike;
  /** Ring-buffer length in frames (compile-time; memory!). */
  maxFrames?: number;
}

/** Echo frames are stored at this fixed resolution — ghosts don't need 1080p. */
const W = 640;
const H = 360;

/**
 * Frame echo (the TD Time Machine/Cache idiom): a ring buffer of past frames,
 * blended back over the live image — REPLAYS history where `feedback`
 * accumulates it. Buffer frames live at 640×360 to keep VRAM sane.
 */
export const echo = defineModule(
  {
    name: "echo",
    kind: "effect",
    description: "Blends an N-frames-ago copy over the live frame (video echo/ghosting).",
    tags: ["echo", "delay", "ghost", "stateful"],
    example: 'echo(ctx, { input: src, delay: 10, amount: 0.5 })',
    chainParams: [
      { name: "delay", type: "int", default: 8, min: 0, max: 23, description: "echo distance (frames back)" },
      { name: "amount", default: 0.45, min: 0, max: 1, step: 0.01, description: "echo blend over the live frame" },
    ],
  },
  (ctx: BuildCtx, opts: EchoOpts): TexNode => {
    const frames = Math.max(2, Math.min(48, Math.round(opts.maxFrames ?? 24)));
    const delay = ctx.uniformOf(opts.delay ?? 8);
    const amount = ctx.uniformOf(opts.amount ?? 0.45);

    const ring = Array.from({ length: frames }, () => new RenderTarget(W, H, { type: HalfFloatType }));
    let head = 0;

    const srcMaterial = new MeshBasicNodeMaterial();
    srcMaterial.colorNode = opts.input.color;
    srcMaterial.transparent = true;
    srcMaterial.blending = NoBlending;
    const srcQuad = new QuadMesh(srcMaterial);

    // The output samples ONE texture object whose .value is swapped per frame
    // to the ring slot `delay` frames back (a texture write, no rebuild).
    const tapTex = texture(ring[0]!.texture);

    const pass: Pass = {
      render(renderer: WebGPURenderer, f) {
        const prev = renderer.getRenderTarget();
        renderer.setRenderTarget(ring[head]!);
        srcQuad.render(renderer);
        renderer.setRenderTarget(prev);
        const back = Math.max(0, Math.min(frames - 1, Math.round(delay.value as number)));
        tapTex.value = ring[(head - back + frames * 2) % frames]!.texture;
        head = (head + 1) % frames;
        void f;
      },
      dispose() {
        for (const rt of ring) rt.dispose();
        srcMaterial.dispose();
      },
    };

    const live = opts.input.color;
    const out = mix(live.rgb, tapTex.rgb, amount.clamp(0, 1));
    return texNode(vec4(out, live.a), [...opts.input.passes, pass]);
  },
);
