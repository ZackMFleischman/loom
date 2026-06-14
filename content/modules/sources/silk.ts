import { BuildCtx, defineModule, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import { cos, float, Fn, sin, uniform, vec2, vec3, vec4 } from "three/tsl";
import type { Node } from "three/webgpu";
import { additiveDeposit, fbm2, particleState } from "../_shared";

export type SilkField = "curl" | "attractor";

export interface SilkOpts {
  /** Particle count (compile-time; packed into a √count² state texture). 4k..1M-ish. */
  count?: number;
  /** Force field: curl-of-fbm flow ("curl", silky streams) or a de Jong strange attractor ("attractor"). */
  field?: SilkField;
  /** Force/advection strength per frame — wire ctx.input("bass") to surge the flow (0.1..3). */
  force?: SignalLike;
  /** Spatial frequency of the curl/attractor field — bigger = tighter filigree. Wire ctx.input("kick") for breathing scale (0.5..6). */
  curlScale?: SignalLike;
  /** Slow self-evolution of the field (frame-clocked drift) so the silk never settles (0..0.5). */
  evolve?: SignalLike;
  /** Fraction of particles respawned each frame — keeps streams flowing / prevents pile-up (0..0.08). */
  churn?: SignalLike;
  /** Density carried frame-to-frame in the additive buffer — paints glowing trails (0..0.97). */
  persistence?: SignalLike;
  /** Tone-map exposure of the accumulated density (brightness of the silk) (0.3..6). */
  exposure?: SignalLike;
  /** Per-splat brightness — how much each particle adds to the density each frame (0.02..0.4). */
  glow?: SignalLike;
  /** Point sprite size in pixels (1..3 — small keeps it filamentary). */
  size?: number;
  /** Rising past 0.5 re-scatters every particle (a trigger). */
  reseed?: SignalLike;
  /** Sim seed — deterministic so fixture replays are byte-identical. */
  seed?: number;
}

/** Accumulation buffer grid — fixed, 16:9, modest so a million splats stay in budget. */
const ACC_W = 1280;
const ACC_H = 720;
const TWO_PI = 6.2831853;

/**
 * "Silk": a true GPU particle pool (positions/velocities in a ping-ponged
 * HalfFloat texture, advanced each frame by a force field) splatted ADDITIVELY
 * into a float buffer and tone-mapped → the glowing million-point smoke-of-points
 * look. Two fields: `curl` rides the curl of fbm-noise (divergence-free → silky,
 * never-clumping streams) and `attractor` pulls toward a de Jong strange
 * attractor (folded filigree sheets). Audio drives the force strength and the
 * curl scale (kick/bass), so the whole cloth surges and breathes on the beat.
 * Frame-clocked + in-shader-seeded → fixture replays are byte-identical.
 * Stateful like `feedback` (NFR-5 re-seeds it on a code change).
 *
 * Output: the tone-mapped density in rgb — colorize in the scene through the
 * palette ramp. Reads non-black on its own.
 */
export const silk = defineModule(
  {
    name: "silk",
    kind: "source",
    description: "A million GPU particles riding curl-noise or a strange attractor, drawn additively → glowing silk/smoke-of-points.",
    tags: ["particles", "silk", "flow", "curl", "attractor", "additive", "simulation", "audio-reactive", "generative", "gpu"],
    example: 'silk(ctx, { count: 250000, field: "curl", force: ctx.input("bass"), curlScale: ctx.input("kick") })',
  },
  (ctx: BuildCtx, opts: SilkOpts = {}): TexNode => {
    const fieldKind = opts.field ?? "curl";
    const forceU = ctx.uniformOf(opts.force ?? 1);
    const scaleU = ctx.uniformOf(opts.curlScale ?? 2);
    const evolveU = ctx.uniformOf(opts.evolve ?? 0.12);
    const churnU = ctx.uniformOf(opts.churn ?? 0.02);
    const phaseDrift = uniform(0); // accumulated field-drift phase (frame-clocked)

    type FNode = Node<"float">;
    const scl = scaleU as unknown as FNode;
    const drift = phaseDrift as unknown as FNode;

    // Curl of fbm-noise: ∂ψ/∂y , -∂ψ/∂x via finite differences → divergence-free.
    // fbm differences over a small epsilon are tiny, so we scale the result up to a
    // usable per-frame velocity (positions live in 0..1 screen space).
    const curlVel = Fn(([px, py]: [FNode, FNode]) => {
      const e = float(0.002);
      const base = vec2(px.mul(scl).add(drift), py.mul(scl).sub(drift));
      const n1 = fbm2(base.add(vec2(0, e)), 4);
      const n2 = fbm2(base.sub(vec2(0, e)), 4);
      const n3 = fbm2(base.add(vec2(e, 0)), 4);
      const n4 = fbm2(base.sub(vec2(e, 0)), 4);
      const vx = n1.sub(n2).div(e.mul(2)); // ∂ψ/∂y
      const vy = n4.sub(n3).div(e.mul(2)); // -∂ψ/∂x
      return vec2(vx, vy);
    });

    // de Jong attractor velocity: pull toward map(p) - p, in centered coords.
    const attractorVel = Fn(([px, py]: [FNode, FNode]) => {
      const cx = px.sub(0.5).mul(4); // -2..2 working space
      const cy = py.sub(0.5).mul(4);
      const a = float(1.641).add(drift.mul(0.3));
      const b = float(1.902);
      const c = float(0.316).add(scl.mul(0.02));
      const d = float(1.525);
      const nx = sin(a.mul(cy)).sub(cos(b.mul(cx)));
      const ny = sin(c.mul(cx)).sub(cos(d.mul(cy)));
      return vec2(nx.sub(cx), ny.sub(cy)).mul(0.25); // toward the mapped point
    });

    const vel = (px: FNode, py: FNode): Node<"vec2"> =>
      fieldKind === "attractor" ? attractorVel(px, py) : curlVel(px, py);

    const pool = particleState(ctx, {
      count: opts.count ?? 250_000,
      seed: opts.seed ?? 0x51c,
      reseed: opts.reseed ?? 0,
      // State rgba = (posX, posY in 0..1 screen space, vx, vy).
      // Spawn on a ring of phases so the initial cloud already fills the frame.
      spawn: ({ rand }) => vec4(rand(1), rand(2), float(0), float(0)),
      respawn: ({ rand }) => {
        // A churn fraction respawns each frame (phase-keyed → rotates through the pool),
        // recycling stragglers so the streams keep flowing instead of piling up.
        const r = rand(7);
        return r.lessThan(churnU as unknown as FNode).select(float(1), float(0)) as FNode;
      },
      update: ({ self }) => {
        const px = self.x;
        const py = self.y;
        const v = vel(px, py);
        // Per-frame step (0..1 space). 0.0009 keeps a unit-velocity particle to
        // ~1px/frame on a 1280-wide buffer; force scales it for the surge.
        const step = v.mul((forceU as unknown as FNode).mul(0.0009));
        const np = vec2(px, py).add(step);
        // Toroidal wrap in 0..1 (add 1 before fract so small negatives wrap right).
        const nx = np.x.add(1).fract();
        const ny = np.y.add(1).fract();
        return vec4(nx, ny, v.x, v.y) as Node<"vec4">;
      },
    });

    const glowU = ctx.uniformOf(opts.glow ?? 0.14);
    const dep = additiveDeposit(ctx, {
      particles: pool,
      width: ACC_W,
      height: ACC_H,
      size: opts.size ?? 1,
      exposure: opts.exposure ?? 1.4,
      persistence: opts.persistence ?? 0.82,
      positionUv: ({ state }) => vec2(state.x, state.y),
      // Per-splat deposit tinted faintly by speed (fast streams read hotter); kept
      // near-white so the scene palette does the coloring. Density builds the look.
      color: ({ state }) => {
        const g = glowU as unknown as FNode;
        const spd = vec2(state.z, state.w).length().clamp(0, 1);
        const tint = vec3(0.7, 0.8, 1.0).add(vec3(0.3, 0.2, 0).mul(spd));
        return tint.mul(g) as Node<"vec3">;
      },
    });

    // Frame-clocked field drift — never TSL `time`, so fixture replays match.
    ctx.updaters.push((fr) => {
      const ev = (evolveU.value as number) ?? 0;
      phaseDrift.value = ((phaseDrift.value as number) + ev * Math.min(fr.dt, 0.05)) % TWO_PI;
    });

    return texNode(dep.color, [pool.pass, dep.pass]);
  },
);
