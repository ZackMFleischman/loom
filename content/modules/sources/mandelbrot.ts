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

// The Output renders 16:9 internally; mandelbrot coords are half-height extent.
const SCREEN_ASPECT = 16 / 9;

// Fixed unroll bound — the `iterations` uniform breaks out early. Keeps the
// loop compilable on the WebGL2 fallback (no dynamic loop bounds).
const MAX_ITER = 500;

export interface MandelbrotOpts {
  /** View center, real axis. */
  cx?: SignalLike;
  /** View center, imaginary axis. */
  cy?: SignalLike;
  /** Half the vertical extent of the view in set coordinates (smaller = deeper). Ignored when `dive` is set. */
  scale?: SignalLike;
  /** Escape-time iteration cap (10..500) — raise it as you zoom deeper. */
  iterations?: SignalLike;
  /** Lag seconds applied to cx/cy so retargeting glides instead of jump-cutting (default 0 = snap). */
  glide?: SignalLike;
  /** Zoom speed in octaves/sec; when set, drives an internal ping-pong zoom and overrides `scale`. */
  dive?: SignalLike;
  /** Max zoom depth in octaves for the ping-pong (default 14; f32 GPU limit ~18). */
  depth?: SignalLike;
  /** Half-extent at the top of the dive (default 1.25). */
  baseScale?: SignalLike;
}

/**
 * Smooth escape-time Mandelbrot rendered as grayscale: brightness encodes the
 * (smoothed) iteration count, interior points stay black. Feed it to colorize
 * for palettes. float32 GPU precision pixelates past scale ~1e-5 — keep dive
 * loops above that.
 */
export const mandelbrot = defineModule(
  {
    name: "mandelbrot",
    kind: "source",
    description: "Smooth escape-time Mandelbrot set in grayscale (compose with colorize).",
    tags: ["fractal", "mandelbrot", "zoom", "math"],
    example: 'mandelbrot(ctx, { cx: -0.7436, cy: 0.1314, scale: zoomSig, iterations: 250 })',
  },
  (ctx: BuildCtx, opts: MandelbrotOpts = {}): TexNode => {
    // Optional center glide: lag cx/cy toward their targets (glide = seconds).
    const cxIn: SignalLike = opts.glide !== undefined ? lagSignal(opts.cx ?? -0.6, opts.glide) : (opts.cx ?? -0.6);
    const cyIn: SignalLike = opts.glide !== undefined ? lagSignal(opts.cy ?? 0, opts.glide) : (opts.cy ?? 0);
    const cx = ctx.uniformOf(cxIn);
    const cy = ctx.uniformOf(cyIn);

    // Optional self-dive: integrate a ping-pong zoom into the view scale.
    // Identical math to the old mandelbrot.scene.ts integrator.
    let scaleLike: SignalLike;
    if (opts.dive !== undefined) {
      const diveS = asSignal(opts.dive);
      const depthS = asSignal(opts.depth ?? 14);
      const baseS = asSignal(opts.baseScale ?? 1.25);
      let zoomAcc = 0;
      scaleLike = new Signal((f) => {
        zoomAcc += diveS.get(f) * f.dt;
        const d = Math.max(0.001, depthS.get(f));
        const m = ((zoomAcc % (2 * d)) + 2 * d) % (2 * d);
        const octaves = m < d ? m : 2 * d - m;
        return baseS.get(f) * Math.pow(2, -octaves);
      });
    } else {
      scaleLike = opts.scale ?? 1.25;
    }
    const scale = ctx.uniformOf(scaleLike);
    const iterations = ctx.uniformOf(opts.iterations ?? 200);

    const shade = Fn(() => {
      const p = uv().sub(0.5).mul(2).mul(vec2(SCREEN_ASPECT, 1));
      const c = vec2(cx, cy).add(p.mul(scale)).toVar();
      const z = vec2(0).toVar();
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
