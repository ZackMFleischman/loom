import type { FrameCtx } from "./frame";

/**
 * Continuous time-varying value: memoized pull, evaluated at most once per
 * frame. Stateful signals (lag, envelopes) rely on being pulled every frame —
 * instances guarantee that by registering uniform updaters.
 */
export class Signal<T> {
  private lastFrame = -1;
  private cached!: T;
  /**
   * Optional human label (usually a param path) carried for cost attribution:
   * when this signal is bridged to the GPU via `ctx.uniformOf`, the per-frame
   * updater inherits it, so `Instance` can name which signal a frame spent its
   * time in. Purely diagnostic — never affects evaluation.
   */
  label?: string;

  constructor(private readonly fn: (f: FrameCtx) => T) {}

  get(f: FrameCtx): T {
    if (f.frame !== this.lastFrame) {
      this.cached = this.fn(f);
      this.lastFrame = f.frame;
    }
    return this.cached;
  }

  map<U>(fn: (value: T) => U): Signal<U> {
    const out = new Signal((f) => fn(this.get(f)));
    if (this.label !== undefined) out.label = this.label; // mapped view attributes to its source
    return out;
  }

  /** Tag this signal for cost attribution; returns `this` for chaining. */
  named(label: string): this {
    this.label = label;
    return this;
  }

  static of<T>(value: T): Signal<T> {
    return new Signal(() => value);
  }
}

/** Anywhere a number is accepted, a Signal<number> is too. */
export type SignalLike = number | Signal<number>;

export function asSignal(v: SignalLike): Signal<number> {
  return typeof v === "number" ? Signal.of(v) : v;
}
