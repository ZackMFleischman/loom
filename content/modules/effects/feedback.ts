import {
  BuildCtx,
  defineModule,
  texNode,
  type FrameCtx,
  type Pass,
  type SignalLike,
  type TexNode,
} from "@loom/runtime";
import { max, texture, uv, vec4 } from "three/tsl";
import {
  HalfFloatType,
  MeshBasicNodeMaterial,
  QuadMesh,
  RenderTarget,
  type WebGPURenderer,
} from "three/webgpu";

const WIDTH = 1280;
const HEIGHT = 720;

export interface FeedbackOpts {
  input: TexNode;
  /** Trail persistence per frame (0..0.97-ish; higher = longer trails). */
  amount?: SignalLike;
  /** Per-frame UV zoom on the history (>1 drifts outward). */
  zoom?: SignalLike;
}

/**
 * Classic video feedback: blends the input with a zoomed copy of the
 * previous frame via ping-ponged render targets. Stateful — the instance
 * rebuild policy (NFR-5) resets history on any code change.
 */
export const feedback = defineModule(
  {
    name: "feedback",
    kind: "effect",
    description: "Ping-pong video feedback with zoomable trails.",
    tags: ["stateful", "trails", "classic"],
    example: 'feedback(ctx, { input: src, amount: 0.9, zoom: 1.01 })',
    chainParams: [
      { name: "amount", default: 0.9, min: 0, max: 0.97, description: "trail persistence per frame" },
      { name: "zoom", default: 1.0, min: 0.9, max: 1.1, step: 0.001, description: "per-frame zoom on history" },
    ],
  },
  (ctx: BuildCtx, opts: FeedbackOpts): TexNode => {
    const rtA = new RenderTarget(WIDTH, HEIGHT, { type: HalfFloatType });
    const rtB = new RenderTarget(WIDTH, HEIGHT, { type: HalfFloatType });
    let read = rtA;
    let write = rtB;

    const amount = ctx.uniformOf(opts.amount ?? 0.9);
    const zoom = ctx.uniformOf(opts.zoom ?? 1.0);

    const historyUv = uv().sub(0.5).div(zoom).add(0.5);
    const history = texture(rtA.texture, historyUv);
    const acc = max(opts.input.color, vec4(history.mul(amount)));
    const accMaterial = new MeshBasicNodeMaterial();
    accMaterial.colorNode = acc;
    const accQuad = new QuadMesh(accMaterial);

    const output = texture(rtA.texture);

    const pass: Pass = {
      render(renderer: WebGPURenderer, _f: FrameCtx) {
        history.value = read.texture;
        const prevTarget = renderer.getRenderTarget();
        renderer.setRenderTarget(write);
        accQuad.render(renderer);
        renderer.setRenderTarget(prevTarget);
        [read, write] = [write, read];
        output.value = read.texture; // freshly written this frame
      },
      dispose() {
        rtA.dispose();
        rtB.dispose();
        accMaterial.dispose();
      },
    };

    return texNode(vec4(output.rgb, 1), [...opts.input.passes, pass]);
  },
);
