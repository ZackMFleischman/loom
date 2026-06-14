import { asSignal, BuildCtx, defineModule, integrateSignal, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import { float, mx_cell_noise_float, mx_noise_float, mx_worley_noise_float, uv, vec2, vec3, vec4 } from "three/tsl";
import { surfaceAspect } from "../_shared";
import type { Node } from "three/webgpu";

/** The noise basis (TouchDesigner's Noise "Type" menu) — picks the per-octave function. */
export type NoiseKind = "perlin" | "ridged" | "worley" | "cell";

export interface NoiseFieldOpts {
  /** Noise basis (compile-time, like TD's Type menu): smooth fBm, ridged peaks, cellular, or blocky random. */
  type?: NoiseKind;
  /** Spatial scale — bigger = busier (TD "Period", inverted). */
  scale?: SignalLike;
  /** Fractal harmonics / octaves (compile-time, 1..8). */
  octaves?: number;
  /** Per-octave amplitude falloff (TD "Gain"/roughness; <0.5 smooth, >0.5 rough). */
  gain?: SignalLike;
  /** Per-octave frequency multiplier (TD "Harmonic Spread"). */
  lacunarity?: SignalLike;
  /** Contrast shaping — >1 crushes lows to black, <1 lifts (TD "Exponent"). */
  exponent?: SignalLike;
  /** Output amplitude (TD "Amplitude"). */
  amplitude?: SignalLike;
  /** Output brightness offset (TD "Offset"). */
  offset?: SignalLike;
  /** Horizontal drift speed — translates the field over the frame clock. */
  flowX?: SignalLike;
  /** Vertical drift speed. */
  flowY?: SignalLike;
  /** Z-axis evolution speed — the field churns in place. */
  evolve?: SignalLike;
  /** Colour the field through the active palette ramp instead of greyscale. */
  palette?: boolean;
}

/** One octave of the chosen basis, normalised to roughly [-1, 1]. */
function baseSample(type: NoiseKind, p: Node<"vec3">): Node<"float"> {
  switch (type) {
    case "ridged":
      return float(1).sub(mx_noise_float(p).abs()).mul(2).sub(1);
    case "worley":
      return mx_worley_noise_float(p, 1).mul(2).sub(1);
    case "cell":
      return mx_cell_noise_float(p).mul(2).sub(1);
    case "perlin":
    default:
      return mx_noise_float(p);
  }
}

/**
 * A full TouchDesigner-style Noise TOP: a fractal field with a pickable basis
 * (smooth/ridged/cellular/random), live harmonics, gain, lacunarity, exponent
 * contrast, amplitude/offset, and 3D flow — all on the frame clock so fixture
 * replays stay deterministic. Greyscale by default (feed it to `displace`/
 * `colorize`), or `palette: true` to ramp it through the global palette.
 */
export const noiseField = defineModule(
  {
    name: "noiseField",
    kind: "source",
    description: "TouchDesigner-style fractal noise: pickable basis, live harmonics/gain/exponent, 3D flow (grey or palette).",
    tags: ["noise", "fractal", "fbm", "worley", "texture", "organic"],
    example: 'noiseField(ctx, { type: "perlin", scale: 3, octaves: 5, flowX: 0.2 })',
  },
  (ctx: BuildCtx, opts: NoiseFieldOpts = {}): TexNode => {
    const type = opts.type ?? "perlin";
    const oct = Math.max(1, Math.min(8, Math.round(opts.octaves ?? 4)));

    const scale = ctx.uniformOf(opts.scale ?? 3);
    const gain = ctx.uniformOf(opts.gain ?? 0.5);
    const lac = ctx.uniformOf(opts.lacunarity ?? 2);
    const exponent = ctx.uniformOf(opts.exponent ?? 1);
    const amplitude = ctx.uniformOf(opts.amplitude ?? 1);
    const offset = ctx.uniformOf(opts.offset ?? 0);
    // Frame-clock drift/evolution (integrated rates — never TSL `time`).
    const flowX = ctx.uniformOf(integrateSignal(asSignal(opts.flowX ?? 0)));
    const flowY = ctx.uniformOf(integrateSignal(asSignal(opts.flowY ?? 0)));
    const evolve = ctx.uniformOf(integrateSignal(asSignal(opts.evolve ?? 0.2)));

    const xy = uv().mul(vec2(surfaceAspect(), 1)).mul(scale.max(0.1)).add(vec2(flowX, flowY));
    const p = vec3(xy, evolve);

    // Fractal summation: octaves of the chosen basis, gain-weighted, lacunarity-spread.
    let sum: Node<"float"> = float(0);
    let norm: Node<"float"> = float(0);
    for (let o = 0; o < oct; o++) {
      const amp = gain.pow(o);
      const freq = lac.pow(o);
      sum = sum.add(baseSample(type, p.mul(freq)).mul(amp));
      norm = norm.add(amp);
    }
    const n = sum.div(norm.max(0.0001));

    // Centre to 0..1, shape by exponent, then amplitude/offset — all clamped finite.
    let v = n.mul(0.5).add(0.5).clamp(0, 1);
    v = v.pow(exponent.max(0.01));
    v = v.mul(amplitude).add(offset).clamp(0, 1);

    return texNode(opts.palette ? ctx.palette.ramp(v) : vec4(vec3(v), 1));
  },
);
