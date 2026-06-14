import { BuildCtx, defineModule, lagSignal, type Signal, type SignalLike } from "@loom/runtime";

export interface LagOpts {
  input: SignalLike;
  /** Time constant in seconds; 0 passes through. */
  seconds?: SignalLike;
}

/** Exponential smoothing for any number signal (the TD lag CHOP). */
export const lag = defineModule(
  {
    name: "lag",
    kind: "control",
    description: "Smooths a signal toward its target with a time constant.",
    tags: ["smooth", "filter"],
    example: 'lag(ctx, { input: ctx.audio.band("bass"), seconds: 0.08 })',
  },
  (_ctx: BuildCtx, opts: LagOpts): Signal<number> => lagSignal(opts.input, opts.seconds ?? 0.1),
);
