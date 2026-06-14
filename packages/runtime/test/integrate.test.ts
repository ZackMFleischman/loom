import { describe, expect, it } from "vitest";
import { integrateSignal } from "../src/control";
import { Signal } from "../src/signal";

const f = (frame: number) => ({ frame, now: frame / 60, dt: 1 / 60 });

describe("integrateSignal", () => {
  it("accumulates rate × dt on the frame clock", () => {
    const acc = integrateSignal(60); // 60 units/sec → 1 unit per frame at 60fps
    expect(acc.get(f(0))).toBeCloseTo(1);
    expect(acc.get(f(1))).toBeCloseTo(2);
    expect(acc.get(f(2))).toBeCloseTo(3);
  });

  it("rate changes never jump the accumulated phase", () => {
    let rate = 60;
    const acc = integrateSignal(new Signal(() => rate));
    acc.get(f(0));
    rate = 0; // freeze
    expect(acc.get(f(1))).toBeCloseTo(1);
    expect(acc.get(f(2))).toBeCloseTo(1); // held, no jump
    rate = -60; // reverse
    expect(acc.get(f(3))).toBeCloseTo(0);
  });

  it("wrap keeps the phase inside [0, wrap) forever (float-precision guard)", () => {
    const acc = integrateSignal(90, { wrap: 1 }); // 1.5 per frame
    expect(acc.get(f(0))).toBeCloseTo(0.5);
    expect(acc.get(f(1))).toBeCloseTo(0);
    const back = integrateSignal(-90, { wrap: 1 });
    expect(back.get(f(0))).toBeCloseTo(0.5); // negative rates wrap positively
  });
});
