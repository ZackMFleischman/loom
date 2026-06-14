import { describe, expect, it, vi } from "vitest";
import { Events } from "../src/events";
import { Signal } from "../src/signal";
import { F, frames } from "./helpers";

/** Events that fire the given payloads on the given frame numbers. */
function eventsOnFrames<T>(schedule: Record<number, T[]>): Events<T> {
  return new Events((f) => schedule[f.frame] ?? []);
}

describe("Events", () => {
  it("polls payloads for the frame, memoized", () => {
    const fn = vi.fn((f) => (f.frame === 1 ? ["a"] : []));
    const e = new Events(fn);
    expect(e.poll(F(0))).toEqual([]);
    expect(e.poll(F(1))).toEqual(["a"]);
    expect(e.poll(F(1))).toEqual(["a"]);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("map transforms payloads", () => {
    const e = eventsOnFrames({ 2: [1, 2] }).map((v) => v * 10);
    expect(e.poll(F(2))).toEqual([10, 20]);
  });

  it("gate passes events only while the gate signal is open", () => {
    const open = new Signal((f) => f.frame >= 2);
    const e = eventsOnFrames({ 1: ["early"], 3: ["late"] }).gate(open);
    expect(e.poll(F(1))).toEqual([]);
    expect(e.poll(F(3))).toEqual(["late"]);
  });

  it("divide keeps every nth event", () => {
    const e = eventsOnFrames({ 0: ["a"], 1: ["b"], 2: ["c"], 3: ["d"], 4: ["e"] }).divide(2);
    const seen: string[] = [];
    for (const f of frames(5)) seen.push(...e.poll(f));
    expect(seen).toEqual(["a", "c", "e"]);
  });

  it("latch holds the most recent payload as a Signal", () => {
    const s = eventsOnFrames({ 1: [10], 3: [20, 30] }).latch(0);
    expect(s.get(F(0))).toBe(0);
    expect(s.get(F(1))).toBe(10);
    expect(s.get(F(2))).toBe(10);
    expect(s.get(F(3))).toBe(30);
  });

  it("quantize defers events to the next trigger frame", () => {
    const beats = eventsOnFrames<number>({ 2: [0], 5: [1] });
    const e = eventsOnFrames({ 1: ["x"], 3: ["y"], 4: ["z"] }).quantize(beats);
    const byFrame: Record<number, string[]> = {};
    for (const f of frames(6)) byFrame[f.frame] = [...e.poll(f)];
    expect(byFrame[1]).toEqual([]);
    expect(byFrame[2]).toEqual(["x"]);
    expect(byFrame[3]).toEqual([]);
    expect(byFrame[4]).toEqual([]);
    expect(byFrame[5]).toEqual(["y", "z"]);
  });

  it("an event landing on a trigger frame is delivered that frame", () => {
    const beats = eventsOnFrames<number>({ 2: [0] });
    const e = eventsOnFrames({ 2: ["same-frame"] }).quantize(beats);
    expect(e.poll(F(0))).toEqual([]);
    expect(e.poll(F(1))).toEqual([]);
    expect(e.poll(F(2))).toEqual(["same-frame"]);
  });
});
