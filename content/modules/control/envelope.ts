import { asSignal, BuildCtx, defineModule, Signal, type SignalLike } from "@loom/runtime";

export interface EnvelopeOpts {
  input: SignalLike;
  /** Rise time constant in seconds (small = snappy). */
  attack?: SignalLike;
  /** Fall time constant in seconds (large = long tails). */
  release?: SignalLike;
}

/**
 * Asymmetric attack/release follower (the TD Envelope/Slope idiom): rises fast,
 * falls slow — the punchy shape `lag`'s symmetric smoothing can't make.
 * Stateful: pull it every frame (any `ctx.uniformOf` consumer does).
 */
export const envelope = defineModule(
  {
    name: "envelope",
    kind: "control",
    description: "Attack/release follower — fast rise, slow fall (punchier than lag).",
    tags: ["envelope", "follower", "smooth", "audio-reactive"],
    example: 'envelope(ctx, { input: ctx.input("kick"), attack: 0.005, release: 0.4 })',
  },
  (_ctx: BuildCtx, opts: EnvelopeOpts): Signal<number> => {
    const input = asSignal(opts.input);
    const attack = asSignal(opts.attack ?? 0.01);
    const release = asSignal(opts.release ?? 0.35);
    let v = 0;
    return new Signal((f) => {
      const target = input.get(f);
      const tau = Math.max(1e-4, target > v ? attack.get(f) : release.get(f));
      v += (target - v) * (1 - Math.exp(-f.dt / tau));
      return v;
    });
  },
);
