import { BuildCtx, defineModule, lfoSignal, type LfoOpts, type Signal } from "@loom/runtime";

/** Beat-synced low-frequency oscillator in [0,1]. */
export const lfo = defineModule(
  {
    name: "lfo",
    kind: "control",
    description: "Beat-synced LFO (sine/saw/square) in 0..1.",
    tags: ["modulation", "beat-sync"],
    example: 'lfo(ctx, { shape: "sine", periodBeats: 8 })',
  },
  (ctx: BuildCtx, opts: LfoOpts = {}): Signal<number> => lfoSignal(ctx.time.beats, opts),
);
