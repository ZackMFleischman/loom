import { BuildCtx, defineModule, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import { cos, float, length, max, sin, uv, vec2, vec3, vec4 } from "three/tsl";
import type { Node } from "three/webgpu";
import { surfaceAspect } from "../_shared";

export interface BulletsOpts {
  /**
   * The projectiles (uv 0..1). `angle` orients the streak along the shot's
   * heading (radians); `life` 0..1 fades it out (0 = spent / off-screen). Drive
   * these from a scene sim — the same source of truth the shooter aims with.
   */
  shots?: { x: SignalLike; y: SignalLike; angle?: SignalLike; life?: SignalLike }[];
  /** Streak half-length in surface-height units. */
  length?: SignalLike;
  /** Streak half-width (the glowing core thickness). */
  width?: SignalLike;
  /** Body palette stop (0..4). Default 4 (accent). */
  colorStop?: number;
  /** Overall brightness. */
  brightness?: SignalLike;
}

/**
 * Glowing neon tracer rounds: a set of capsule streaks placed and oriented by
 * the scene (position + heading + life per shot), with white-hot cores.
 * Premultiplied alpha for over+bloom. It draws nothing on its own — it's the
 * projectile layer for a shooter, fed by whatever fires (the protagonist's AI),
 * and just as reusable for any "streaks flying from A toward B" look.
 */
export const bullets = defineModule(
  {
    name: "bullets",
    kind: "source",
    description:
      "Glowing neon tracer streaks placed/oriented per shot by the scene (position, heading, life) — the projectile layer for a shooter; premultiplied for over+bloom.",
    tags: ["arcade", "geometry-wars", "neon", "bullets", "projectiles", "overlay"],
    example: 'bullets(ctx, { shots: [{ x: 0.5, y: 0.5, angle: 0, life: 1 }], length: 0.06 })',
  },
  (ctx: BuildCtx, opts: BulletsOpts = {}): TexNode => {
    const shots = opts.shots ?? [];
    const half = ctx.uniformOf(opts.length ?? 0.06);
    const width = ctx.uniformOf(opts.width ?? 0.01);
    const bright = ctx.uniformOf(opts.brightness ?? 1);
    const colorStop = Math.max(0, Math.min(4, Math.round(opts.colorStop ?? 4)));

    const asp = surfaceAspect();
    const p = uv().sub(0.5).mul(vec2(asp, 1));
    const col = ctx.palette.color(colorStop);

    let acc: Node<"vec3"> = vec3(0);
    let alpha: Node<"float"> = float(0);
    for (let i = 0; i < shots.length; i++) {
      const s = shots[i]!;
      const pos = vec2(ctx.uniformOf(s.x).sub(0.5).mul(asp), ctx.uniformOf(s.y).sub(0.5));
      const ang = ctx.uniformOf(s.angle ?? 0);
      const life = ctx.uniformOf(s.life ?? 1).clamp(0, 1);

      // Into shot-local space: rotate by −angle so the streak lies along +x.
      const d = p.sub(pos);
      const ca = cos(ang);
      const sa = sin(ang);
      const local = vec2(ca.mul(d.x).add(sa.mul(d.y)), ca.mul(d.y).sub(sa.mul(d.x)));

      // Distance to the capsule's spine (a segment of half-length `half`).
      const dist = length(vec2(local.x.abs().sub(half).max(0), local.y));
      const w = width.max(1e-4);
      const fall = w.div(dist.add(w));
      const tube = fall.mul(fall);
      const core = fall.pow(8); // white-hot tracer core
      acc = acc.add(col.mul(tube).add(vec3(core)).mul(life));
      alpha = max(alpha, tube.add(core).mul(life));
    }

    return texNode(vec4(acc.mul(bright), alpha.clamp(0, 1)));
  },
);
