import { BuildCtx, defineModule, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import { abs, clamp, float, min, mix, sin, smoothstep, uv, vec3, vec4 } from "three/tsl";
import { surfaceAspect } from "../_shared";

export interface WaffleConeOpts {
  /** Cone mouth in uv-y (meets the swirl base) — compile-time layout. */
  topY?: number;
  /** Cone point in uv-y (the bottom tip) — compile-time layout. */
  pointY?: number;
  /** Half-width at the mouth in aspect-corrected x units. */
  width?: SignalLike;
  /** Golden cone rgb as three 0..1 SignalLikes. */
  tint?: readonly [SignalLike, SignalLike, SignalLike];
  /** Diamond cross-hatch strength (0 = plain). */
  waffle?: SignalLike;
  /** Waffle cell count along the cone. */
  cells?: SignalLike;
}

/**
 * A downward waffle cone: a V tapering from a mouth to a point, scored with a
 * golden diamond cross-hatch and a darker rim lip, rounded with edge shading.
 * Premultiplied alpha so a soft-serve swirl sits on top via `over`. Pure, no
 * passes. Its `topY`/`width` are meant to match a `softServe`'s `baseY`/`width`
 * so the cream plants cleanly in the cone mouth.
 */
export const wafffleCone = defineModule(
  {
    name: "wafffleCone",
    kind: "source",
    description: "A golden waffle cone (downward V with a diamond cross-hatch and rim lip) for an ice-cream swirl to sit in.",
    tags: ["ice-cream", "cone", "waffle", "overlay", "base"],
    example: 'wafffleCone(ctx, { topY: 0.34, width: 0.26, waffle: 0.6 })',
  },
  (ctx: BuildCtx, opts: WaffleConeOpts = {}): TexNode => {
    const topY = opts.topY ?? 0.34;
    const pointY = opts.pointY ?? 0.03;
    const width = ctx.uniformOf(opts.width ?? 0.26);
    const tint = opts.tint ?? [0.82, 0.55, 0.27];
    const tintU = vec3(ctx.uniformOf(tint[0]), ctx.uniformOf(tint[1]), ctx.uniformOf(tint[2]));
    const waffle = ctx.uniformOf(opts.waffle ?? 0.6);
    const cells = ctx.uniformOf(opts.cells ?? 8);

    const x = uv().x.sub(0.5).mul(surfaceAspect());
    const y = uv().y;
    const span = float(topY - pointY);
    const cs = clamp(y.sub(pointY).div(span), 0, 1); // 0 at point, 1 at mouth

    const cw = width.mul(cs).max(1e-3); // V: zero at the point, full at the mouth
    const dx = abs(x);
    const inY = smoothstep(float(-0.02), float(0.03), y.sub(pointY))
      .mul(smoothstep(float(0.03), float(-0.005), y.sub(topY)));
    const body = smoothstep(cw, cw.mul(0.8), dx).mul(inY);

    // Diamond cross-hatch: two diagonal sine sets, dark grooves where either zero-crosses.
    const f = cells;
    const g1 = sin(x.add(y).mul(f).mul(6.2832));
    const g2 = sin(x.sub(y).mul(f).mul(6.2832));
    const line = min(smoothstep(float(0), float(0.4), abs(g1)), smoothstep(float(0), float(0.4), abs(g2)));
    const groove = mix(float(1), line, waffle.clamp(0, 1));

    const nx = clamp(dx.div(cw), 0, 1);
    const round = float(1).sub(nx.mul(nx).mul(0.55)); // barrel shading toward the edges
    const dark = tintU.mul(0.5);
    const col = mix(dark, tintU, groove).mul(round.mul(0.85).add(0.15));
    // Darker lip right at the mouth where the cream overhangs.
    const lip = float(1).sub(smoothstep(float(0), float(0.05), abs(y.sub(topY)))).mul(0.35);
    const rgb = col.mul(float(1).sub(lip));

    return texNode(vec4(rgb.mul(body), body));
  },
);
