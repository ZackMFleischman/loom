export interface OnsetOpts {
  /** Band energy (0..1) that must be exceeded. */
  threshold?: number;
  /** Minimum rise over the previous sample. */
  rise?: number;
  /** Re-trigger lockout, ms. */
  refractoryMs?: number;
}

/**
 * Threshold + rising-edge onset detector with refractory window.
 * Re-arms only after energy dips below threshold, so sustained energy
 * doesn't machine-gun events.
 */
export class OnsetDetector {
  private readonly threshold: number;
  private readonly rise: number;
  private readonly refractoryMs: number;
  private prev = 0;
  private lastFire = -Infinity;
  private armed = true;

  constructor(opts: OnsetOpts = {}) {
    this.threshold = opts.threshold ?? 0.3;
    this.rise = opts.rise ?? 0.08;
    this.refractoryMs = opts.refractoryMs ?? 120;
  }

  step(energy: number, timeMs: number): boolean {
    let fired = false;
    if (
      this.armed &&
      energy >= this.threshold &&
      energy - this.prev >= this.rise &&
      timeMs - this.lastFire >= this.refractoryMs
    ) {
      fired = true;
      this.lastFire = timeMs;
      this.armed = false;
    }
    if (energy < this.threshold) this.armed = true;
    this.prev = energy;
    return fired;
  }
}

/** Mean energy (0..1) of the FFT bins covering [loHz, hiHz]. */
export function bandEnergy(
  bins: Uint8Array,
  sampleRate: number,
  fftSize: number,
  loHz: number,
  hiHz: number,
): number {
  const binHz = sampleRate / fftSize;
  const lo = Math.max(0, Math.floor(loHz / binHz));
  const hi = Math.min(bins.length - 1, Math.floor(hiHz / binHz));
  if (hi < lo) return 0;
  let sum = 0;
  for (let i = lo; i <= hi; i++) sum += bins[i]!;
  return sum / ((hi - lo + 1) * 255);
}
