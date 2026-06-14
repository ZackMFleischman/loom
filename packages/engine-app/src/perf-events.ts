import type { Diagnostics } from "./diagnostics";
import type { SessionStore } from "./session";

/** Frame-time budget for 60 fps (ms) — the threshold perf events fire against. */
export const FRAME_BUDGET_MS = 1000 / 60;

/** Sample a rolling perf event at most this often (frames). FR-3 cadence. */
export const PERF_SAMPLE_EVERY = 60;

/** fps below this is "low" (a sag worth an event); recovery above clears it. */
const FPS_LOW = 50;
const FPS_RECOVER = 57;

/** An instance frameMs above this crosses the high-water mark (a spike event). */
const FRAME_MS_HIGH = FRAME_BUDGET_MS * 1.5; // ~25 ms

/**
 * Threshold-edge + sampled perf events from the render tick (FR-3). Edge
 * emission (fps drops below / recovers above a budget; an instance's frameMs
 * crosses a high-water mark) is what lets the agent FIND spikes without polling
 * every frame; the periodic sample gives a heartbeat.
 *
 * Hot-path-safe (NFR-1): per frame this is integer compares + a Map lookup; it
 * only allocates an event object on an edge or the sampling boundary (≤ once a
 * second), and {@link Diagnostics.push} is itself wrapped to never throw.
 */
export class PerfEvents {
  private fpsLow = false;
  /** Per-instance "currently over the high-water mark" latch (id → bool). */
  private readonly hot = new Map<string, boolean>();
  private worstRecent = 0;

  constructor(
    private readonly diag: Diagnostics,
    private readonly session: SessionStore,
    private readonly fps: () => number,
    private readonly clockSource: () => "raf" | "worker",
  ) {}

  /** The worst single-instance frameMs since the last sample window (for the rollup). */
  get worstFrameMsRecent(): number {
    return this.worstRecent;
  }

  /** Called once per frame from the render loop. Cheap; never throws into the loop. */
  tick(frame: number): void {
    if (!this.diag.enabled) return;
    try {
      const fps = this.fps();

      // fps threshold crossings (only when the meter has a reading; 0 = warming up).
      if (fps > 0) {
        if (!this.fpsLow && fps < FPS_LOW) {
          this.fpsLow = true;
          this.diag.push({
            level: "warn",
            kind: "perf.fps.low",
            msg: `fps dropped to ${fps.toFixed(0)} (below ${FPS_LOW})`,
            data: { fps, clockSource: this.clockSource() },
          });
        } else if (this.fpsLow && fps >= FPS_RECOVER) {
          this.fpsLow = false;
          this.diag.push({
            level: "info",
            kind: "perf.fps.recovered",
            msg: `fps recovered to ${fps.toFixed(0)}`,
            data: { fps },
          });
        }
      }

      // Per-instance frameMs high-water-mark crossings.
      for (const e of this.session.entries.values()) {
        const ms = e.instance.frameMs;
        if (ms > this.worstRecent) this.worstRecent = ms;
        const wasHot = this.hot.get(e.id) ?? false;
        if (!wasHot && ms > FRAME_MS_HIGH) {
          this.hot.set(e.id, true);
          this.diag.push({
            level: "warn",
            kind: "perf.frame.spike",
            instance: e.id,
            msg: `instance "${e.id}" frameMs crossed ${FRAME_MS_HIGH.toFixed(0)} ms (${ms.toFixed(1)})`,
            data: { frameMs: Math.round(ms * 100) / 100, slowSignals: e.instance.slowSignals(3) },
          });
        } else if (wasHot && ms < FRAME_MS_HIGH * 0.8) {
          this.hot.set(e.id, false);
        }
      }

      // Periodic heartbeat sample (FR-3) — carries fps/clockSource and the live
      // worst-frame read, so the agent has a perf point even with no edges.
      if (frame > 0 && frame % PERF_SAMPLE_EVERY === 0) {
        const worst = this.worstRecent;
        this.diag.push({
          level: "info",
          kind: "perf.sample",
          msg: `perf sample: ${fps.toFixed(0)} fps, worst frameMs ${worst.toFixed(1)}`,
          data: { fps, clockSource: this.clockSource(), worstFrameMsRecent: Math.round(worst * 100) / 100 },
        });
        this.worstRecent = 0; // reset the window
      }
    } catch {
      // perf instrumentation must never break the loop
    }
  }
}
