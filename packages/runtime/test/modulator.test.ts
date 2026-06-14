import { afterEach, describe, expect, it, vi } from "vitest";
import { Events } from "../src/events";
import type { AudioBusLike } from "../src/inputbus/audio";
import { createModulator, ModulatorSpec, type ModulatorBus } from "../src/modulator";
import { Signal } from "../src/signal";
import { F, frames } from "./helpers";

const FLOAT01 = { type: "float" as const, min: 0, max: 1, value: 0.5 };
const bus = (bpm = 120, audio?: AudioBusLike): ModulatorBus => ({ bpm: () => bpm, audio });
const make = (spec: unknown, param = FLOAT01 as Parameters<typeof createModulator>[1], b: ModulatorBus = bus()) =>
  createModulator(ModulatorSpec.parse(spec), param, b);
const run = (fn: ReturnType<typeof make>, n: number, dt = 1 / 60) =>
  frames(n, dt).map((f) => fn(f));

afterEach(() => vi.restoreAllMocks());

describe("spec validation", () => {
  it("rejects unknown keys and unknown types", () => {
    expect(() => ModulatorSpec.parse({ type: "sine", periodSeconds: 1, duty: 0.5 })).toThrow();
    expect(() => ModulatorSpec.parse({ type: "wobble" })).toThrow();
  });
  it("requires exactly one of periodSeconds/periodBeats on clocked types", () => {
    expect(() => make({ type: "sine" })).toThrow(/exactly one/);
    expect(() => make({ type: "sine", periodSeconds: 1, periodBeats: 4 })).toThrow(/exactly one/);
  });
  it("audio takes no period (strict schema rejects it)", () => {
    expect(() => ModulatorSpec.parse({ type: "audio", periodSeconds: 1 })).toThrow();
  });
  it("enforces min <= lo <= hi <= max (FR-6)", () => {
    expect(() => make({ type: "sine", periodSeconds: 1, lo: -0.1 })).toThrow(/min . lo . hi . max/);
    expect(() => make({ type: "sine", periodSeconds: 1, lo: 0.8, hi: 0.4 })).toThrow();
    expect(() => make({ type: "sine", periodSeconds: 1, hi: 1.5 })).toThrow();
  });
  it("restricts bool params to square/random/cycle, without lo/hi", () => {
    const boolParam = { type: "bool" as const, value: false };
    expect(() => make({ type: "sine", periodSeconds: 1 }, boolParam)).toThrow(/bool/);
    expect(() => make({ type: "square", periodSeconds: 1, lo: 0 }, boolParam)).toThrow(/lo\/hi/);
    expect(() => make({ type: "square", periodSeconds: 1 }, boolParam)).not.toThrow();
  });
  it("cycle on float requires an explicit values list, validated against the range", () => {
    expect(() => make({ type: "cycle", periodSeconds: 1 })).toThrow(/values/);
    expect(() => make({ type: "cycle", periodSeconds: 1, values: [0.2, 9] })).toThrow(/outside/);
  });
});

describe("clocked carriers", () => {
  it("sine bounces lo..hi (lo at phase 0, hi at half period)", () => {
    const v = run(make({ type: "sine", periodSeconds: 1, lo: 0.5, hi: 0.9 }), 31) as number[];
    expect(v[0]).toBeCloseTo(0.5, 6);
    expect(v[15]).toBeCloseTo(0.7, 6);
    expect(v[30]).toBeCloseTo(0.9, 6);
  });
  it("triangle is linear", () => {
    const v = run(make({ type: "triangle", periodSeconds: 1 }), 31) as number[];
    expect(v[15]).toBeCloseTo(0.5, 6);
    expect(v[30]).toBeCloseTo(1, 6);
  });
  it("ramp rises (up) or falls (down)", () => {
    const up = run(make({ type: "ramp", periodSeconds: 1 }), 20) as number[];
    expect(up[10]!).toBeGreaterThan(up[1]!);
    const dn = run(make({ type: "ramp", periodSeconds: 1, direction: "down" }), 20) as number[];
    expect(dn[10]!).toBeLessThan(dn[1]!);
  });
  it("square alternates hi/lo by duty; bool variant returns booleans", () => {
    const v = run(make({ type: "square", periodSeconds: 1, duty: 0.25 }), 31) as number[];
    expect(v[5]).toBe(1);
    expect(v[20]).toBe(0);
    const b = run(
      make({ type: "square", periodSeconds: 1, duty: 0.5 }, { type: "bool", value: false }),
      40,
    ) as boolean[];
    expect(b[5]).toBe(true);
    expect(b[35]).toBe(false);
  });
  it("phase offset shifts the start", () => {
    const fn = make({ type: "sine", periodSeconds: 1, phase: 0.5 });
    expect(fn(F(0))).toBeCloseTo(1, 6);
  });
  it("periodBeats follows live BPM changes (FR-5)", () => {
    let bpm = 120;
    const fn = make({ type: "sine", periodBeats: 1 }, FLOAT01, { bpm: () => bpm });
    const fs = frames(80, 0.01);
    const v: number[] = [];
    for (let i = 0; i < 50; i++) v.push(fn(fs[i]!) as number); // 0.5 s period
    expect(v[25]).toBeCloseTo(1, 6);
    bpm = 240; // period halves to 0.25 s
    for (let i = 50; i < 80; i++) v.push(fn(fs[i]!) as number);
    expect(v[50]).toBeCloseTo(0, 6); // exactly one full cycle behind it
    expect(v[75]).toBeCloseTo(0, 6); // one further full cycle in 25 steps at 240 bpm
  });
  it("pauses without catch-up: phase advances only when evaluated (FR-10)", () => {
    const fn = make({ type: "sine", periodSeconds: 1 });
    for (const f of frames(30)) fn(f); // 0.5 s in
    // wall clock jumps 500 s; next evaluation advances by one dt only
    expect(fn(F(1000, 500, 1 / 60))).toBeCloseTo(1, 3);
  });
});

