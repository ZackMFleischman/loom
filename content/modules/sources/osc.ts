import { BuildCtx, defineModule, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import { cos, uv, vec3, vec4 } from "three/tsl";

const TAU = Math.PI * 2;

export interface OscOpts {
  /** Stripe count across the screen. */
  freq?: SignalLike;
  /** Scroll speed (cycles/sec). */
  sync?: SignalLike;
  /** Per-channel phase offset — 0 is monochrome, ~0.1 gets RGB fringes. */
  offset?: SignalLike;
}

/** Hydra-style oscillator stripes. */
export const osc = defineModule(
  {
    name: "osc",
    kind: "source",
    description: "Scrolling sinusoidal stripes with optional RGB phase offset.",
    tags: ["pattern", "stripes", "classic"],
    example: 'osc(ctx, { freq: 10, sync: 0.25, offset: 0.1 })',
  },
  (ctx: BuildCtx, opts: OscOpts = {}): TexNode => {
    const freq = ctx.uniformOf(opts.freq ?? 8);
    const sync = ctx.uniformOf(opts.sync ?? 0.25);
    const offset = ctx.uniformOf(opts.offset ?? 0.1);
    // Frame-clock time, NOT TSL `time` (wall clock) — keeps fixture replays deterministic.
    const t = ctx.uniformOf(ctx.time.now);
    const phase = uv().x.mul(freq).add(t.mul(sync));
    const r = cos(phase.mul(TAU)).mul(0.5).add(0.5);
    const g = cos(phase.add(offset).mul(TAU)).mul(0.5).add(0.5);
    const b = cos(phase.add(offset.mul(2)).mul(TAU)).mul(0.5).add(0.5);
    return texNode(vec4(vec3(r, g, b), 1));
  },
);
