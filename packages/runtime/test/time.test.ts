import { describe, expect, it } from "vitest";
import { TimeBus } from "../src/inputbus/time";
import { frames } from "./helpers";

describe("TimeBus", () => {
  it("beatPhase sweeps 0→1 once per beat at the set BPM", () => {
    const t = new TimeBus(120); // 0.5 s per beat
    const seq = frames(31, 1 / 60); // 0.5 s
    let phase = 0;
    for (const f of seq) {
      t.tick(f);
      phase = t.beatPhase.get(f);
    }
    // After exactly one beat the phase has wrapped back near 0.
    expect(phase).toBeLessThan(0.1);
  });

  it("beatEvery(1) fires once per beat with increasing beat indices", () => {
    const t = new TimeBus(120);
    const beats = t.beatEvery(1);
    const fired: number[] = [];
    for (const f of frames(121, 1 / 60)) {
      t.tick(f);
      fired.push(...beats.poll(f));
    }
    // 2 s at 120 BPM = 4 beats.
    expect(fired.length).toBe(4);
    expect(fired).toEqual([1, 2, 3, 4]);
  });

  it("beatEvery(2) fires every other beat", () => {
    const t = new TimeBus(120);
    const beats = t.beatEvery(2);
    const fired: number[] = [];
    for (const f of frames(121, 1 / 60)) {
      t.tick(f);
      fired.push(...beats.poll(f));
    }
    expect(fired.length).toBe(2);
  });

  it("bpm changes take effect for subsequent beats", () => {
    const t = new TimeBus(60);
    const beats = t.beatEvery(1);
    let count = 0;
    const seq = frames(121, 1 / 60); // 2 s
    for (const [i, f] of seq.entries()) {
      if (i === 60) t.setBpm(240); // after 1 s (1 beat), go 4x
      t.tick(f);
      count += beats.poll(f).length;
    }
    // ~1 beat in the first second + ~4 beats in the second.
    expect(count).toBeGreaterThanOrEqual(4);
    expect(count).toBeLessThanOrEqual(6);
  });

  it("tap tempo averages intervals into bpm", () => {
    const t = new TimeBus(120);
    // taps 0.5 s apart → 120 BPM; use the time argument directly
    t.tap(0);
    t.tap(0.5);
    t.tap(1.0);
    t.tap(1.5);
    expect(t.bpm).toBeCloseTo(120, 0);
    // faster taps → higher bpm
    t.tap(10);
    t.tap(10.25);
    t.tap(10.5);
    expect(t.bpm).toBeCloseTo(240, 0);
  });
});
