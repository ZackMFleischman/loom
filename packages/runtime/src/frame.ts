/** One frame's evaluation context. Everything pull-based keys off `frame`. */
export interface FrameCtx {
  /** Monotonic frame id; memoization key for Signal/Events. */
  frame: number;
  /** Seconds since the clock started. */
  now: number;
  /** Seconds since the previous frame, clamped to 0.1 to survive tab stalls. */
  dt: number;
}

export class Clock {
  private frame = 0;
  private last: number | null = null;
  private nowS = 0;

  /** Advance with a DOMHighResTimeStamp (ms) from the animation loop. */
  tick(tMs: number): FrameCtx {
    const t = tMs / 1000;
    const dt = this.last == null ? 0 : Math.min(Math.max(t - this.last, 0), 0.1);
    this.last = t;
    this.nowS += dt;
    return { frame: this.frame++, now: this.nowS, dt };
  }
}
