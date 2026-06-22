import { BuildCtx, defineModule, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import { clamp, cos, float, length, max, mix, pow, sin, uv, vec2, vec3, vec4 } from "three/tsl";
import type { Node } from "three/webgpu";
import { glowDot, surfaceAspect, valueNoise2 } from "../_shared";

export interface PoiHeadsOpts {
  /** The glowing orb centers, in centered height units (feed `poiMotion().heads`). */
  heads: { x: SignalLike; y: SignalLike }[];
  /** Optional string anchors — one per head — to draw the tether from hand to orb. */
  hands?: { x: SignalLike; y: SignalLike }[];
  /** Optional spinner body center (a faint pivot glow). */
  pivot?: { x: SignalLike; y: SignalLike };
  /** Orb radius (height units). */
  size?: SignalLike;
  /** Tether thickness (0 = no visible string). */
  tether?: SignalLike;
  /** Overall brightness. */
  glow?: SignalLike;
  /** Look: 0 = glow poi, 1 = fire poi (warm + flicker), 2 = sparkler (white-hot crackle). */
  mode?: SignalLike;
  /** Sparkle density for the sparkler look. */
  spark?: SignalLike;
  /** Faint spinner-body glow at the pivot (0..1). */
  spinner?: SignalLike;
  /** Palette stops cycled across the heads (default [2, 4] — the two cores/accent). */
  colorStops?: number[];
  /**
   * Which parts to draw: "all" (default), "heads" (just the glowing orbs +
   * sparkle), or "rig" (just the strings + pivot). Split a scene into a
   * heads-only pass it can trail and a fresh rig pass so only the orbs smear.
   */
  parts?: "all" | "heads" | "rig";
}

/** Premultiplied capsule glow between two points (the string). */
function tetherGlow(
  p: Node<"vec2">,
  a: Node<"vec2">,
  b: Node<"vec2">,
  width: Node<"float">,
  color: Node<"vec3">,
): { rgb: Node<"vec3">; a: Node<"float"> } {
  const pa = p.sub(a);
  const ba = b.sub(a);
  const h = clamp(pa.dot(ba).div(ba.dot(ba).add(1e-5)), 0, 1);
  const dist = length(pa.sub(ba.mul(h)));
  const w = width.max(1e-4);
  const fall = w.div(dist.add(w));
  const tube = fall.mul(fall);
  return { rgb: color.mul(tube), a: tube };
}

/**
 * Two (or more) glowing tethered orbs placed by the scene — the visual atom of
 * a poi spinner. Each head is a soft glow with a white-hot core; an optional
 * string runs from its hand anchor, and a `mode` morphs the look from clean
 * glow poi → flickering fire poi → crackling sparkler. Premultiplied alpha, so
 * it `over`-composites and adds straight into a `bloom`. It draws nothing on its
 * own — the motion lives in `poiMotion`; this is just the light.
 */
export const poiHeads = defineModule(
  {
    name: "poiHeads",
    kind: "source",
    description:
      "Glowing tethered orbs (poi heads) placed by the scene — clean glow / flickering fire / crackling sparkler looks, with strings and a pivot; premultiplied for over+bloom.",
    tags: ["poi", "glow", "orbs", "trails", "overlay", "premultiplied"],
    example: 'poiHeads(ctx, { heads: motion.heads, hands: motion.hands, mode: 1 })',
  },
  (ctx: BuildCtx, opts: PoiHeadsOpts): TexNode => {
    const heads = opts.heads ?? [];
    const hands = opts.hands ?? [];
    const stops = opts.colorStops && opts.colorStops.length > 0 ? opts.colorStops : [2, 4];
    const size = ctx.uniformOf(opts.size ?? 0.05);
    const tetherW = ctx.uniformOf(opts.tether ?? 0.012);
    const glow = ctx.uniformOf(opts.glow ?? 1);
    const mode = ctx.uniformOf(opts.mode ?? 0);
    const sparkAmt = ctx.uniformOf(opts.spark ?? 1);
    const spinnerAmt = ctx.uniformOf(opts.spinner ?? 0);
    const tNow = ctx.uniformOf(ctx.time.now);
    const parts = opts.parts ?? "all";
    const drawHeads = parts !== "rig";
    const drawRig = parts !== "heads";

    const asp = surfaceAspect();
    const p = uv().sub(0.5).mul(vec2(asp, 1));

    // Mode blend weights: fire fades in over 0..1, sparkler over 1..2.
    const warm = clamp(mode, 0, 1);
    const sparkW = clamp(mode.sub(1), 0, 1);

    let acc: Node<"vec3"> = vec3(0);
    let alpha: Node<"float"> = float(0);

    for (let i = 0; i < heads.length; i++) {
      const head = heads[i]!;
      const pos = vec2(ctx.uniformOf(head.x), ctx.uniformOf(head.y));
      const baseCol = ctx.palette.color(stops[i % stops.length]!);

      // glow → fire (warm orange) → sparkler (gold-white).
      let col: Node<"vec3"> = baseCol;
      col = mix(col, mix(baseCol, vec3(1.0, 0.5, 0.12), float(0.7)), warm);
      col = mix(col, vec3(1.0, 0.86, 0.55), sparkW.mul(0.7));

      // Fire flickers; sparkler stays hot. Irregular product-of-sines flicker.
      const fl = sin(tNow.mul(21).add(float(i * 2.1))).mul(sin(tNow.mul(6.3).add(float(i))));
      const flicker = mix(float(1), float(0.7).add(fl.mul(0.3)), warm);

      // The string (rig).
      if (drawRig && hands[i]) {
        const hand = vec2(ctx.uniformOf(hands[i]!.x), ctx.uniformOf(hands[i]!.y));
        const tg = tetherGlow(p, hand, pos, tetherW, col);
        acc = acc.add(tg.rgb.mul(glow).mul(0.6));
        alpha = max(alpha, tg.a.mul(0.6));
      }

      if (drawHeads) {
        // The orb.
        const d = length(p.sub(pos));
        const orb = glowDot(d, size, col).mul(flicker).mul(glow);
        acc = acc.add(orb.rgb);
        alpha = max(alpha, orb.a);

        // Sparkler crackle near the head.
        const noise = valueNoise2(p.mul(40).add(vec2(tNow.mul(3.1), tNow.mul(-2.3))));
        const crackle = pow(noise, float(6)).mul(9);
        const gate = size.mul(2.4).div(d.add(size.mul(2.4)));
        const sparkle = crackle.mul(gate).mul(gate).mul(sparkW).mul(sparkAmt).mul(glow);
        acc = acc.add(vec3(sparkle));
        alpha = max(alpha, sparkle.clamp(0, 1));
      }
    }

    // Faint spinner body at the pivot (rig).
    if (drawRig && opts.pivot) {
      const pv = vec2(ctx.uniformOf(opts.pivot.x), ctx.uniformOf(opts.pivot.y));
      const dp = length(p.sub(pv));
      const body = glowDot(dp, size.mul(0.7), ctx.palette.color(1)).mul(spinnerAmt).mul(glow);
      acc = acc.add(body.rgb);
      alpha = max(alpha, body.a.mul(spinnerAmt));
    }

    return texNode(vec4(acc, alpha.clamp(0, 1)));
  },
);
