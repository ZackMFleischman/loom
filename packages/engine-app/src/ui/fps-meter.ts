import { useEffect, useState } from "react";

/**
 * A rolling FPS counter for the Console's OWN paint loop. The Console is a React
 * app whose frame rate is independent of the engine's render loop (which has its
 * own `?hud=1` readout); when the Console janks — React re-rendering every engine
 * frame, many live preview canvases, a heavy popover mount — this is the meter
 * that shows it. Pure (no DOM, no rAF): feed it `performance.now()` timestamps
 * and read `.current`. Unit-tested in Node; the rAF plumbing lives in the hook.
 */
export class FrameRateCounter {
  /** Last measured fps; 0 until the first window completes. */
  current = 0;

  private frames = 0;
  private last = NaN;

  constructor(private readonly windowMs = 500) {}

  /**
   * Record one frame at timestamp `now` (ms). Returns true when a measurement
   * window just closed (i.e. `current` was updated) so callers can repaint only
   * on change rather than every frame.
   */
  tick(now: number): boolean {
    if (Number.isNaN(this.last)) {
      this.last = now;
      return false;
    }
    this.frames++;
    const elapsed = now - this.last;
    if (elapsed < this.windowMs) return false;
    this.current = (this.frames * 1000) / elapsed;
    this.frames = 0;
    this.last = now;
    return true;
  }
}

/**
 * A per-tile render-rate readout derived from the engine's existing per-instance
 * data — no new engine plumbing. Every instance renders once per engine frame,
 * so a healthy tile's throughput is the engine fps; we cap it by the instance's
 * own CPU budget (1000 / frameMs) so a heavy tile reads lower than the engine
 * rate, and report 0 for a frozen (errored) instance which holds its last frame.
 *
 * @param frameMs   smoothed per-frame CPU submit cost (InstanceInfo.frameMs)
 * @param engineFps the Output window's current fps (SessionSnapshot.fps)
 * @param frozen    true when the instance errored (status !== "ok")
 */
export function tileFps(frameMs: number, engineFps: number, frozen: boolean): number {
  if (frozen) return 0;
  if (engineFps <= 0) return 0;
  // frameMs is CPU submit only (GPU is opaque), so it's a ceiling on throughput,
  // never a floor — a tile can't render faster than the shared engine loop.
  const budgetFps = frameMs > 0 ? 1000 / frameMs : engineFps;
  return Math.min(engineFps, budgetFps);
}

/**
 * Console paint-rate hook: drives a {@link FrameRateCounter} off
 * requestAnimationFrame and re-renders (at most ~2 Hz, when a window closes)
 * with the latest fps. Returns 0 until the first window completes. The rAF loop
 * stops on unmount. In a non-browser/test environment (no rAF) it stays 0.
 */
export function useRenderFps(windowMs = 500): number {
  const [fps, setFps] = useState(0);
  useEffect(() => {
    if (typeof requestAnimationFrame !== "function") return;
    const counter = new FrameRateCounter(windowMs);
    let raf = 0;
    const loop = () => {
      if (counter.tick(performance.now())) setFps(counter.current);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [windowMs]);
  return fps;
}
