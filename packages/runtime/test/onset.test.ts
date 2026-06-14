import { describe, expect, it } from "vitest";
import { OnsetDetector, bandEnergy } from "../src/inputbus/analysis";

describe("OnsetDetector", () => {
  it("fires on a sharp rise above threshold", () => {
    const d = new OnsetDetector({ threshold: 0.3, rise: 0.1, refractoryMs: 100 });
    expect(d.step(0.05, 0)).toBe(false);
    expect(d.step(0.8, 16)).toBe(true);
  });

  it("does not fire while energy stays high (no re-trigger without a dip)", () => {
    const d = new OnsetDetector({ threshold: 0.3, rise: 0.1, refractoryMs: 100 });
    d.step(0.05, 0);
    expect(d.step(0.8, 16)).toBe(true);
    expect(d.step(0.85, 33)).toBe(false);
    expect(d.step(0.82, 50)).toBe(false);
  });

  it("respects the refractory window", () => {
    const d = new OnsetDetector({ threshold: 0.3, rise: 0.1, refractoryMs: 200 });
    d.step(0.0, 0);
    expect(d.step(0.9, 10)).toBe(true);
    d.step(0.05, 50); // dip
    expect(d.step(0.9, 60)).toBe(false); // still inside refractory
    d.step(0.05, 250); // dip after refractory
    expect(d.step(0.9, 260)).toBe(true);
  });

  it("ignores energy below threshold", () => {
    const d = new OnsetDetector({ threshold: 0.5, rise: 0.1, refractoryMs: 100 });
    expect(d.step(0.4, 0)).toBe(false);
    expect(d.step(0.45, 16)).toBe(false);
  });
});

describe("bandEnergy", () => {
  // 64 bins over 0..11025 Hz (fftSize 128 @ 22050 sample rate) for easy math
  const sampleRate = 22050;
  const fftSize = 128;

  it("averages only the bins inside the band", () => {
    const bins = new Uint8Array(64);
    bins.fill(255, 0, 2); // ~0-344 Hz hot
    const bass = bandEnergy(bins, sampleRate, fftSize, 20, 150);
    const treble = bandEnergy(bins, sampleRate, fftSize, 2000, 8000);
    expect(bass).toBeGreaterThan(0.9);
    expect(treble).toBe(0);
  });

  it("returns 0..1", () => {
    const bins = new Uint8Array(64).fill(128);
    const e = bandEnergy(bins, sampleRate, fftSize, 20, 8000);
    expect(e).toBeGreaterThan(0.45);
    expect(e).toBeLessThan(0.55);
  });
});
