import { asSignal, BuildCtx, defineModule, Signal, type SignalLike } from "@loom/runtime";

export interface CounterOpts {
  /** Trigger channel — each rising edge through `threshold` counts. */
  trigger: SignalLike;
  /** Wrap the count back to 0 at this value (4 = bars of four). */
  wrap?: SignalLike;
  /** Edge level on the trigger (default 0.5). */
  threshold?: SignalLike;
}

/**
 * Edge counter with wraparound (the TD Count CHOP): counts trigger edges and
 * wraps at `wrap` — feed kicks in and step scene logic per beat/bar. Stateful:
 * pull it every frame so edges aren't missed.
 */
export const counter = defineModule(
  {
    name: "counter",
    kind: "control",
    description: "Counts trigger rising-edges, wrapping at N — beat-stepped scene logic.",
    tags: ["counter", "step", "trigger", "sequencer"],
    example: 'counter(ctx, { trigger: ctx.input("kick"), wrap: 4 })',
  },
  (_ctx: BuildCtx, opts: CounterOpts): Signal<number> => {
    const trigger = asSignal(opts.trigger);
    const wrap = asSignal(opts.wrap ?? 4);
    const threshold = asSignal(opts.threshold ?? 0.5);
    let count = 0;
    let wasHigh = false;
    return new Signal((f) => {
      const high = trigger.get(f) >= threshold.get(f);
      const w = Math.max(1, Math.round(wrap.get(f)));
      if (high && !wasHigh) count = (count + 1) % w;
      wasHigh = high;
      return count;
    });
  },
);
