import { BuildCtx, defineModule, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import { length, mix, sin, smoothstep, uv, vec2, vec3, vec4 } from "three/tsl";
import { noise } from "./noise";

export interface PulseRingsOpts {
  /** Ring density — wave count across the field. */
  freq?: SignalLike;
  /** Ring travel speed (cycles/sec-ish). */
  speed?: SignalLike;
  /** Brightness drive (~0..2) — feed kick envelope + bass for the reactive look. */
  energy?: SignalLike;
  /** Glow palette blend: 0 = teal, 1 = magenta. */
  hue?: SignalLike;
  /** FBM grain mixed into the ink (0 skips the noise module entirely). */
  grain?: number;
  /** Aspect correction so rings stay circular (compile-time constant). */
  aspect?: number;
}

/**
 * The "pulse" identity: concentric rings travelling through a soft core,
 * inked between near-black blue and a hue-blended neon glow.
 */
export const pulseRings = defineModule(
  {
    name: "pulseRings",
    kind: "source",
    description: "Concentric ink rings in a soft core with a teal-to-magenta glow palette.",
    tags: ["rings", "radial", "audio-reactive", "ink"],
    example: 'pulseRings(ctx, { energy: kickEnv, hue: lfo(ctx, { periodBeats: 16 }) })',
  },
  (ctx: BuildCtx, opts: PulseRingsOpts = {}): TexNode => {
    const freq = ctx.uniformOf(opts.freq ?? 26);
    const speed = ctx.uniformOf(opts.speed ?? 3);
    const energy = ctx.uniformOf(opts.energy ?? 0.5);
    const hue = ctx.uniformOf(opts.hue ?? 0);

    // Frame-clock time, NOT TSL `time` (wall clock) — keeps fixture replays deterministic.
    const t = ctx.uniformOf(ctx.time.now);
    const p = uv().sub(vec2(0.5)).mul(vec2(opts.aspect ?? 16 / 9, 1));
    const d = length(p);
    const rings = sin(d.mul(freq).sub(t.mul(speed))).mul(0.5).add(0.5);
    const core = smoothstep(0.55, 0.0, d);
    const lit = rings.mul(core).mul(energy);

    const grainAmt = opts.grain ?? 0.1;
    const grain = grainAmt > 0 ? noise(ctx, { scale: 2.5, speed: 0.15 }) : undefined;
    const factor = grain ? lit.add(grain.color.x.mul(grainAmt)) : lit;

    const inkDark = vec3(0.02, 0.04, 0.09);
    const inkGlow = mix(vec3(0.1, 0.9, 0.85), vec3(0.95, 0.2, 0.9), hue);
    return texNode(vec4(mix(inkDark, inkGlow, factor), 1), grain ? grain.passes : []);
  },
);
