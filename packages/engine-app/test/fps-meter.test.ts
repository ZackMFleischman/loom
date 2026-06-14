import { describe, expect, it } from "vitest";
import { FrameRateCounter, tileFps } from "../src/ui/fps-meter";

describe("FrameRateCounter", () => {
  it("reads 0 until the first window closes", () => {
    const c = new FrameRateCounter(500);
    expect(c.current).toBe(0);
    expect(c.tick(0)).toBe(false); // first tick only seeds the clock
    expect(c.tick(16)).toBe(false); // window not yet elapsed
    expect(c.current).toBe(0);
  });

  it("measures fps over a closed window and reports the close", () => {
    const c = new FrameRateCounter(500);
    c.tick(0); // seed
    // 60 frames at a steady 16 ms cadence: the window closes once ~500 ms have
    // elapsed and reports the rate at that point (~62.5 fps for a 16 ms frame).
    let closed = false;
    for (let i = 1; i <= 60; i++) closed = c.tick(i * 16) || closed;
    expect(closed).toBe(true);
    expect(c.current).toBeCloseTo(1000 / 16, 0);
  });

  it("resets the window after each measurement", () => {
    const c = new FrameRateCounter(500);
    c.tick(0); // seed at t=0
    // First window: a steady ~33.3 ms frame → ~30 fps. Drive well past 500 ms.
    for (let i = 1; i <= 30; i++) c.tick(i * (1000 / 30));
    expect(c.current).toBeCloseTo(30, 0);
    const afterFirst = c.current;
    // Second window at a steady ~16.7 ms frame → ~60 fps, measured independently.
    const base = 30 * (1000 / 30);
    for (let i = 1; i <= 60; i++) c.tick(base + i * (1000 / 60));
    expect(c.current).toBeCloseTo(60, 0);
    expect(c.current).not.toBeCloseTo(afterFirst, 0);
  });

  it("only signals a close when a window actually elapses", () => {
    const c = new FrameRateCounter(1000);
    c.tick(0);
    expect(c.tick(100)).toBe(false);
    expect(c.tick(999)).toBe(false);
    expect(c.tick(1001)).toBe(true);
  });
});

describe("tileFps", () => {
  it("returns the engine fps for a cheap, healthy tile", () => {
    // 2 ms budget → 500 fps ceiling, so the engine fps wins.
    expect(tileFps(2, 60, false)).toBe(60);
  });

  it("caps at the tile's CPU budget when the tile is heavy", () => {
    // 20 ms/frame → 50 fps budget, below the 60 fps engine rate.
    expect(tileFps(20, 60, false)).toBeCloseTo(50, 5);
  });

  it("reports 0 for a frozen (errored) tile", () => {
    expect(tileFps(2, 60, true)).toBe(0);
  });

  it("reports 0 when the engine isn't rendering yet", () => {
    expect(tileFps(2, 0, false)).toBe(0);
  });

  it("falls back to engine fps when frameMs is unmeasured (0)", () => {
    expect(tileFps(0, 48, false)).toBe(48);
  });
});
