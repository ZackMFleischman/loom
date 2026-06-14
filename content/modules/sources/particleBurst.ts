import { BuildCtx, defineModule, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import { float, length, max, mix, uv, vec2, vec3, vec4 } from "three/tsl";
import type { Node } from "three/webgpu";
import { glowDot, surfaceAspect } from "../_shared";

const TAU = Math.PI * 2;

export interface ParticleBurstOpts {
  /** Simultaneous burst sites (compile-time, unrolled). Default 7. */
  bursts?: number;
  /** Shards flung per burst (compile-time, unrolled). Default 10. */
  particles?: number;
  /** Brightness/trigger drive (~0..2) — feed a kick envelope so bursts flare on the beat. */
  burst?: SignalLike;
  /** Detonation rate — burst loops per second (each site re-pops on its own clock). */
  rate?: SignalLike;
  /** How far shards fly before dying (surface-height units). */
  spread?: SignalLike;
  /** Shard glow size (surface-height units). */
  size?: SignalLike;
  /** Fade shaping: higher = shards die quicker after the flash. */
  decay?: SignalLike;
  /** Shard palette stop (0..4). Default 4 (accent). */
  colorStop?: number;
  /** Per-shard whiten toward the core, 0..1. */
  hueSpread?: number;
  /** Overall brightness. */
  brightness?: SignalLike;
  /** Confine bursts to a centered box (height units): x half-extent. Default fills the frame. (autonomous mode) */
  spanX?: number;
  /** Confine bursts to a centered box (height units): y half-extent. Default fills the frame. (autonomous mode) */
  spanY?: number;
  /**
   * Scene-driven detonations (uv 0..1) instead of the autonomous scatter — one
   * explosion per site, each triggered by its own `fire` envelope (1 = fresh
   * detonation, decays to 0). Wire bullet-hit positions here so blasts land
   * exactly where the action is.
   */
  sites?: { x: SignalLike; y: SignalLike; fire?: SignalLike }[];
}

/** Deterministic per-burst / per-shard pseudo-random in [0,1) — stable across rebuilds. */
const rand = (i: number, k: number) => {
  const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/**
 * Constant fireworks of radial shard explosions scattered across the field —
 * each site re-detonates on its own looping clock, flinging glowing particles
 * outward from a white flash that fade as they fly. The `burst` signal flares
 * every site at once, so feeding it a kick makes the whole field pop on the
 * beat: the death-particle juice of a twin-stick shooter. Premultiplied alpha
 * for over+bloom. Frame-clocked, so fixture replays are byte-identical.
 */
export const particleBurst = defineModule(
  {
    name: "particleBurst",
    kind: "source",
    description:
      "Radial shard explosions scattered across the field, each re-detonating on its own clock and flaring together on a kick — premultiplied for over+bloom.",
    tags: ["arcade", "geometry-wars", "particles", "explosion", "overlay", "audio-reactive"],
    example: 'particleBurst(ctx, { bursts: 7, particles: 10, burst: ctx.input("kick") })',
  },
  (ctx: BuildCtx, opts: ParticleBurstOpts = {}): TexNode => {
    const bursts = Math.max(1, Math.round(opts.bursts ?? 7));
    const shards = Math.max(1, Math.round(opts.particles ?? 10));
    const colorStop = Math.max(0, Math.min(4, Math.round(opts.colorStop ?? 4)));
    const hueSpread = opts.hueSpread ?? 0.5;

    const burstU = ctx.uniformOf(opts.burst ?? 0);
    const rate = ctx.uniformOf(opts.rate ?? 0.7);
    const spread = ctx.uniformOf(opts.spread ?? 0.28);
    const size = ctx.uniformOf(opts.size ?? 0.02);
    const decay = ctx.uniformOf(opts.decay ?? 1.4);
    const bright = ctx.uniformOf(opts.brightness ?? 1);

    // Frame-clock time, NOT TSL `time` (wall clock) — keeps fixture replays deterministic.
    const now = ctx.uniformOf(ctx.time.now);
    const asp = surfaceAspect();
    const spanX = opts.spanX ?? 0.5 * (16 / 9);
    const spanY = opts.spanY ?? 0.46;
    const p = uv().sub(0.5).mul(vec2(asp, 1));
    const drive = burstU.mul(1.1).add(0.25); // faint idle pops, kick-flared

    let acc: Node<"vec3"> = vec3(0);
    let alpha: Node<"float"> = float(0);

    // One explosion: a white flash at `bphase`≈0 and shards flying out as it
    // grows to 1, all scaled by `gain` (the per-burst brightness envelope).
    const drawBurst = (center: Node<"vec2">, bphase: Node<"float">, b: number, gain: Node<"float">) => {
      const fade = bphase.oneMinus().pow(decay).mul(gain); // bright at birth → 0
      const reach = bphase.pow(0.55).mul(spread); // ease-out expansion
      const flash = glowDot(length(p.sub(center)), size.mul(2.4), vec3(1));
      acc = acc.add(flash.rgb.mul(bphase.oneMinus().pow(6).mul(fade)));
      for (let j = 0; j < shards; j++) {
        const a = (j / shards) * TAU + rand(b, 10 + j) * 0.6;
        const jr = reach.mul(0.55 + rand(b, 40 + j) * 0.9);
        const pos = center.add(vec2(Math.cos(a), Math.sin(a)).mul(jr));
        const col = mix(ctx.palette.color(colorStop), vec3(1), 0.25 + rand(b, 70 + j) * hueSpread);
        const dot = glowDot(length(p.sub(pos)), size.mul(0.6 + rand(b, 90 + j) * 0.7), col);
        acc = acc.add(dot.rgb.mul(fade));
        alpha = max(alpha, dot.a.mul(fade));
      }
    };

    const sites = opts.sites;
    if (sites && sites.length) {
      // Scene-driven mode: detonate where the scene says (e.g. each bullet hit),
      // with the `fire` envelope per site (1 = fresh detonation, decays to 0).
      for (let b = 0; b < sites.length; b++) {
        const s = sites[b]!;
        const center = vec2(ctx.uniformOf(s.x).sub(0.5).mul(asp), ctx.uniformOf(s.y).sub(0.5));
        const fire = ctx.uniformOf(s.fire ?? 1).clamp(0, 1);
        drawBurst(center, fire.oneMinus(), b, fire.mul(bright));
      }
    } else {
      // Autonomous mode: scattered sites each re-detonate on their own clock.
      for (let b = 0; b < bursts; b++) {
        const cb = vec2((rand(b, 1) - 0.5) * 2 * spanX, (rand(b, 2) - 0.5) * 2 * spanY);
        const bphase = now.mul(rate).mul(0.7 + rand(b, 3) * 0.7).add(rand(b, 4)).fract();
        drawBurst(cb, bphase, b, drive.mul(bright));
      }
    }

    return texNode(vec4(acc, alpha.clamp(0, 1)));
  },
);
