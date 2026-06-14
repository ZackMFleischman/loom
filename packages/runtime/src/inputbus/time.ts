import { Events } from "../events";
import type { FrameCtx } from "../frame";
import { Signal } from "../signal";

const clampBpm = (b: number) => Math.min(300, Math.max(20, b));

/**
 * Transport time: BPM (manual set / tap in v1), continuous beat count,
 * beat phase, and beat event streams. The engine calls tick() once per
 * frame before anything pulls.
 */
export class TimeBus {
  readonly now = new Signal((f: FrameCtx) => f.now);
  readonly dt = new Signal((f: FrameCtx) => f.dt);
  /** Continuous beat count since start (fractional). */
  readonly beats = new Signal(() => this.beatCount);
  /** 0..1 sweep within the current beat. */
  readonly beatPhase = new Signal(() => ((this.beatCount % 1) + 1) % 1);

  private beatCount = 0;
  private _bpm: number;
  private lastTickFrame = -1;
  private taps: number[] = [];

  constructor(bpm = 120) {
    this._bpm = clampBpm(bpm);
  }

  get bpm(): number {
    return this._bpm;
  }

  setBpm(bpm: number): void {
    this._bpm = clampBpm(bpm);
  }

  /** Advance the beat clock; idempotent per frame. */
  tick(f: FrameCtx): void {
    if (f.frame === this.lastTickFrame) return;
    this.lastTickFrame = f.frame;
    this.beatCount += (f.dt * this._bpm) / 60;
  }

  /** Fires once per n beats, carrying the (1-based) group index. */
  beatEvery(n = 1): Events<number> {
    let last = Math.floor(this.beatCount / n);
    return new Events(() => {
      const idx = Math.floor(this.beatCount / n);
      if (idx <= last) return [];
      const out: number[] = [];
      for (let i = last + 1; i <= idx; i++) out.push(i);
      last = idx;
      return out;
    });
  }

  /** Tap tempo: call with a timestamp in seconds; >=3 taps set BPM. */
  tap(timeSec: number): void {
    const lastTap = this.taps[this.taps.length - 1];
    if (lastTap !== undefined && timeSec - lastTap > 2) this.taps = [];
    this.taps.push(timeSec);
    if (this.taps.length >= 3) {
      let sum = 0;
      for (let i = 1; i < this.taps.length; i++) sum += this.taps[i]! - this.taps[i - 1]!;
      const avg = sum / (this.taps.length - 1);
      if (avg > 0) this._bpm = clampBpm(60 / avg);
    }
  }
}
