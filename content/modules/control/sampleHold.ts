import { asSignal, BuildCtx, defineModule, Signal, type SignalLike } from "@loom/runtime";

export interface SampleHoldOpts {
  /** The signal whose value gets captured. */
  input: SignalLike;
  /** Trigger channel — a rising edge through `threshold` samples the input. */
  trigger: SignalLike;
  /** Edge level on the trigger (default 0.5). */
  threshold?: SignalLike;
  /** Value before the first trigger. */
  initial?: number;
}

/**
 * Sample-and-hold (the TD S+H idiom): freezes the input's value on each rising
 * edge of the trigger — "new value per kick" is a whole genre. Stateful: pull
 * it every frame so edges aren't missed.
 */
export const sampleHold = defineModule(
  {
    name: "sampleHold",
    kind: "control",
    description: "Samples the input on each trigger rising-edge and holds it (new value per kick).",
    tags: ["sample", "hold", "trigger", "step"],
    example: 'sampleHold(ctx, { input: lfo(ctx, { periodBeats: 3 }), trigger: ctx.input("kick") })',
  },
  (_ctx: BuildCtx, opts: SampleHoldOpts): Signal<number> => {
    const input = asSignal(opts.input);
    const trigger = asSignal(opts.trigger);
    const threshold = asSignal(opts.threshold ?? 0.5);
    let held = opts.initial ?? 0;
    let wasHigh = false;
    return new Signal((f) => {
      const high = trigger.get(f) >= threshold.get(f);
      if (high && !wasHigh) held = input.get(f);
      wasHigh = high;
      return held;
    });
  },
);
