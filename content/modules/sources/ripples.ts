import { BuildCtx, defineModule, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import { abs, float, fract, length, max, mix, uv, vec2, vec3, vec4 } from "three/tsl";
import type { Node } from "three/webgpu";

export interface RipplesOpts {
  /** Number of impact points (compile-time constant — the loop is unrolled). */
  count?: number;
  /** How far each ring travels before it dies, in surface-height units. */
  reach?: SignalLike;
  /** Ring crest thickness (surface-height units). */
  width?: SignalLike;
  /** Ripple emission speed multiplier (rings born more often). */
  speed?: SignalLike;
  /** Brightness/amplitude drive (~0..2) — feed a kick envelope so drops splash on the beat. */
  energy?: SignalLike;
  /** Output aspect ratio, keeps rings circular (compile-time constant). */
  aspect?: number;
}

/** Deterministic per-emitter pseudo-random in [0,1) — stable across rebuilds. */
const rand = (i: number, k: number) => {
  const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/**
 * Rain on hot broth: concentric ring wavefronts that are born at scattered
 * impact points, expand outward and fade — overlapping into a living liquid
 * surface. A bright leading crest plus a softer trailing ring per packet read
 * as light glinting off the rim of each ripple. Premultiplied alpha so it
 * drops onto broth via `over` or adds as sheen; the energy signal makes every
 * drop a kick-driven splash. Frame-clocked, so fixture replays are identical.
 */
export const ripples = defineModule(
  {
    name: "ripples",
    kind: "source",
    description: "Expanding concentric ripple wavefronts from scattered impact points (premultiplied) — rain-on-water, splashing on an energy signal.",
    tags: ["ripples", "water", "rings", "liquid", "pho", "audio-reactive", "overlay"],
    example: 'ripples(ctx, { count: 6, reach: 0.6, energy: kickEnv })',
  },
  (ctx: BuildCtx, opts: RipplesOpts = {}): TexNode => {
    const count = opts.count ?? 6;
    const aspect = opts.aspect ?? 16 / 9;
    const reach = ctx.uniformOf(opts.reach ?? 0.6);
    const width = ctx.uniformOf(opts.width ?? 0.02);
    const speed = ctx.uniformOf(opts.speed ?? 1);
    const energy = ctx.uniformOf(opts.energy ?? 0);
    // Frame-clock time, NOT TSL `time` (wall clock) — keeps fixture replays deterministic.
    const now = ctx.uniformOf(ctx.time.now);

    const p = uv().sub(0.5).mul(vec2(aspect, 1));
    const amp = energy.mul(0.8).add(0.4); // baseline shimmer + kick splash

    let crest: Node<"float"> = float(0);
    for (let i = 0; i < count; i++) {
      const cx = (rand(i, 1) - 0.5) * aspect * 0.82;
      const cy = (rand(i, 2) - 0.5) * 0.82;
      const rate = 0.18 + rand(i, 3) * 0.28; // packets/sec
      const off = rand(i, 4);
      const d = length(p.sub(vec2(cx, cy)));

      // One expanding packet per cycle: leading crest at R, trailing ring behind.
      const pphase = now.mul(rate).mul(speed).add(off).fract();
      const R = pphase.mul(reach);
      const decay = pphase.oneMinus().pow(1.4); // fade as it expands
      const lead = abs(d.sub(R)).div(width).oneMinus().max(0);
      const trail = abs(d.sub(R.sub(width.mul(2.2)))).div(width.mul(1.3)).oneMinus().max(0).mul(0.5);
      crest = crest.add(lead.add(trail).mul(decay));
    }
    crest = crest.mul(amp).clamp(0, 1.4);

    // Cool sheen on the crests, warmer where they pile up — premultiplied.
    const col = mix(ctx.palette.color(4), vec3(1, 1, 1), crest.mul(0.4));
    const a = crest.clamp(0, 1);
    return texNode(vec4(col.mul(crest), a));
  },
);
