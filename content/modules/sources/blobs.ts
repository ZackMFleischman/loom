import { BuildCtx, defineModule, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import { mx_fractal_noise_float, sin, smoothstep, uv, vec2, vec3, vec4 } from "three/tsl";

export interface BlobsOpts {
  /** Number of metaballs (compile-time constant). */
  count?: number;
  /** Base blob radius in UV units — drive with a signal to breathe/pulse. */
  size?: SignalLike;
  /** Drift speed multiplier on the blob paths. */
  speed?: SignalLike;
  /** FBM domain-warp amount for inky, wobbling edges. */
  wobble?: SignalLike;
  /** Threshold softness: ~0.1 = hard ink edge, ~0.5 = misty. */
  softness?: SignalLike;
  /** Output aspect ratio, keeps blobs round (compile-time constant). */
  aspect?: number;
}

/** Deterministic per-blob pseudo-random in [0,1) — stable across rebuilds. */
const rand = (i: number, k: number) => {
  const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/**
 * Classic metaball field: blobs drift on slow per-blob sine paths (mostly
 * vertical, lava-lamp style), their inverse-square fields sum, and a soft
 * threshold makes them merge and split like ink in oil.
 */
export const blobs = defineModule(
  {
    name: "blobs",
    kind: "source",
    description:
      "Drifting metaball ink blobs that merge and split, lava-lamp style. r/b = ink mask, g = inner-core glow.",
    tags: ["organic", "metaballs", "lava-lamp", "blobby"],
    example: 'blobs(ctx, { count: 6, size: 0.14, speed: 0.5 })',
  },
  (ctx: BuildCtx, opts: BlobsOpts = {}): TexNode => {
    const count = opts.count ?? 6;
    const aspect = opts.aspect ?? 16 / 9;
    const size = ctx.uniformOf(opts.size ?? 0.14);
    const speed = ctx.uniformOf(opts.speed ?? 0.5);
    const wobble = ctx.uniformOf(opts.wobble ?? 0.05);
    const softness = ctx.uniformOf(opts.softness ?? 0.3);

    // Frame-clock time, NOT TSL `time` (wall clock) — keeps fixture replays deterministic.
    const now = ctx.uniformOf(ctx.time.now);
    const warpAt = vec3(uv().mul(3), now.mul(0.07));
    const warp = vec2(
      mx_fractal_noise_float(warpAt, 2),
      mx_fractal_noise_float(warpAt.add(vec3(7.3, 1.7, 0)), 2),
    ).mul(wobble);
    const p = uv().sub(vec2(0.5)).mul(vec2(aspect, 1)).add(warp);

    const t = now.mul(speed);
    const parts = Array.from({ length: count }, (_, i) => {
      const x0 = (rand(i, 1) - 0.5) * aspect * 0.8;
      const sway = 0.06 + rand(i, 2) * 0.12;
      const fx = 0.2 + rand(i, 3) * 0.35;
      const fy = 0.09 + rand(i, 4) * 0.24;
      const rise = 0.3 + rand(i, 5) * 0.2;
      const center = vec2(
        sin(t.mul(fx).add(rand(i, 6) * Math.PI * 2)).mul(sway).add(x0),
        sin(t.mul(fy).add(rand(i, 7) * Math.PI * 2)).mul(rise),
      );
      const radius = size.mul(0.7 + rand(i, 8) * 0.6);
      const dp = p.sub(center);
      return radius.mul(radius).div(dp.dot(dp).add(1e-5));
    });
    const field = parts.reduce((a, b) => a.add(b));

    const ink = smoothstep(softness.oneMinus(), softness.add(1), field);
    const core = smoothstep(1.6, 5.0, field); // hot where fields stack deep
    return texNode(vec4(ink, core, ink, 1));
  },
);
