import { asSignal, BuildCtx, defineModule, Signal, type SignalLike } from "@loom/runtime";

export interface GateOpts {
  input: SignalLike;
  /** Level that flips the gate on. */
  threshold?: SignalLike;
  /** Hysteresis band: the gate releases at threshold − hysteresis (no chatter). */
  hysteresis?: SignalLike;
  /** Output 0/1 is multiplied by this (gate a level, not just a flag). */
  scale?: SignalLike;
}

/**
 * Threshold a signal to 0/1 with hysteresis (the TD Logic CHOP idiom): on at
 * `threshold`, off below `threshold − hysteresis`, so a hovering level never
 * chatters. Stateful — pull it every frame.
 */
export const gate = defineModule(
  {
    name: "gate",
    kind: "control",
    description: "Hysteresis threshold — 0/1 gate that never chatters on a hovering level.",
    tags: ["gate", "threshold", "logic", "trigger"],
    example: 'gate(ctx, { input: ctx.input("bass"), threshold: 0.4, hysteresis: 0.1 })',
  },
  (_ctx: BuildCtx, opts: GateOpts): Signal<number> => {
    const input = asSignal(opts.input);
    const threshold = asSignal(opts.threshold ?? 0.5);
    const hysteresis = asSignal(opts.hysteresis ?? 0.1);
    const scale = asSignal(opts.scale ?? 1);
    let open = false;
    return new Signal((f) => {
      const v = input.get(f);
      const on = threshold.get(f);
      if (open) {
        if (v < on - Math.max(0, hysteresis.get(f))) open = false;
      } else if (v >= on) {
        open = true;
      }
      return open ? scale.get(f) : 0;
    });
  },
);
