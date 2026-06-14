import { asSignal, BuildCtx, defineModule, Signal, type SignalLike } from "@loom/runtime";

export interface SpringOpts {
  input: SignalLike;
  /** Spring stiffness — higher chases the target faster (and overshoots more). */
  stiffness?: SignalLike;
  /** Damping — lower rings longer; ~2·√stiffness is critically damped. */
  damping?: SignalLike;
}

/**
 * Second-order spring follower (the TD Spring CHOP): the output overshoots and
 * rings around the input, so kicks feel physical instead of eased. Stateful —
 * pull it every frame. Integration is clamped per frame for stability.
 */
export const spring = defineModule(
  {
    name: "spring",
    kind: "control",
    description: "Bouncy spring-physics follower — overshoots and rings (stiffness/damping).",
    tags: ["spring", "physics", "bounce", "follower"],
    example: 'spring(ctx, { input: ctx.input("kick"), stiffness: 160, damping: 8 })',
  },
  (_ctx: BuildCtx, opts: SpringOpts): Signal<number> => {
    const input = asSignal(opts.input);
    const stiffness = asSignal(opts.stiffness ?? 120);
    const damping = asSignal(opts.damping ?? 10);
    let x = 0;
    let v = 0;
    return new Signal((f) => {
      const target = input.get(f);
      const k = Math.max(0, stiffness.get(f));
      const c = Math.max(0, damping.get(f));
      // Sub-step so high stiffness stays stable at display dt.
      const steps = Math.max(1, Math.ceil(f.dt / 0.004));
      const h = Math.min(0.05, f.dt) / steps;
      for (let i = 0; i < steps; i++) {
        v += (k * (target - x) - c * v) * h;
        x += v * h;
      }
      return x;
    });
  },
);
