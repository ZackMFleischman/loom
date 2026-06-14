import { BuildCtx, defineModule, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import { cos, float, length, max, mix, select, sin, smoothstep, uv, vec2, vec3, vec4 } from "three/tsl";
import type { Node } from "three/webgpu";
import { gearSdf, neonStroke, polygonSdf, surfaceAspect } from "../_shared";

const TAU = Math.PI * 2;

export interface EnemySwarmOpts {
  /** Hard ceiling on enemies baked into the shader (compile-time constant). Default 24. */
  maxCount?: number;
  /** How many enemies are actually visible (SignalLike, clamped to maxCount). Autonomous mode only. */
  count?: SignalLike;
  /**
   * Drive enemies from scene-supplied positions (uv 0..1) instead of the internal
   * spawn spiral — one source of truth for an external sim/AI (so the protagonist
   * can avoid and shoot the very same enemies). Array length sets the count;
   * `phase` 0..1 fades a spawning/dying enemy (default 1 = full).
   */
  positions?: { x: SignalLike; y: SignalLike; phase?: SignalLike }[];
  /** Enemy silhouette: regular polygon ("poly"), spiky "star", or "ring". */
  shape?: "poly" | "star" | "ring";
  /** Polygon side count (poly): 3 = dart, 4 = diamond, 6 = hex-mine. */
  sides?: number;
  /** Star points / gear teeth (star). */
  points?: number;
  /** Star spike depth 0..1 (star only). */
  spike?: SignalLike;
  /** Enemy half-size in surface-height units. */
  size?: SignalLike;
  /** Inward march speed — cycles/sec of the spawn→center approach. */
  speed?: SignalLike;
  /** Tangential swirl: radians of curl over the approach (they spiral in). */
  swirl?: SignalLike;
  /** Per-enemy self-spin rate (radians/sec). */
  spin?: SignalLike;
  /** Surge multiplier on the march (feed kick so a wave lurches inward on the beat). */
  surge?: SignalLike;
  /** Convergence target in uv (default center 0.5,0.5) — aim it at the protagonist. */
  targetX?: SignalLike;
  targetY?: SignalLike;
  /** Spawn-rim radius in surface-height units (where enemies appear). */
  rim?: SignalLike;
  /** Body palette stop (0..4). Default 3 (core). */
  colorStop?: number;
  /** Per-enemy hue scatter toward the accent stop, 0 = uniform, 1 = full mix. */
  hueSpread?: number;
  /** Neon stroke half-width in surface-height units. */
  thickness?: SignalLike;
  /** Overall brightness. */
  brightness?: SignalLike;
}

/** Deterministic per-enemy pseudo-random in [0,1) — stable across rebuilds. */
const rand = (i: number, k: number) => {
  const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/**
 * Waves of glowing geometric enemies that spawn at the rim and spiral inward
 * toward a target (the protagonist), self-spinning and fading as they close in
 * and "die" at the center. Swap `shape`/`sides`/`points` to reskin the wave;
 * ride `count` for wave size and feed `surge` a kick so the swarm lurches on the
 * beat. Premultiplied alpha for over+bloom. Frame-clocked & deterministic.
 */
export const enemySwarm = defineModule(
  {
    name: "enemySwarm",
    kind: "source",
    description:
      "Waves of glowing geometric enemies spiralling inward toward a target and dying at the center (swappable shape); premultiplied for over+bloom.",
    tags: ["arcade", "geometry-wars", "neon", "vector", "particles", "overlay", "audio-reactive"],
    example: 'enemySwarm(ctx, { shape: "star", points: 4, count: 18, surge: ctx.input("kick") })',
  },
  (ctx: BuildCtx, opts: EnemySwarmOpts = {}): TexNode => {
    const maxCount = opts.maxCount ?? 24;
    const kind = opts.shape ?? "star";
    const sides = Math.max(3, Math.round(opts.sides ?? 4));
    const points = Math.max(3, Math.round(opts.points ?? 4));
    const hueSpread = opts.hueSpread ?? 0.7;
    const colorStop = Math.max(0, Math.min(4, Math.round(opts.colorStop ?? 3)));

    const countU = ctx.uniformOf(opts.count ?? maxCount);
    const size = ctx.uniformOf(opts.size ?? 0.07);
    const speed = ctx.uniformOf(opts.speed ?? 0.18);
    const swirl = ctx.uniformOf(opts.swirl ?? 2.2);
    const spin = ctx.uniformOf(opts.spin ?? 0.6);
    const surge = ctx.uniformOf(opts.surge ?? 1);
    const spike = ctx.uniformOf(opts.spike ?? 0.6);
    const thickness = ctx.uniformOf(opts.thickness ?? 0.016);
    const bright = ctx.uniformOf(opts.brightness ?? 1);
    const rim = ctx.uniformOf(opts.rim ?? 0.62);
    const tx = ctx.uniformOf(opts.targetX ?? 0.5);
    const ty = ctx.uniformOf(opts.targetY ?? 0.5);

    // Frame-clock time, NOT TSL `time` (wall clock) — keeps fixture replays deterministic.
    const now = ctx.uniformOf(ctx.time.now);
    const march = now.mul(speed).mul(surge);
    const asp = surfaceAspect();
    const center = uv().sub(0.5).mul(vec2(asp, 1));
    const target = vec2(tx.sub(0.5).mul(asp), ty.sub(0.5));

    let acc: Node<"vec3"> = vec3(0);
    let alpha: Node<"float"> = float(0);

    // Draw one self-spinning enemy at `pos` (centered aspect space), faded by `life`.
    const drawEnemy = (pos: Node<"vec2">, life: Node<"float">, i: number, dir: number) => {
      const local = center.sub(pos);
      const rotI = now.mul(spin).mul(0.6 + rand(i, 5) * 0.9).mul(dir).add(rand(i, 6) * TAU);
      const cr = cos(rotI);
      const sr = sin(rotI);
      const lp = vec2(cr.mul(local.x).add(sr.mul(local.y)), cr.mul(local.y).sub(sr.mul(local.x)));

      const er = size.mul(0.7 + rand(i, 7) * 0.7);
      let sdf;
      if (kind === "ring") sdf = length(lp).sub(er);
      else if (kind === "star") sdf = gearSdf(lp, points, er, spike);
      else sdf = polygonSdf(lp, sides, er);

      const col = mix(ctx.palette.color(colorStop), ctx.palette.color(4), rand(i, 8) * hueSpread);
      const stroke = neonStroke(sdf, thickness, col);
      acc = acc.add(stroke.rgb.mul(life));
      alpha = max(alpha, stroke.a.mul(life));
    };

    const positions = opts.positions;
    if (positions && positions.length) {
      // Scene-driven mode: render an enemy at each supplied position — one source
      // of truth shared with an external sim / AI (which also fires at them).
      for (let i = 0; i < positions.length; i++) {
        const ps = positions[i]!;
        const px = ctx.uniformOf(ps.x);
        const py = ctx.uniformOf(ps.y);
        const pos = vec2(px.sub(0.5).mul(asp), py.sub(0.5));
        const life = ctx.uniformOf(ps.phase ?? 1).clamp(0, 1);
        drawEnemy(pos, life, i, rand(i, 4) < 0.5 ? -1 : 1);
      }
    } else {
      // Autonomous mode: enemies spawn at the rim and spiral inward to the target.
      for (let i = 0; i < maxCount; i++) {
        const ang0 = rand(i, 1) * TAU;
        const rate = 0.5 + rand(i, 2) * 0.8;
        const off = rand(i, 3);
        const dir = rand(i, 4) < 0.5 ? -1 : 1;

        const ph = march.mul(rate).add(off).fract(); // 0 at rim → 1 at target
        const ang = float(ang0).add(swirl.mul(ph).mul(dir));
        const radius = rim.mul(ph.oneMinus());
        const pos = target.add(vec2(cos(ang), sin(ang)).mul(radius));

        // Fade in at spawn, flare-and-die at the target; gate by the live count.
        const fade = smoothstep(float(0), float(0.07), ph).mul(smoothstep(float(1), float(0.74), ph));
        const vis = select(float(i).lessThan(countU), fade, float(0));
        drawEnemy(pos, vis, i, dir);
      }
    }

    return texNode(vec4(acc.mul(bright), alpha.clamp(0, 1)));
  },
);
