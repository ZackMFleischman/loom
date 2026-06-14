import { BuildCtx, defineModule, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import { float, mix, pow, sin, smoothstep, sqrt, uv, vec3, vec4 } from "three/tsl";
import { surfaceAspect } from "../_shared";

export interface WaffleConeOpts {
  /** Cone mouth center in uv-y (where the swirl plants) — compile-time layout. */
  topY?: number;
  /** Cone point in uv-y (the bottom tip) — compile-time layout. */
  pointY?: number;
  /** Half-width at the mouth in aspect-corrected x units. */
  width?: SignalLike;
  /** Golden cone rgb as three 0..1 SignalLikes. */
  tint?: readonly [SignalLike, SignalLike, SignalLike];
  /** Diamond cross-hatch strength (0 = plain). */
  waffle?: SignalLike;
  /** Waffle cell count around the cone. */
  cells?: SignalLike;
  /** Mouth foreshortening — ellipse vertical half as a fraction of width (0 = flat slit, ~0.3 = round bowl). */
  mouth?: SignalLike;
}

/**
 * A solid 3D waffle cone: straight tapered walls down to a point, topped by a
 * domed perspective mouth (a near lip that bulges toward the viewer, a far lip
 * arcing up behind). Barrel shading + an off-center highlight give the body
 * roundness; the diamond cross-hatch is drawn in cone-surface coords so the
 * cells converge toward the point like a real cone; the inner mouth is darkened
 * (throat shadow) under a bright near lip. Drawn UNDER a soft-serve swirl whose
 * rounded base plants at `topY` and dips into the mouth — the visible near lip
 * then reads as the cream sitting *down inside* the cone. Premultiplied alpha,
 * pure, no passes. `topY`/`width` match a `softServe`'s `baseY`/`width`.
 */
export const waffleCone = defineModule(
  {
    name: "waffleCone",
    kind: "source",
    description: "A golden solid 3D waffle cone (tapered walls, domed perspective mouth, converging diamond hatch, throat shadow) for an ice-cream swirl to sit inside.",
    tags: ["ice-cream", "cone", "waffle", "overlay", "base", "3d"],
    example: 'waffleCone(ctx, { topY: 0.42, width: 0.26, waffle: 0.6, mouth: 0.32 })',
  },
  (ctx: BuildCtx, opts: WaffleConeOpts = {}): TexNode => {
    const topY = opts.topY ?? 0.42;
    const pointY = opts.pointY ?? 0.05;
    const width = ctx.uniformOf(opts.width ?? 0.26);
    const tint = opts.tint ?? [0.82, 0.55, 0.27];
    const tintU = vec3(ctx.uniformOf(tint[0]), ctx.uniformOf(tint[1]), ctx.uniformOf(tint[2]));
    const waffle = ctx.uniformOf(opts.waffle ?? 0.6);
    const cells = ctx.uniformOf(opts.cells ?? 8);
    const mouthF = ctx.uniformOf(opts.mouth ?? 0.32);

    const x = uv().x.sub(0.5).mul(surfaceAspect());
    const y = float(1).sub(uv().y); // engine renders uv-y=0 at the top; flip so the point sits at screen bottom
    const span = float(topY - pointY);
    const cs = y.sub(pointY).div(span).clamp(0, 1); // 0 at the point, 1 at the mouth center

    const cw = width.mul(cs).max(1e-3); // straight-sided V: zero at the point, full at the mouth
    const dx = x.abs();

    // --- Perspective ellipse mouth at y = topY ---
    const mouthRy = width.mul(mouthF).max(1e-3); // foreshortened vertical half-axis
    const axx = x.div(width).clamp(-1, 1);
    const arc = mouthRy.mul(sqrt(float(1).sub(axx.mul(axx)).max(0))); // 0 at the corners, mouthRy at center
    const frontArcY = float(topY).sub(arc); // near lip dips DOWN toward the viewer at the center
    const backArcY = float(topY).add(arc); //  far lip arcs UP behind — the domed top of the solid cone
    const inMouthX = smoothstep(float(1.0), float(0.95), axx.abs());

    // --- SOLID body: the V walls, capped by the domed far rim ---
    const wallEdge = smoothstep(cw, cw.mul(0.82), dx);
    const aboveTip = smoothstep(float(pointY - 0.012), float(pointY + 0.02), y);
    const belowTop = smoothstep(backArcY.add(0.006), backArcY.sub(0.006), y); // up to the domed rim
    const cover = wallEdge.mul(aboveTip).mul(belowTop).clamp(0, 1);

    // --- Waffle cross-hatch in cone-surface coords (cells shrink toward the point => perspective) ---
    const around = x.div(cw).clamp(-1.3, 1.3);
    const along = cs;
    const g1 = sin(around.mul(cells).add(along.mul(cells.mul(0.85))).mul(Math.PI));
    const g2 = sin(around.mul(cells).sub(along.mul(cells.mul(0.85))).mul(Math.PI));
    const line = smoothstep(float(0), float(0.5), g1.abs()).min(smoothstep(float(0), float(0.5), g2.abs()));
    const hatchFade = smoothstep(float(0.04), float(0.16), cs).mul(smoothstep(float(1.0), float(0.86), cs)); // fade at the tip and inside the mouth
    const groove = mix(float(1), line, waffle.clamp(0, 1).mul(hatchFade));

    // --- 3D shading on the body ---
    const nx = dx.div(cw).clamp(0, 1);
    const round = float(1).sub(nx.mul(nx).mul(0.6)); // barrel falloff across the width
    const lobe = pow(float(1).sub(x.div(cw).add(0.32).abs()).clamp(0, 1), float(1.7)).mul(0.3); // off-center specular streak
    const depth = smoothstep(float(0), float(0.55), cs).mul(0.4).add(0.6); // darker toward the point for volume
    const dark = tintU.mul(0.45);
    let col = mix(dark, tintU, groove).mul(round.mul(0.78).add(0.22)).mul(depth).add(tintU.mul(lobe));

    // --- Mouth: throat shadow inside, bright near lip on the front rim ---
    const throat = smoothstep(float(0), float(0.13), y.sub(frontArcY)).mul(inMouthX); // 0 at the lip, darker deeper in
    col = col.mul(float(1).sub(throat.mul(0.45)));
    const lipBand = smoothstep(float(0.05), float(0), y.sub(frontArcY).abs()).mul(inMouthX); // the rounded near rim edge
    col = mix(col, tintU.mul(1.3), lipBand.mul(0.55));

    const rgb = col.mul(cover);
    return texNode(vec4(rgb, cover));
  },
);
