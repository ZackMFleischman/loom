import { asSignal, BuildCtx, defineModule, integrateSignal, Signal, type SignalLike } from "@loom/runtime";

export interface NoiseSignalOpts {
  /** Evolution speed of the wander (units per second). */
  rate?: SignalLike;
  /** Output range low end. */
  lo?: number;
  /** Output range high end. */
  hi?: number;
  /** Fractal harmonics (1..6) — more = jaggier wander. */
  octaves?: number;
  /** Per-octave amplitude falloff (roughness). */
  gain?: number;
  /** Per-octave frequency multiplier. */
  lacunarity?: number;
  /** Phase seed — decorrelate sibling noise channels. */
  seed?: number;
}

/**
 * The CHOP-side companion to `noiseField`: a CPU value-noise that wanders
 * smoothly through a range, on the frame clock (so fixture replays match).
 * Drop it into any `SignalLike` opt — drive a rotation, a position, a knob —
 * the way TouchDesigner patches a Noise CHOP into a parameter.
 */
export const noiseSignal = defineModule(
  {
    name: "noiseSignal",
    kind: "control",
    description: "Smooth fractal value-noise wander in a range — the Noise CHOP for driving any param.",
    tags: ["noise", "modulation", "wander", "lfo", "control"],
    example: 'noiseSignal(ctx, { rate: 0.4, lo: -1, hi: 1, octaves: 3 })',
  },
  (ctx: BuildCtx, opts: NoiseSignalOpts = {}): Signal<number> => {
    const lo = opts.lo ?? 0;
    const hi = opts.hi ?? 1;
    const oct = Math.max(1, Math.min(6, Math.round(opts.octaves ?? 3)));
    const gain = opts.gain ?? 0.5;
    const lac = opts.lacunarity ?? 2;
    const seed = opts.seed ?? 0;
    // Integrated rate → a deterministic, frame-clocked phase that survives rate changes.
    const phase = integrateSignal(asSignal(opts.rate ?? 0.3));

    const hash = (n: number): number => {
      const s = Math.sin(n * 12.9898) * 43758.5453;
      return s - Math.floor(s);
    };
    // 1D value noise with smoothstep interpolation → 0..1.
    const vnoise = (x: number): number => {
      const i = Math.floor(x);
      const f = x - i;
      const u = f * f * (3 - 2 * f);
      return hash(i) * (1 - u) + hash(i + 1) * u;
    };
    const fbm = (x: number): number => {
      let amp = 1;
      let freq = 1;
      let sum = 0;
      let norm = 0;
      for (let o = 0; o < oct; o++) {
        sum += amp * vnoise(x * freq + o * 17.3);
        norm += amp;
        amp *= gain;
        freq *= lac;
      }
      return sum / norm;
    };

    return new Signal((f) => lo + (hi - lo) * fbm(phase.get(f) + seed));
  },
);
