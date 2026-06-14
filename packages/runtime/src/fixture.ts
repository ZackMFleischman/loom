import { z } from "zod";
import { Signal } from "./signal";

/**
 * Fixtures — deterministic input traces. A fixture is a recorded run of the
 * input rack: one row of channel values per frame (post-detector, so replay
 * needs no audio, no detectors, no timing luck). An instance created with
 * `inputs: "fixture:<name>"` consumes the trace instead of the live rack —
 * `ctx.input()` is late-bound through an InputProvider, so scenes don't
 * change at all. Traces live in content/state/fixtures/<name>.json.
 */

/** Anything ctx.input() can consume: the live InputRegistry or a FixturePlayer. */
export interface InputProvider {
  signal(name: string): Signal<number>;
}

export const FixtureDataSchema = z.object({
  name: z.string().min(1),
  /** Transport BPM at record time — deterministic replays tick a TimeBus at this. */
  bpm: z.number().positive(),
  channels: z.array(z.string()).min(1),
  /** One row per frame, one column per channel (row length may be ragged-checked by consumers). */
  frames: z.array(z.array(z.number())).min(1),
});
export type FixtureData = z.infer<typeof FixtureDataSchema>;

/**
 * Replays a trace as an InputProvider. Frame indexing is relative to `base`
 * (the engine frame the instance was created on — or 0 for a deterministic
 * offline run) and loops past the end of the trace.
 */
export class FixturePlayer implements InputProvider {
  private readonly col = new Map<string, number>();

  constructor(
    readonly data: FixtureData,
    private base = 0,
  ) {
    data.channels.forEach((name, i) => this.col.set(name, i));
  }

  get length(): number {
    return this.data.frames.length;
  }

  /** Re-anchor trace frame 0 (instance creation time in the live loop). */
  rebase(frame: number): void {
    this.base = frame;
  }

  /** Channel value at the looped trace row for this frame; unknown names read 0. */
  signal(name: string): Signal<number> {
    const c = this.col.get(name);
    if (c == null) return new Signal(() => 0);
    const frames = this.data.frames;
    const len = frames.length;
    return new Signal((f) => {
      const row = frames[(((f.frame - this.base) % len) + len) % len];
      return row?.[c] ?? 0;
    });
  }
}
