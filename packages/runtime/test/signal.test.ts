import { describe, expect, it, vi } from "vitest";
import { Signal, asSignal } from "../src/signal";
import { F } from "./helpers";

describe("Signal", () => {
  it("Signal.of returns a constant", () => {
    const s = Signal.of(7);
    expect(s.get(F(0))).toBe(7);
    expect(s.get(F(5))).toBe(7);
  });

  it("memoizes within a frame and recomputes across frames", () => {
    const fn = vi.fn((f) => f.now * 2);
    const s = new Signal(fn);
    expect(s.get(F(1, 1))).toBe(2);
    expect(s.get(F(1, 1))).toBe(2);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(s.get(F(2, 2))).toBe(4);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("map composes and stays memoized", () => {
    const base = vi.fn(() => 3);
    const s = new Signal(base).map((v) => v + 1);
    expect(s.get(F(0))).toBe(4);
    expect(s.get(F(0))).toBe(4);
    expect(base).toHaveBeenCalledTimes(1);
  });

  it("asSignal wraps numbers and passes signals through", () => {
    expect(asSignal(2).get(F(0))).toBe(2);
    const s = Signal.of(9);
    expect(asSignal(s)).toBe(s);
  });

  it("named() stamps a cost-attribution label, map() inherits it", () => {
    const s = new Signal(() => 1).named("warp.curl");
    expect(s.label).toBe("warp.curl");
    expect(s.map((v) => v + 1).label).toBe("warp.curl");
    expect(new Signal(() => 0).label).toBeUndefined();
  });
});
