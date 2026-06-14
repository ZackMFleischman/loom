import { BuildCtx, defineModule, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import { add, cos, dot, mix, sin, vec3, vec4 } from "three/tsl";

export interface HsvOpts {
  input: TexNode;
  /** Hue rotation in turns (−1..1; 0.5 = opposite hues). */
  hue?: SignalLike;
  /** 0 = grayscale · 1 = unchanged · 2 = oversaturated. */
  saturation?: SignalLike;
  /** Brightness multiplier. */
  value?: SignalLike;
}

const LUMA = vec3(0.2126, 0.7152, 0.0722);

/**
 * Hue/saturation/value adjust (the TD HSV Adjust TOP). Hue rotates around the
 * luma axis (the classic YIQ trick — branchless, cheap), so a slow hue LFO is
 * one chain step. `levels` does gain/gamma; this does color.
 */
export const hsv = defineModule(
  {
    name: "hsv",
    kind: "effect",
    description: "Hue rotation, saturation and value adjust — the color half of grading.",
    tags: ["hue", "saturation", "color", "grade"],
    example: 'hsv(ctx, { input: src, hue: lfo(ctx, { periodBeats: 32 }) })',
    chainParams: [
      { name: "hue", default: 0, min: -1, max: 1, step: 0.001, description: "hue rotation (turns)" },
      { name: "saturation", default: 1, min: 0, max: 2, step: 0.01, description: "0 gray · 1 as-is · 2 hyper" },
      { name: "value", default: 1, min: 0, max: 2, step: 0.01, description: "brightness multiplier" },
    ],
  },
  (ctx: BuildCtx, opts: HsvOpts): TexNode => {
    const hue = ctx.uniformOf(opts.hue ?? 0);
    const saturation = ctx.uniformOf(opts.saturation ?? 1);
    const value = ctx.uniformOf(opts.value ?? 1);

    const c = opts.input.color;
    // Hue rotation about the gray axis (Rodrigues on (1,1,1)/√3).
    const angle = hue.mul(Math.PI * 2);
    const cosA = cos(angle);
    const sinA = sin(angle);
    const k = vec3(1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3));
    const rgb = c.rgb;
    const rotated = add(
      add(rgb.mul(cosA), k.cross(rgb).mul(sinA)),
      k.mul(dot(k, rgb)).mul(cosA.oneMinus()),
    );
    const gray = vec3(dot(rotated, LUMA), dot(rotated, LUMA), dot(rotated, LUMA));
    const out = mix(gray, rotated, saturation).mul(value.max(0));
    return texNode(vec4(out, c.a), opts.input.passes);
  },
);