describe("interval modulators", () => {
  it("random samples-and-holds per interval", () => {
    const r = vi.spyOn(Math, "random").mockReturnValueOnce(0.25).mockReturnValueOnce(0.75);
    const v = run(make({ type: "random", periodSeconds: 1 }), 61) as number[];
    expect(v[0]).toBeCloseTo(0.25, 6);
    expect(v[59]).toBeCloseTo(0.25, 6);
    expect(v[60]).toBeCloseTo(0.75, 6);
    expect(r).toHaveBeenCalledTimes(2);
  });
  it("random on bool flips a coin per interval", () => {
    vi.spyOn(Math, "random").mockReturnValueOnce(0.2).mockReturnValueOnce(0.8);
    const fn = make({ type: "random", periodSeconds: 1 }, { type: "bool", value: false });
    const fs = frames(61);
    expect(fn(fs[0]!)).toBe(true);
    for (const f of fs.slice(1, 60)) fn(f);
    expect(fn(fs[60]!)).toBe(false);
  });
  it("drift starts at the current value and chases random targets", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.1);
    const fn = make({ type: "drift", periodSeconds: 1, smooth: 0.001 }, { ...FLOAT01, value: 0.9 });
    const v = run(fn, 10) as number[];
    expect(v[0]!).toBeLessThan(0.9); // already moving toward 0.1
    expect(v[9]).toBeCloseTo(0.1, 2);
  });
  it("cycle steps int ranges in every order", () => {
    const intP = { type: "int" as const, min: 0, max: 10, value: 0 };
    const seq = (spec: object) =>
      run(make({ ...spec, periodSeconds: 1, lo: 0, hi: 3 }, intP), 10, 0.5) as number[];
    expect(seq({ type: "cycle" })).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 0, 0]);
    expect(seq({ type: "cycle", order: "reverse" })).toEqual([3, 3, 2, 2, 1, 1, 0, 0, 3, 3]);
    expect(seq({ type: "cycle", order: "pingpong" })).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 2, 2]);
  });
  it("cycle uses explicit values for floats (and ints when given)", () => {
    const v = run(make({ type: "cycle", periodSeconds: 1, values: [0.1, 0.5, 0.9] }), 8, 0.5) as number[];
    expect(v).toEqual([0.1, 0.1, 0.5, 0.5, 0.9, 0.9, 0.1, 0.1]);
    const intP = { type: "int" as const, min: 0, max: 64, value: 4 };
    const s = run(make({ type: "cycle", periodSeconds: 1, values: [4, 8, 16, 32] }, intP), 8, 1) as number[];
    expect(s).toEqual([4, 8, 16, 32, 4, 8, 16, 32]);
  });
  it("cycle toggles bools", () => {
    const b = run(make({ type: "cycle", periodSeconds: 1 }, { type: "bool", value: false }), 4, 1) as boolean[];
    expect(b).toEqual([false, true, false, true]);
  });
});

describe("audio follower", () => {
  const fakeAudio: AudioBusLike = {
    rms: new Signal(() => 0.5),
    band: (name) => new Signal(() => (name === "bass" ? 0.25 : 0)),
    onset: () => new Events(() => []),
  };
  it("maps a band into lo..hi (smooth 0 = passthrough)", () => {
    const fn = make({ type: "audio", band: "bass", smooth: 0 }, FLOAT01, bus(120, fakeAudio));
    expect(fn(F(0))).toBeCloseTo(0.25, 6);
    const rms = make({ type: "audio", smooth: 0, lo: 0.2, hi: 0.6 }, FLOAT01, bus(120, fakeAudio));
    expect(rms(F(1))).toBeCloseTo(0.4, 6);
  });
  it("requires an audio bus", () => {
    expect(() => make({ type: "audio" }, FLOAT01, bus(120))).toThrow(/audio bus/);
  });
});
