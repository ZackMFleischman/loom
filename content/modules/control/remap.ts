import { asSignal, BuildCtx, defineModule, Signal, type SignalLike } from "@loom/runtime";

export interface RemapOpts {
  input: SignalLike;
  /** Input range. */
  inMin?: SignalLike;
  inMax?: SignalLike;
  /** Output range (outMin > outMax inverts). */
  outMin?: SignalLike;
  outMax?: SignalLike;
  /** Response curve over the normalized value (compile-time). */
  curve?: "linear" | "exp" | "smooth";
  /** Clamp the normalized value to 0..1 before shaping (default true). */
  clamp?: boolean;
}

/**
 * Range mapping with a response curve (the TD Math/Range CHOP) — the glue op
 * that turns "kick 0..1" into "zoom 1..1.4, eased" without Signal boilerplate.
 */
export const remap = defineModule(
  {
    name: "remap",
    kind: "control",
    description: "Maps a signal from one range to another with a linear/exp/smooth curve.",
    tags: ["math", "range", "curve", "glue"],
    example: 'remap(ctx, { input: kickEnv, outMin: 1, outMax: 1.4, curve: "smooth" })',
  },
  (_ctx: BuildCtx, opts: RemapOpts): Signal<number> => {
    const input = asSignal(opts.input);
    const inMin = asSignal(opts.inMin ?? 0);
    const inMax = asSignal(opts.inMax ?? 1);
    const outMin = asSignal(opts.outMin ?? 0);
    const outMax = asSignal(opts.outMax ?? 1);
    const curve = opts.curve ?? "linear";
    const doClamp = opts.clamp ?? true;
    return new Signal((f) => {
      const lo = inMin.get(f);
      const span = inMax.get(f) - lo;
      let t = Math.abs(span) < 1e-9 ? 0 : (input.get(f) - lo) / span;
      if (doClamp) t = Math.min(1, Math.max(0, t));
      if (curve === "exp") t = t * t;
      else if (curve === "smooth") t = t * t * (3 - 2 * t);
      const o = outMin.get(f);
      return o + t * (outMax.get(f) - o);
    });
  },
);
