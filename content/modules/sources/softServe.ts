import { BuildCtx, defineModule, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import { clamp, float, max, mix, pow, sin, smoothstep, uv, vec3, vec4 } from "three/tsl";
import { surfaceAspect } from "../_shared";

const TAU = Math.PI * 2;

export interface SoftServeOpts {
  /** Vanilla cream rgb as three 0..1 SignalLikes (wire a color param's channels). */
  tint?: readonly [SignalLike, SignalLike, SignalLike];
  /** Swirl base (where it meets the cone mouth) in uv-y — compile-time layout. */
  baseY?: number;
  /** Swirl tip in uv-y — compile-time layout. */
  tipY?: number;
  /** Base half-width in aspect-corrected x units. */
  width?: SignalLike;
  /** Coil wraps stacked up the pile (fewer = thicker, soft-serve-like). */
  coils?: SignalLike;
  /** Coil climb speed — the swirl perpetually spirals up as fresh cream lands. */
  flow?: SignalLike;
  /** Gentle axis sway. */
  sway?: SignalLike;
  /** Tip lean — the floppy soft-serve peak curl. */
  hook?: SignalLike;
  /** Coil bulge depth on the silhouette (0 = smooth cone). */
  ridge?: SignalLike;
  /** Crest sheen strength. */
  gloss?: SignalLike;
  /** Dispenser ribbon pouring from the frame top onto the tip (0 = none). */
  stream?: SignalLike;
  /** Wobble drive — feed a bass/kick signal so the cream shivers. */
  energy?: SignalLike;
}

/**
 * An upright soft-serve swirl: a teardrop pile (wide base → hooked tip) built
 * from fat helical coil bands whose phase climbs forever, so it reads as cream
 * perpetually spiraling up while a dispenser ribbon pours onto the peak — an
 * ice cream that's always getting more added. Vanilla by default, shaded with
 * a crest highlight and base occlusion. Premultiplied alpha (drops onto a cone
 * via `over`), pure, frame-clocked. The base/tip layout is shared with
 * `wafffleCone` and `sprinkles` so a scene can stack them into one cone.
 */
export const softServe = defineModule(
  {
    name: "softServe",
    kind: "source",
    description:
      "Upright vanilla soft-serve swirl: a hooked teardrop of fat coil bands climbing forever, with a pour ribbon on top (premultiplied alpha).",
    tags: ["ice-cream", "swirl", "spiral", "vanilla", "overlay", "audio-reactive"],
    example: 'softServe(ctx, { coils: 4, flow: 0.4, energy: bassSig })',
  },
  (ctx: BuildCtx, opts: SoftServeOpts = {}): TexNode => {
    const tint = opts.tint ?? [0.97, 0.92, 0.7];
    const tintU = vec3(ctx.uniformOf(tint[0]), ctx.uniformOf(tint[1]), ctx.uniformOf(tint[2]));
    const baseY = opts.baseY ?? 0.34;
    const tipY = opts.tipY ?? 0.82;
    const width = ctx.uniformOf(opts.width ?? 0.3);
    const coils = ctx.uniformOf(opts.coils ?? 4);
    const flow = ctx.uniformOf(opts.flow ?? 0.4);
    const sway = ctx.uniformOf(opts.sway ?? 0.03);
    const hook = ctx.uniformOf(opts.hook ?? 0.1);
    const ridge = ctx.uniformOf(opts.ridge ?? 0.5);
    const gloss = ctx.uniformOf(opts.gloss ?? 0.7);
    const stream = ctx.uniformOf(opts.stream ?? 0.6);
    const energy = ctx.uniformOf(opts.energy ?? 0);

    // Frame-clock time, NOT TSL `time` (wall clock) — keeps fixture replays deterministic.
    const t = ctx.uniformOf(ctx.time.now);
    const live = energy.mul(0.6).add(1);
    const x = uv().x.sub(0.5).mul(surfaceAspect());
    const y = uv().y;
    const span = float(tipY - baseY);
    const s = y.sub(baseY).div(span); // 0 at base, 1 at tip (outside the band beyond)
    const sc = clamp(s, 0, 1);

    // Centerline + taper profile — MUST stay in sync with sprinkles.ts placement.
    const xc = sin(sc.mul(3).add(t.mul(0.5))).mul(sway).mul(sc).mul(live)
      .add(hook.mul(smoothstep(float(0.6), float(1), sc)));
    const taper = pow(max(float(1).sub(sc), float(0)), float(0.55));

    const xn0 = x.sub(xc).div(width.mul(taper).max(1e-3));
    // Coil bands climb with time (cream being added), sheared into a diagonal wrap.
    const ph = sc.mul(coils).sub(t.mul(flow)).mul(TAU).sub(xn0.mul(0.9));
    const coil = sin(ph);
    const w = width.mul(taper).mul(coil.mul(ridge).mul(0.18).mul(live).add(1)).max(1e-3);

    const dx = x.sub(xc).abs();
    const inY = smoothstep(float(-0.02), float(0.02), s).mul(smoothstep(float(1.04), float(0.95), s));
    const body = smoothstep(w, w.mul(0.84), dx).mul(inY);

    const nx = clamp(dx.div(w), 0, 1);
    const round = float(1).sub(nx.mul(nx).mul(0.55));
    // Bright crest, shadowed valley, plus a darker groove line between wraps.
    const groove = smoothstep(float(-0.85), float(-0.2), coil).mul(0.22).add(0.78);
    const shade = coil.mul(0.24).add(0.74).mul(groove);
    const spec = pow(max(coil, float(0)), float(7)).mul(float(1).sub(nx).max(0)).mul(gloss).mul(0.6);
    const ao = smoothstep(float(0), float(0.16), s).mul(0.28).add(0.72); // contact shadow at the cone
    const cream = mix(tintU.mul(0.7), tintU, round.mul(shade)).mul(ao).add(vec3(1, 0.98, 0.9).mul(spec));

    // Dispenser ribbon: a wobbling cream stream from the frame top onto the tip.
    const xcTip = sin(float(3).add(t.mul(0.5))).mul(sway).mul(live).add(hook);
    const sx = xcTip.add(sin(y.mul(30).add(t.mul(flow).mul(8))).mul(0.01));
    const ws = width.mul(0.12).mul(stream.clamp(0, 1)).max(1e-3);
    const above = smoothstep(tipY, float(1.02), y);
    const sBody = smoothstep(ws, ws.mul(0.5), x.sub(sx).abs()).mul(above).mul(stream.clamp(0, 1));
    const sCol = tintU.mul(sin(y.mul(36).add(t.mul(flow).mul(10))).mul(0.12).add(0.88));

    const rgb = cream.mul(body).add(sCol.mul(sBody).mul(float(1).sub(body)));
    const alpha = body.add(sBody.mul(float(1).sub(body))).clamp(0, 1);
    return texNode(vec4(rgb, alpha));
  },
);
