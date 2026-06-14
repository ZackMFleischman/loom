import { BuildCtx, defineModule, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import { add, dot, screenSize, smoothstep, texture, uv, vec2, vec3, vec4 } from "three/tsl";
import { HalfFloatType, MeshBasicNodeMaterial, NoBlending, QuadMesh, RenderTarget } from "three/webgpu";
import { bufferPass } from "../_shared";

export interface BloomOpts {
  input: TexNode;
  /** Luma level where glow starts. */
  level?: SignalLike;
  /** Glow strength added over the input. */
  intensity?: SignalLike;
  /** Glow spread in pixels. */
  radius?: SignalLike;
}

const W = [0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216];

function taps(rt: RenderTarget, dir: [number, number], radius: ReturnType<BuildCtx["uniformOf"]>) {
  const texel = vec2(dir[0], dir[1]).div(screenSize).mul(radius.div(4).max(0.001));
  let acc = texture(rt.texture, uv()).mul(W[0]!);
  for (let i = 1; i < W.length; i++) {
    const off = texel.mul(i);
    acc = add(acc, add(texture(rt.texture, uv().add(off)), texture(rt.texture, uv().sub(off))).mul(W[i]!));
  }
  return acc;
}

/**
 * Bloom (the TD Bloom TOP): bright-pass → separable blur → add over the input.
 * Tuned as one primitive so every kick can glow with a single chain step.
 */
export const bloom = defineModule(
  {
    name: "bloom",
    kind: "effect",
    description: "Glow: bright pixels bleed over the image (threshold → blur → add).",
    tags: ["bloom", "glow", "stateful", "finish"],
    example: 'bloom(ctx, { input: src, level: 0.6, intensity: kickEnv })',
    chainParams: [
      { name: "level", default: 0.6, min: 0, max: 1, step: 0.01, description: "luma where glow starts" },
      { name: "intensity", default: 0.8, min: 0, max: 3, step: 0.01, description: "glow strength" },
      { name: "radius", default: 14, min: 1, max: 60, step: 0.5, description: "glow spread (px)" },
    ],
  },
  (ctx: BuildCtx, opts: BloomOpts): TexNode => {
    const level = ctx.uniformOf(opts.level ?? 0.6);
    const intensity = ctx.uniformOf(opts.intensity ?? 0.8);
    const radius = ctx.uniformOf(opts.radius ?? 14);

    // Bright pass: the buffer holds the THRESHOLDED input (colorNode override).
    const c = opts.input.color;
    const luma = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
    const m = smoothstep(level.sub(0.0001), level.add(0.25), luma);

    const rtH = new RenderTarget(1, 1, { type: HalfFloatType });
    const hMaterial = new MeshBasicNodeMaterial();
    hMaterial.transparent = true;
    hMaterial.blending = NoBlending;
    const hQuad = new QuadMesh(hMaterial);

    const { rt: rtBright, pass } = bufferPass(opts.input, {
      colorNode: vec4(c.rgb.mul(m), 1),
      onResize: (w, h) => rtH.setSize(w, h),
      afterRender: (renderer) => {
        const prev = renderer.getRenderTarget();
        renderer.setRenderTarget(rtH);
        hQuad.render(renderer);
        renderer.setRenderTarget(prev);
      },
      onDispose: () => {
        rtH.dispose();
        hMaterial.dispose();
      },
    });
    hMaterial.colorNode = vec4(taps(rtBright, [1, 0], radius));

    const glow = taps(rtH, [0, 1], radius).rgb.mul(intensity.max(0));
    return texNode(vec4(c.rgb.add(glow), c.a), [...opts.input.passes, pass]);
  },
);
