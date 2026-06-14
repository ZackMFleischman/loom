import { BuildCtx, defineModule, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import { abs, atan, cos, float, length, max, mix, sin, smoothstep, uv, vec2, vec3, vec4 } from "three/tsl";
import type { Node } from "three/webgpu";

export interface StarAniseOpts {
  /** Pod count (compile-time constant — the loop is unrolled). */
  count?: number;
  /** Base pod radius in surface-height units — drive to breathe the spice. */
  size?: SignalLike;
  /** Per-pod spin speed (rad/sec); alternate pods counter-rotate. */
  spin?: SignalLike;
  /** Slow positional drift amount (fraction of frame). */
  drift?: SignalLike;
  /** Flare brightness drive (~0..2) — feed a kick/bass envelope so pods glow on the beat. */
  energy?: SignalLike;
  /** Output aspect ratio, keeps pods round (compile-time constant). */
  aspect?: number;
}

/** Deterministic per-pod pseudo-random in [0,1) — stable across rebuilds. */
const rand = (i: number, k: number) => {
  const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/**
 * A scattered field of star-anise pods — the signature phở aromatic. Each pod
 * is an eight-lobed SDF flower (|cos 4θ|) with a creamy seed highlight glinting
 * in every carpel, woody-brown through the palette, slowly tumbling and
 * drifting. An energy signal flares the pods (each twinkling on its own clock).
 * Premultiplied alpha — drops onto any backdrop via `over`.
 */
export const starAnise = defineModule(
  {
    name: "starAnise",
    kind: "source",
    description: "A drifting field of eight-lobed star-anise spice pods with seed glints (premultiplied), flaring on an energy signal.",
    tags: ["star-anise", "spice", "pho", "botanical", "organic", "audio-reactive", "overlay"],
    example: 'starAnise(ctx, { count: 7, size: 0.12, energy: kickEnv })',
  },
  (ctx: BuildCtx, opts: StarAniseOpts = {}): TexNode => {
    const count = opts.count ?? 7;
    const aspect = opts.aspect ?? 16 / 9;
    const size = ctx.uniformOf(opts.size ?? 0.12);
    const spin = ctx.uniformOf(opts.spin ?? 0.15);
    const drift = ctx.uniformOf(opts.drift ?? 0.03);
    const energy = ctx.uniformOf(opts.energy ?? 0);
    // Frame-clock time, NOT TSL `time` (wall clock) — keeps fixture replays deterministic.
    const now = ctx.uniformOf(ctx.time.now);

    const rim = ctx.palette.color(1); // dark carpel edge
    const bodyA = ctx.palette.color(2); // pod body
    const bodyB = ctx.palette.color(3); // lobe-tip warmth
    const seedCol = ctx.palette.color(4); // creamy seed glint

    const field = uv().sub(0.5).mul(vec2(aspect, 1));

    let outRGB: Node<"vec3"> = vec3(0, 0, 0);
    let outA: Node<"float"> = float(0);
    for (let i = 0; i < count; i++) {
      const cx0 = (rand(i, 1) - 0.5) * aspect * 0.86;
      const cy0 = (rand(i, 2) - 0.5) * 0.86;
      const dRateX = 0.08 + rand(i, 3) * 0.18;
      const dRateY = 0.07 + rand(i, 4) * 0.16;
      const ph = rand(i, 5) * Math.PI * 2;
      const center = vec2(
        now.mul(dRateX).add(ph).sin().mul(drift).add(cx0),
        now.mul(dRateY).add(ph).cos().mul(drift).add(cy0),
      );

      const R = size.mul(0.55 + rand(i, 6) * 0.9);
      const dir = i % 2 ? 1 : -1;
      const rot = now.mul(spin).mul(dir).add(rand(i, 7) * 6.2831);
      const c = cos(rot);
      const s = sin(rot);
      const q = field.sub(center);
      const p = vec2(c.mul(q.x).add(s.mul(q.y)), c.mul(q.y).sub(s.mul(q.x)));

      const ang = atan(p.y, p.x);
      const rad = length(p);
      const lobe = abs(cos(ang.mul(4))).pow(0.55); // 8 carpels
      const edgeR = R.mul(float(0.42).add(lobe.mul(0.58)));
      const body = smoothstep(edgeR, edgeR.sub(R.mul(0.14)), rad).mul(
        smoothstep(R.mul(0.05), R.mul(0.16), rad), // tiny dark center nub
      );
      // Seed glint: bright spot partway out along each carpel axis.
      const seed = smoothstep(float(0.72), float(1), lobe)
        .mul(smoothstep(R.mul(0.32), R.mul(0.52), rad))
        .mul(smoothstep(R.mul(0.82), R.mul(0.58), rad));

      const twinkle = now.mul(0.6 + rand(i, 8) * 0.7).add(rand(i, 9) * 6.28).sin().mul(0.5).add(0.5);
      const bright = float(1).add(energy.mul(float(0.4).add(twinkle.mul(1.1))));

      const woody = mix(bodyA, bodyB, lobe);
      const col = mix(mix(rim, woody, smoothstep(float(0), float(0.5), body)), seedCol, seed).mul(bright);

      outRGB = max(outRGB, col.mul(body));
      outA = max(outA, body);
    }
    return texNode(vec4(outRGB, outA)); // premultiplied
  },
);
