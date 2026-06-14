import type { FrameCtx } from "./frame";
import { Signal } from "./signal";

/**
 * Discrete occurrences (onsets, beats, notes) delivered per frame.
 * Pull-based and memoized like Signal; stateful ops (divide, quantize,
 * latch) require being polled every frame to not miss events.
 */
export class Events<T> {
  private lastFrame = -1;
  private cached: readonly T[] = [];

  constructor(private readonly fn: (f: FrameCtx) => readonly T[]) {}

  poll(f: FrameCtx): readonly T[] {
    if (f.frame !== this.lastFrame) {
      this.cached = this.fn(f);
      this.lastFrame = f.frame;
    }
    return this.cached;
  }

  map<U>(fn: (value: T) => U): Events<U> {
    return new Events((f) => this.poll(f).map(fn));
  }

  filter(pred: (value: T) => boolean): Events<T> {
    return new Events((f) => this.poll(f).filter(pred));
  }

  /** Pass events through only while `open` is true. */
  gate(open: Signal<boolean>): Events<T> {
    return new Events((f) => (open.get(f) ? this.poll(f) : []));
  }

  /** Keep every nth event (counting across frames). */
  divide(n: number): Events<T> {
    let i = -1;
    return new Events((f) =>
      this.poll(f).filter(() => {
        i++;
        return i % n === 0;
      }),
    );
  }

  /** Hold the most recent payload as a Signal. */
  latch(initial: T): Signal<T> {
    let value = initial;
    return new Signal((f) => {
      const es = this.poll(f);
      if (es.length > 0) value = es[es.length - 1]!;
      return value;
    });
  }

  /**
   * Frame-resolution quantize: buffer events and release them on the next
   * frame where `trigger` fires (e.g. a beat stream).
   */
  quantize(trigger: Events<unknown>): Events<T> {
    let pending: T[] = [];
    return new Events((f) => {
      pending.push(...this.poll(f));
      if (trigger.poll(f).length > 0 && pending.length > 0) {
        const out = pending;
        pending = [];
        return out;
      }
      return [];
    });
  }
}
