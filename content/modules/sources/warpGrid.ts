import { BuildCtx, defineModule, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import { cos, float, min, sin, smoothstep, uv, vec2, vec4 } from "three/tsl";
import type { Node } from "three/webgpu";
import { surfaceAspect } from "../_shared";

const TAU = Math.PI * 2;

/**
 * One point of influence another visualization pushes into the grid. Position is
 * the only required field; the rest are the physical attributes of a force on a
 * field — feed whatever your visualization knows about an entity:
 *  - `mass`   radial pull (>0 sucks the lattice in, <0 bulges it out)
 *  - `radius` how broad the dent is (surface-height units)
 *  - `swirl`  tangential curl / angular momentum (rotates the lattice around it)
 *  - `vx/vy`  linear velocity — drags the lattice along the entity's motion
 * A sprinkle, an enemy, the protagonist, a bomb — anything with a position can
 * emit one (or a list), and the grid sums them analytically. For MANY points
 * (a whole particle system), use `field` instead.
 */
export interface GridInfluence {
  /** Center in uv (0..1). */
  x: SignalLike;
  y: SignalLike;
  /** Radial pull strength ("mass"). >0 attracts the lattice, <0 repels. Default 1. */
  mass?: SignalLike;
  /** Influence radius in surface-height units — broader = gentler, wider dent. Default 0.25. */
  radius?: SignalLike;
  /** Tangential swirl (curl / angular momentum) — rotates the lattice around the point. Default 0. */
  swirl?: SignalLike;
  /** Linear velocity (uv/sec-ish) — drags the lattice along the entity's motion. Default 0. */
  vx?: SignalLike;
  vy?: SignalLike;
}

export interface WarpGridOpts {
  /** Grid density — cells across the frame height. */
  cells?: SignalLike;
  /** Line half-width in cell units (~0.02 thin, ~0.08 fat). */
  line?: SignalLike;
  /** Autonomous gravity wells that roam on their own (compile-time count). 0 = none. */
  wells?: number;
  /**
   * Scene-driven point influences — THE hook for other visualizations to bend
   * the grid. Pass a position (and optional mass/radius/swirl/velocity) per
   * entity and the lattice reacts: the ship dimples it, a bomb shocks it, an
   * enemy curls it. Array length is fixed at build (it's an unrolled sum, so
   * keep it to a handful of discrete entities — use `field` for crowds).
   */
  influences?: GridInfluence[];
  /**
   * A displacement FIELD for arbitrary / many-point visualizations: a TexNode
   * whose RG channels are a signed warp vector (0.5 = neutral) and whose B is an
   * optional glow contribution, sampled at each grid pixel. Render a particle
   * system's force/velocity/curl into this (cheaply — wrap it in `ctx.layer` so
   * it's one buffered sample) and the whole crowd warps the grid at once.
   */
  field?: TexNode;
  /** Scale on the `field` displacement + glow. Default 0.12. */
  fieldAmount?: SignalLike;
  /** Influence/well strength multiplier — how hard the grid bows. */
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

    // Scene-driven influences — the hook other visualizations push through.
    // Each adds a radial dent (mass), a tangential swirl (curl), and a drag
    // along its velocity, all falling off within its radius.
    const influences = opts.influences ?? [];
    for (let i = 0; i < influences.length; i++) {
      const inf = influences[i]!;
      const mass = ctx.uniformOf(inf.mass ?? 1);
      const radius = ctx.uniformOf(inf.radius ?? 0.25);
      const swirl = ctx.uniformOf(inf.swirl ?? 0);
      const vx = ctx.uniformOf(inf.vx ?? 0);
      const vy = ctx.uniformOf(inf.vy ?? 0);
      const w = vec2(ctx.uniformOf(inf.x).sub(0.5).mul(asp), ctx.uniformOf(inf.y).sub(0.5));
      const toW = w.sub(p); // points from the pixel toward the entity
      const r2 = radius.mul(radius).add(1e-4);
      const fall = r2.div(toW.dot(toW).add(r2)); // 1 at the center → 0 past the radius
      const k = fall.mul(warp);
      disp = disp.add(toW.mul(mass.mul(k).mul(2.4))); // radial pinch toward the entity
      disp = disp.add(vec2(toW.y.negate(), toW.x).mul(swirl.mul(k))); // curl around it
      disp = disp.add(vec2(vx, vy).mul(k)); // drag along its motion
      wellGlow = wellGlow.add(fall.mul(mass).mul(0.05));
    }

    // Displacement FIELD: RG = signed warp vector, B = glow. The escape hatch for
    // crowds — a whole particle system baked into one sampled texture.
    let fieldPasses = opts.field?.passes ?? [];
    if (opts.field) {
      const fAmt = ctx.uniformOf(opts.fieldAmount ?? 0.12);
      const fc = opts.field.color;
      disp = disp.add(fc.rg.sub(0.5).mul(2).mul(fAmt));
      wellGlow = wellGlow.add(fc.b.mul(fAmt));
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
