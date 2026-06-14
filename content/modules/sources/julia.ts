import {
  asSignal,
  BuildCtx,
  defineModule,
  lagSignal,
  Signal,
  texNode,
  type SignalLike,
  type TexNode,
} from "@loom/runtime";
import { Break, Fn, If, Loop, float, log2, max, uv, vec2, vec3, vec4 } from "three/tsl";

// The Output renders 16:9 internally; julia coords are half-height extent.
const SCREEN_ASPECT = 16 / 9;

// Fixed unroll bound — the `iterations` uniform breaks out early. Keeps the
// loop compilable on the WebGL2 fallback (no dynamic loop bounds).
const MAX_ITER = 500;

export interface JuliaOpts {
  /** Julia constant, real part — the headline knob: it picks WHICH Julia set. */
  cx?: SignalLike;
  /** Julia constant, imaginary part. */
  cy?: SignalLike;
  /** Half the vertical extent of the view in set coordinates (smaller = deeper zoom). Default 1.4. */
  scale?: SignalLike;
  /** View center, real axis (default 0 — Julia sets are centered on the origin). */
  centerX?: SignalLike;
  /** View center, imaginary axis (default 0). */
  centerY?: SignalLike;
  /** Escape-time iteration cap (10..500) — raise it for finer filaments. */
  iterations?: SignalLike;
  /** Lag seconds applied to cx/cy so retargeting glides between constants instead of jump-cutting (default 0 = snap). */
  glide?: SignalLike;
  /** Orbit speed in revolutions/sec; when set, c circles the (cx,cy) base — the set breathes and morphs. */
  morph?: SignalLike;
  /** Orbit radius in the c-plane for the morph (default 0.05; tiny is best — c is delicate). */
  morphRadius?: SignalLike;
}

/**
 * Smooth escape-time Julia set rendered as grayscale: brightness encodes the
 * (smoothed) escape iteration count, interior (filled-set) points stay black.
 * Same z = z^2 + c iteration as Mandelbrot, but z starts at the pixel and c is
 * a FIXED constant — so each (cx,cy) is a different fractal. Feed it to colorize
 * for palettes. float32 GPU precision pixelates past scale ~1e-5.
 */
export const julia = defineModule(
  {
    name: "julia",
    kind: "source",
    description: "Smooth escape-time Julia set in grayscale; c picks the fractal, morph breathes it (compose with colorize).",
    tags: ["fractal", "julia", "morph", "math"],
    example: 'julia(ctx, { cx: -0.8, cy: 0.156, morph: 0.05, iterations: 250 })',
  },
  (ctx: BuildCtx, opts: JuliaOpts = {}): TexNode => {
    // Optional self-morph: orbit c around its base on a small circle. Identical
    // integrator pattern to mandelbrot's `dive` (CPU Signal, fixture-safe — no
    // wall-clock time in the shader).
    let cxLike: SignalLike = opts.cx ?? -0.8;
    let cyLike: SignalLike = opts.cy ?? 0.156;
    if (opts.morph !== undefined) {
      const baseX = asSignal(opts.cx ?? -0.8);
      const baseY = asSignal(opts.cy ?? 0.156);
      const speedS = asSignal(opts.morph);
      const radS = asSignal(opts.morphRadius ?? 0.05);
      let phase = 0;
      cxLike = new Signal((f) => {
        phase += speedS.get(f) * f.dt;
        return baseX.get(f) + radS.get(f) * Math.cos(2 * Math.PI * phase);
      });
      cyLike = new Signal((f) => {
        // phase already advanced by the cx pull this frame (signals memoize on f.frame).
        return baseY.get(f) + radS.get(f) * Math.sin(2 * Math.PI * phase);
      });
    }

    // Optional glide: lag cx/cy toward their targets (glide = seconds) so
    // switching constants eases instead of snapping.
    const cxIn: SignalLike = opts.glide !== undefined ? lagSignal(cxLike, opts.glide) : cxLike;
    const cyIn: SignalLike = opts.glide !== undefined ? lagSignal(cyLike, opts.glide) : cyLike;
    const cx = ctx.uniformOf(cxIn);
    const cy = ctx.uniformOf(cyIn);

    const scale = ctx.uniformOf(opts.scale ?? 1.4);
    const centerX = ctx.uniformOf(opts.centerX ?? 0);
    const centerY = ctx.uniformOf(opts.centerY ?? 0);
    const iterations = ctx.uniformOf(opts.iterations ?? 200);

    const shade = Fn(() => {
      const p = uv().sub(0.5).mul(2).mul(vec2(SCREEN_ASPECT, 1));
      // Julia: z starts AT the pixel; c is the fixed constant.
      const z = vec2(centerX, centerY).add(p.mul(scale)).toVar();
      const c = vec2(cx, cy);
      const n = float(0).toVar();
      const escaped = float(0).toVar();

      Loop(MAX_ITER, () => {
        If(n.greaterThanEqual(iterations.min(MAX_ITER)), () => {
          Break();
        });
        z.assign(
          vec2(z.x.mul(z.x).sub(z.y.mul(z.y)).add(c.x), z.x.mul(z.y).mul(2).add(c.y)),
        );
        If(z.dot(z).greaterThan(256.0), () => {
          escaped.assign(1);
          Break();
        });
        n.addAssign(1);
      });

      // Smooth (fractional) iteration count, normalized and gamma-lifted.
      const sn = n.add(4).sub(log2(max(log2(max(z.dot(z), 1.0001)), 1e-6)));
      const t = sn.div(iterations.min(MAX_ITER)).clamp(0, 1).pow(0.5);
      return vec4(vec3(t.mul(escaped)), 1);
    });

    return texNode(shade());
  },
);
