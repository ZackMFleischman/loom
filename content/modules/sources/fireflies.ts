import { BuildCtx, defineModule, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import { cos, float, pow, select, sin, uv, vec2, vec3, vec4 } from "three/tsl";

const TAU = Math.PI * 2;

export interface FirefliesOpts {
  /** Hard ceiling on flies baked into the shader (compile-time constant). Default 40. */
  maxCount?: number; // compile-time ceiling, default 80
  /** How many flies are actually visible (runtime SignalLike, clamped to maxCount). */
  count?: SignalLike;
  /** Base glow radius in UV units — per-fly radii fan out around this. */
  size?: SignalLike;
  /** Drift speed multiplier on the wander paths. */
  speed?: SignalLike;
  /** Blink rate multiplier — per-fly rates scatter around it. */
  twinkle?: SignalLike;
  /** Blink sharpness: ~1 = slow breathing glow, ~8 = hard glints. */
  sharpness?: SignalLike;
  /** Palette center hue 0..1 (cosine palette). */
  hue?: SignalLike;
  /** Per-fly hue scatter: 0 = monochrome swarm, 1 = full rainbow. */
  hueSpread?: SignalLike;
  /** Overall gain — drive with audio to make the whole swarm flare. */
  brightness?: SignalLike;
  /** Output aspect ratio, keeps glows round (compile-time constant). */
  aspect?: number;
}

/** Deterministic per-fly pseudo-random in [0,1) — stable across rebuilds. */
const rand = (i: number, k: number) => {
  const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/**
 * Each fly wanders on its own slow sine path and blinks on the product of two
 * incommensurate sines (irregular, never quite periodic), raised to a
 * sharpness power for glinty sparkle. Per-fly hue, radius, base intensity and
 * blink rate are deterministic randoms, so no two flies match.
 */
export const fireflies = defineModule(
  {
    name: "fireflies",
    kind: "source",
    description:
      "A swarm of drifting glow-points, each twinkling at its own rate, color and intensity, with white-hot cores.",
    tags: ["particles", "sparkle", "organic", "night", "audio-reactive"],
    example: 'fireflies(ctx, { count: 28, size: 0.035, hueSpread: 0.4 })',
  },
  (ctx: BuildCtx, opts: FirefliesOpts = {}): TexNode => {
    const maxCount = opts.maxCount ?? 80;
    const countU = ctx.uniformOf(opts.count ?? maxCount);
    const aspect = opts.aspect ?? 16 / 9;
    const size = ctx.uniformOf(opts.size ?? 0.035);
    const speed = ctx.uniformOf(opts.speed ?? 0.4);
    const twinkle = ctx.uniformOf(opts.twinkle ?? 1);
    const sharpness = ctx.uniformOf(opts.sharpness ?? 4);
    const hue = ctx.uniformOf(opts.hue ?? 0.3);
    const hueSpread = ctx.uniformOf(opts.hueSpread ?? 0.4);
    const brightness = ctx.uniformOf(opts.brightness ?? 1);

    const p = uv().sub(vec2(0.5)).mul(vec2(aspect, 1));
    // Frame-clock time, NOT TSL `time` (wall clock) — keeps fixture replays deterministic.
    const now = ctx.uniformOf(ctx.time.now);
    const t = now.mul(speed);
    const tb = now.mul(twinkle);

    const flies = Array.from({ length: maxCount }, (_, i) => {
      // wander: home position + two slow sines per axis
      const x0 = (rand(i, 1) - 0.5) * aspect * 0.94;
      const y0 = (rand(i, 2) - 0.5) * 0.92;
      const center = vec2(
        sin(t.mul(0.21 + rand(i, 3) * 0.3).add(rand(i, 4) * TAU)).mul(0.1 + rand(i, 5) * 0.2).add(x0),
        sin(t.mul(0.17 + rand(i, 6) * 0.26).add(rand(i, 7) * TAU)).mul(0.08 + rand(i, 8) * 0.16).add(y0),
      );
      const dp = p.sub(center);
      const d2 = dp.dot(dp);

      const r = size.mul(0.5 + rand(i, 9) * 1.0); // varied sizes
      const s2 = r.mul(r);
      const fall = s2.div(d2.add(s2)); // 1 at center, soft tail
      const glow = fall.mul(fall);
      const core = pow(fall, 10.0); // white-hot pinpoint

      // irregular blink: product of two incommensurate sines, sharpened
      const blink = sin(tb.mul(0.6 + rand(i, 10) * 1.3).add(rand(i, 11) * TAU))
        .mul(0.5).add(0.5)
        .mul(sin(tb.mul(1.1 + rand(i, 12) * 1.7).add(rand(i, 13) * TAU)).mul(0.4).add(0.6));
      const spark = pow(blink, sharpness).mul(0.92).add(0.08); // never fully off

      const flyHue = hue.add(hueSpread.mul(rand(i, 14) - 0.5));
      const col = cos(flyHue.add(vec3(0, 0.33, 0.67)).mul(TAU)).mul(0.5).add(0.5);
      const intensity = 0.35 + rand(i, 15) * 0.65; // dim stragglers to beacons
      const flyColor = col.mul(glow).add(vec3(core.mul(0.7))).mul(spark.mul(intensity));
      return select(float(i).lessThan(countU), flyColor, vec3(0));
    });

    const acc = flies.reduce((a, b) => a.add(b)).mul(brightness);
    return texNode(vec4(acc, 1));
  },
);
