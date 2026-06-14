import { describe, expect, it } from "vitest";
import { Signal } from "../src/signal";
import { lagSignal, lfoSignal, envelopeSignal } from "../src/control";
import { Events } from "../src/events";
import { frames } from "./helpers";

describe("lagSignal", () => {
  it("converges toward the target", () => {
    const target = Signal.of(1);
    const lagged = lagSignal(target, 0.1); // 100 ms time constant
    let v = 0;
    for (const f of frames(61, 1 / 60)) v = lagged.get(f); // 1 s
    expect(v).toBeGreaterThan(0.99);
  });

  it("smooths instead of jumping", () => {
    const target = Signal.of(1);
    const lagged = lagSignal(target, 0.5);
    const seq = frames(10, 1 / 60);
    const first = lagged.get(seq[0]!);
    const later = lagged.get(seq[5]!);
    expect(first).toBeLessThan(0.1);
    expect(later).toBeGreaterThan(first);
    expect(later).toBeLessThan(0.5);
  });

  it("zero time constant passes through", () => {
    const lagged = lagSignal(Signal.of(3), 0);
    expect(lagged.get(frames(1)[0]!)).toBe(3);
  });
});

describe("lfoSignal", () => {
  it("sine completes one cycle per period and stays in 0..1", () => {
    const beats = new Signal((f) => f.now); // 1 "beat" per second
    const lfo = lfoSignal(beats, { shape: "sine", periodBeats: 1 });
    const samples: number[] = [];
    for (const f of frames(61, 1 / 60)) samples.push(lfo.get(f));
    const min = Math.min(...samples);
    const max = Math.max(...samples);
    expect(min).toBeGreaterThanOrEqual(0);
    expect(max).toBeLessThanOrEqual(1);
    expect(max - min).toBeGreaterThan(0.9); // swept the full range
    // starts and ends near the same phase point
    expect(Math.abs(samples[0]! - samples[60]!)).toBeLessThan(0.05);
  });

  it("saw ramps 0→1 over the period", () => {
    const beats = new Signal((f) => f.now);
    const lfo = lfoSignal(beats, { shape: "saw", periodBeats: 1 });
    const seq = frames(60, 1 / 60);
    expect(lfo.get(seq[15]!)).toBeCloseTo(0.25, 1);
    expect(lfo.get(seq[45]!)).toBeCloseTo(0.75, 1);
  });

  it("square is high for the first half of the period", () => {
    const beats = new Signal((f) => f.now);
    const lfo = lfoSignal(beats, { shape: "square", periodBeats: 1 });
    const seq = frames(60, 1 / 60);
    expect(lfo.get(seq[10]!)).toBe(1);
    expect(lfo.get(seq[40]!)).toBe(0);
  });
});

describe("envelopeSignal", () => {
  it("jumps to 1 on an event and decays toward 0", () => {
    const trigger = new Events<number>((f) => (f.frame === 10 ? [1] : []));
    const env = envelopeSignal(trigger, { decay: 0.1 });
    const seq = frames(60, 1 / 60);
    const values = seq.map((f) => env.get(f));
    expect(values[9]).toBe(0);
    expect(values[10]).toBe(1);
    expect(values[20]!).toBeLessThan(values[10]!);
    expect(values[59]!).toBeLessThan(0.01);
  });

  it("retriggers on subsequent events", () => {
    const trigger = new Events<number>((f) => (f.frame === 5 || f.frame === 30 ? [1] : []));
    const env = envelopeSignal(trigger, { decay: 0.08 });
    const seq = frames(60, 1 / 60);
    const values = seq.map((f) => env.get(f));
    expect(values[29]!).toBeLessThan(0.1);
    expect(values[30]).toBe(1);
  });
});
