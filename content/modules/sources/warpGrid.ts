import { BuildCtx, defineModule, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import { cos, float, min, sin, smoothstep, uv, vec2, vec4 } from "three/tsl";
import type { Node } from "three/webgpu";
import { surfaceAspect } from "../_shared";

const TAU = Math.PI * 2;

export interface WarpGridOpts {
  /** Grid density — cells across the frame height. */
  cells?: SignalLike;
  /** Line half-width in cell units (~0.02 thin, ~0.08 fat). */
  line?: SignalLike;
  /** Autonomous gravity wells that roam on their own (compile-time count). 0 = none. */
  wells?: number;
  /**
   * Wells PINNED to scene-driven points (uv 0..1) — this is how another module
   * reaches into the grid: pass the protagonist's position so the lattice dimples
   * around it and follows it, and pulse `strength` with a kick so detonations
   * punch a shock through the grid. The array length is fixed at build.
   */
  anchors?: { x: SignalLike; y: SignalLike; strength?: SignalLike }[];
  /** Well pull strength — how hard the grid bows toward each well. */
  warp?: SignalLike;
  /** Well wander speed — the wells drift, so the warp breathes. */
  drift?: SignalLike;
  /** Brightness drive (~0..2) — feed kick/bass so the whole grid pulses. */
  energy?: SignalLike;
  /** Soft halo bleed around the lines (before any bloom). */
  glow?: SignalLike;
  /** Line palette stop (0..4). Default 1 (edge). */
  lineStop?: number;
  /** Background tint palette stop (0..4). Default 0 (bg). */
  bgStop?: number;
  /** Well-core glow palette stop (0..4). Default 4 (accent). */
  wellStop?: number;
}

/** Deterministic per-well pseudo-random in [0,1) — stable across rebuilds. */
const rand = (i: number, k: number) => {
  const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/**
 * The signature twin-stick arcade backdrop: a neon line grid bent by a handful
 * of roaming gravity wells (each well sucks the lattice inward, so the grid
 * bows and the lines bunch up like Geometry Wars). Opaque — it's the stage the
 * rest of the scene plays on. Frame-clocked, so fixture replays are identical.
 */
export const warpGrid = defineModule(
  {
    name: "warpGrid",
    kind: "source",
    description:
      "A neon line grid bent by gravity wells — roaming ones plus scene-pinned anchor wells (dent it around the protagonist, shock it on a kick); pulses on an energy signal, retints through the palette.",
    tags: ["grid", "arcade", "geometry-wars", "neon", "base", "audio-reactive"],
    example: 'warpGrid(ctx, { cells: 15, warp: 0.18, wells: 3, energy: ctx.input("kick") })',
  },
  (ctx: BuildCtx, opts: WarpGridOpts = {}): TexNode => {
    const cells = ctx.uniformOf(opts.cells ?? 15);
    const line = ctx.uniformOf(opts.line ?? 0.04);
    const warp = ctx.uniformOf(opts.warp ?? 0.18);
    const drift = ctx.uniformOf(opts.drift ?? 0.35);
    const energy = ctx.uniformOf(opts.energy ?? 0.5);
    const glow = ctx.uniformOf(opts.glow ?? 0.5);
    const wells = Math.max(0, Math.round(opts.wells ?? 3));
    const lineStop = Math.max(0, Math.min(4, Math.round(opts.lineStop ?? 1)));
    const bgStop = Math.max(0, Math.min(4, Math.round(opts.bgStop ?? 0)));
    const wellStop = Math.max(0, Math.min(4, Math.round(opts.wellStop ?? 4)));

    // Frame-clock time, NOT TSL `time` (wall clock) — keeps fixture replays deterministic.
    const now = ctx.uniformOf(ctx.time.now);
    const asp = surfaceAspect();
    const p = uv().sub(0.5).mul(vec2(asp, 1)); // centered, square cells (x in ±asp/2, y in ±0.5)

    // Sum each well's pull into a displacement, and accumulate a core glow blob.
    let disp: Node<"vec2"> = vec2(0, 0);
    let wellGlow: Node<"float"> = float(0);
    for (let i = 0; i < wells; i++) {
      const sp = 0.22 + rand(i, 1) * 0.55;
      const w = vec2(
        sin(now.mul(drift).mul(sp).add(rand(i, 2) * TAU)).mul(asp.mul(0.42)),
        cos(now.mul(drift).mul(sp * 0.83).add(rand(i, 3) * TAU)).mul(0.4),
      );
      const toW = w.sub(p);
      const dist2 = toW.dot(toW).add(0.02);
      const pull = warp.div(dist2.mul(4).add(0.5)); // bounded near the core, no blow-up
      disp = disp.add(toW.mul(pull));
      wellGlow = wellGlow.add(float(0.006).div(dist2));
    }

    // Anchor wells the scene pins to live points (e.g. the ship) — same physics,
    // but the position and strength come from outside, so the grid reacts to
    // whatever the scene wires in (protagonist position, bomb shockwave, …).
    const anchors = opts.anchors ?? [];
    for (let i = 0; i < anchors.length; i++) {
      const an = anchors[i]!;
      const ax = ctx.uniformOf(an.x);
      const ay = ctx.uniformOf(an.y);
      const aStr = ctx.uniformOf(an.strength ?? 1);
      const w = vec2(ax.sub(0.5).mul(asp), ay.sub(0.5)); // uv → centered aspect space
      const toW = w.sub(p);
      const dist2 = toW.dot(toW).add(0.02);
      const pull = warp.mul(aStr).div(dist2.mul(4).add(0.5));
      disp = disp.add(toW.mul(pull));
      wellGlow = wellGlow.add(float(0.01).div(dist2).mul(aStr));
    }

    // Lattice on the warped coordinate; distance to the nearest gridline per axis.
    const g = p.add(disp).mul(cells);
    const dl = vec2(0.5, 0.5).sub(g.fract().sub(0.5).abs());
    const lineDist = min(dl.x, dl.y);

    const lw = line.max(0.004);
    const core = smoothstep(lw, float(0), lineDist);
    const halo = smoothstep(lw.mul(5).add(glow.mul(0.14)), float(0), lineDist).mul(0.45);
    const lit = core.add(halo).mul(energy.mul(0.5).add(0.6));

    const bg = ctx.palette.color(bgStop).mul(0.12);
    const lineCol = ctx.palette.color(lineStop);
    const wellCol = ctx.palette.color(wellStop);
    const rgb = bg
      .add(lineCol.mul(lit))
      .add(wellCol.mul(wellGlow).mul(energy.mul(0.5).add(0.6)));
    return texNode(vec4(rgb, 1));
  },
);
