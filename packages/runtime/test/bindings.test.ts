import { describe, expect, it } from "vitest";
import { BindingStore } from "../src/bindings";
import { Manifest } from "../src/param";

describe("Param.setNormalized", () => {
  it("maps 0..1 onto a float's range", () => {
    const m = new Manifest();
    const p = m.float("punch", { default: 1.2, min: 0, max: 3 });
    p.setNormalized(0.5);
    expect(p.value).toBeCloseTo(1.5);
    p.setNormalized(1);
    expect(p.value).toBe(3);
    p.setNormalized(0);
    expect(p.value).toBe(0);
  });

  it("rounds ints", () => {
    const m = new Manifest();
    const p = m.int("steps", { default: 2, min: 0, max: 9 });
    p.setNormalized(0.5);
    expect(p.value).toBe(5);
  });

  it("treats >= 0.5 as true for bools", () => {
    const m = new Manifest();
    const p = m.bool("on", { default: false });
    p.setNormalized(0.7);
    expect(p.value).toBe(true);
    p.setNormalized(0.2);
    expect(p.value).toBe(false);
  });
});

describe("Param.cycle", () => {
  it("advances an int and wraps max back to min", () => {
    const m = new Manifest();
    const p = m.int("source", { default: 2, min: 1, max: 3 });
    p.cycle();
    expect(p.value).toBe(3);
    p.cycle();
    expect(p.value).toBe(1); // wrap to min
  });

  it("flips bools", () => {
    const m = new Manifest();
    const p = m.bool("on", { default: false });
    p.cycle();
    expect(p.value).toBe(true);
    p.cycle();
    expect(p.value).toBe(false);
  });

  it("holds floats (cycle has no honest float semantics)", () => {
    const m = new Manifest();
    const p = m.float("punch", { default: 1.2, min: 0, max: 3 });
    p.cycle();
    expect(p.value).toBe(1.2);
  });

  it("holds colors (cycle has no honest color semantics)", () => {
    const m = new Manifest();
    const p = m.color("tint", { default: "#ff0000" });
    p.cycle();
    expect(p.value).toBe("#ff0000");
  });
});

describe("Manifest.values", () => {
  it("serializes current values flat (for tuned-state persistence)", () => {
    const m = new Manifest();
    m.float("a", { default: 0.5, min: 0, max: 1 });
    m.bool("b", { default: true });
    m.get("a")!.set(0.25);
    expect(m.values()).toEqual({ a: 0.25, b: true });
  });
});

describe("BindingStore", () => {
  function recorder() {
    const writes: unknown[] = [];
    const sets: unknown[] = [];
    const cycles: unknown[] = [];
    const ops = {
      write: (s: string, p: string, v: number) => void writes.push([s, p, v]),
      setValue: (s: string, p: string, v: number | undefined) => void sets.push([s, p, v]),
      cycle: (s: string, p: string) => void cycles.push([s, p]),
    };
    return { ops, writes, sets, cycles };
  }

  it("learn arms a target; the next CC becomes its binding", () => {
    const store = new BindingStore();
    store.startLearn({ scene: "pulse", path: "punch" });
    expect(store.learning).toEqual({ scene: "pulse", path: "punch", mode: "absolute" });
    const r = recorder();
    const res = store.handleCc({ cc: 21, ch: 0, value: 0.5 }, r.ops);
    expect(res.learned).toEqual({ cc: 21, ch: 0, scene: "pulse", path: "punch", mode: "absolute" });
    expect(store.learning).toBeNull();
    expect(store.bindings).toHaveLength(1);
    // the learning gesture itself also applies, so the knob takes effect at once
    expect(r.writes).toEqual([["pulse", "punch", 0.5]]);
  });

  it("re-learning a target replaces its previous binding", () => {
    const store = new BindingStore();
    store.startLearn({ scene: "pulse", path: "punch" });
    store.handleCc({ cc: 21, ch: 0, value: 0 }, recorder().ops);
    store.startLearn({ scene: "pulse", path: "punch" });
    store.handleCc({ cc: 40, ch: 1, value: 0 }, recorder().ops);
    expect(store.bindings).toEqual([{ cc: 40, ch: 1, scene: "pulse", path: "punch", mode: "absolute" }]);
  });

  it("applies CC values to every matching binding only", () => {
    const store = new BindingStore();
    store.load([
      { cc: 21, ch: 0, scene: "pulse", path: "punch" },
      { cc: 21, ch: null, scene: "globals", path: "inputs.kick.threshold" },
      { cc: 22, ch: 0, scene: "pulse", path: "trail" },
    ]);
    const r = recorder();
    store.handleCc({ cc: 21, ch: 0, value: 0.75 }, r.ops);
    expect(r.writes).toEqual([
      ["pulse", "punch", 0.75],
      ["globals", "inputs.kick.threshold", 0.75],
    ]);
    // ch-bound binding does not fire for another channel; ch:null does
    const r2 = recorder();
    store.handleCc({ cc: 21, ch: 3, value: 0.1 }, r2.ops);
    expect(r2.writes).toEqual([["globals", "inputs.kick.threshold", 0.1]]);
  });

  it("startLearn on the already-learning target cancels (toggle)", () => {
    const store = new BindingStore();
    store.startLearn({ scene: "pulse", path: "punch" });
    store.startLearn({ scene: "pulse", path: "punch" });
    expect(store.learning).toBeNull();
  });

  it("startLearn toggle-cancels only the exact same target (mode+value included)", () => {
    const store = new BindingStore();
    store.startLearn({ scene: "lava", path: "palette.source", mode: "set", value: 0 });
    store.startLearn({ scene: "lava", path: "palette.source", mode: "set", value: 1 }); // re-arm, not cancel
    expect(store.learning).toEqual({ scene: "lava", path: "palette.source", mode: "set", value: 1 });
    store.startLearn({ scene: "lava", path: "palette.source", mode: "set", value: 1 }); // exact repeat = cancel
    expect(store.learning).toBeNull();
  });

  it("unbind removes a target's bindings", () => {
    const store = new BindingStore();
    store.load([
      { cc: 21, ch: 0, scene: "pulse", path: "punch" },
      { cc: 22, ch: 0, scene: "pulse", path: "trail" },
    ]);
    expect(store.unbind({ scene: "pulse", path: "punch" })).toBe(true);
    expect(store.bindings).toEqual([{ cc: 22, ch: 0, scene: "pulse", path: "trail", mode: "absolute" }]);
    expect(store.unbind({ scene: "pulse", path: "punch" })).toBe(false);
  });

  it("unbind scopes: value → one radio option; mode → that mode; bare → everything", () => {
    const store = new BindingStore();
    const all = [
      { cc: 32, ch: 0, scene: "lava", path: "palette.source", mode: "set", value: 0 },
      { cc: 33, ch: 0, scene: "lava", path: "palette.source", mode: "set", value: 1 },
      { cc: 16, ch: 0, scene: "lava", path: "palette.source", mode: "absolute" },
    ];
    store.load(all);
    expect(store.unbind({ scene: "lava", path: "palette.source", value: 1 })).toBe(true);
    expect(store.bindings.map((b) => b.cc)).toEqual([32, 16]);
    expect(store.unbind({ scene: "lava", path: "palette.source", mode: "absolute" })).toBe(true);
    expect(store.bindings.map((b) => b.cc)).toEqual([32]);
    store.load(all);
    expect(store.unbind({ scene: "lava", path: "palette.source" })).toBe(true);
    expect(store.bindings).toEqual([]);
  });

  it("set/cycle fire on rising edges only — release and repeats are inert", () => {
    const store = new BindingStore();
    store.load([
      { cc: 32, ch: 0, scene: "lava", path: "palette.source", mode: "set", value: 1 },
      { cc: 33, ch: 0, scene: "globals", path: "inputs.kick.enabled", mode: "cycle" },
    ]);
    const r = recorder();
    store.handleCc({ cc: 32, ch: 0, value: 1 }, r.ops); // press
    store.handleCc({ cc: 32, ch: 0, value: 0 }, r.ops); // release
    store.handleCc({ cc: 32, ch: 0, value: 1 }, r.ops); // press again
    expect(r.sets).toEqual([
      ["lava", "palette.source", 1],
      ["lava", "palette.source", 1],
    ]);
    store.handleCc({ cc: 33, ch: 0, value: 1 }, r.ops);
    store.handleCc({ cc: 33, ch: 0, value: 0 }, r.ops);
    expect(r.cycles).toEqual([["globals", "inputs.kick.enabled"]]);
    expect(r.writes).toEqual([]); // button modes never write normalized values
  });

  it("tracks edges per (ch, cc): same cc on another channel has its own edge", () => {
    const store = new BindingStore();
    store.load([{ cc: 32, ch: null, scene: "lava", path: "palette.source", mode: "set", value: 2 }]);
    const r = recorder();
    store.handleCc({ cc: 32, ch: 0, value: 1 }, r.ops);
    store.handleCc({ cc: 32, ch: 1, value: 1 }, r.ops); // fresh edge on ch 1
    expect(r.sets).toHaveLength(2);
  });

  it("learning a set binding accumulates a radio group; same value replaces", () => {
    const store = new BindingStore();
    const r = recorder();
    store.startLearn({ scene: "lava", path: "palette.source", mode: "set", value: 0 });
    store.handleCc({ cc: 32, ch: 0, value: 1 }, r.ops);
    store.handleCc({ cc: 32, ch: 0, value: 0 }, r.ops);
    store.startLearn({ scene: "lava", path: "palette.source", mode: "set", value: 1 });
    store.handleCc({ cc: 33, ch: 0, value: 1 }, r.ops);
    store.handleCc({ cc: 33, ch: 0, value: 0 }, r.ops);
    store.startLearn({ scene: "lava", path: "palette.source", mode: "set", value: 1 }); // re-learn option 1
    store.handleCc({ cc: 34, ch: 0, value: 1 }, r.ops);
    expect(store.bindings).toEqual([
      { cc: 32, ch: 0, scene: "lava", path: "palette.source", mode: "set", value: 0 },
      { cc: 34, ch: 0, scene: "lava", path: "palette.source", mode: "set", value: 1 },
    ]);
  });

  it("learning absolute/cycle replaces non-set bindings but leaves the radio group", () => {
    const store = new BindingStore();
    store.load([
      { cc: 32, ch: 0, scene: "lava", path: "palette.source", mode: "set", value: 0 },
      { cc: 16, ch: 0, scene: "lava", path: "palette.source" }, // absolute knob
    ]);
    store.startLearn({ scene: "lava", path: "palette.source", mode: "cycle" });
    const r = recorder();
    store.handleCc({ cc: 40, ch: 0, value: 1 }, r.ops);
    expect(store.bindings).toEqual([
      { cc: 32, ch: 0, scene: "lava", path: "palette.source", mode: "set", value: 0 },
      { cc: 40, ch: 0, scene: "lava", path: "palette.source", mode: "cycle" },
    ]);
  });

  it("a button-mode learn completes on the rising edge, not on a release", () => {
    const store = new BindingStore();
    store.startLearn({ scene: "lava", path: "palette.source", mode: "cycle" });
    const r = recorder();
    store.handleCc({ cc: 40, ch: 0, value: 0 }, r.ops); // stray release: still armed
    expect(store.learning).not.toBeNull();
    store.handleCc({ cc: 40, ch: 0, value: 1 }, r.ops);
    expect(store.learning).toBeNull();
    expect(store.bindings).toHaveLength(1);
  });

  it("round-trips through JSON, defaults mode, and ignores malformed entries", () => {
    const store = new BindingStore();
    store.load([
      { cc: 21, ch: 0, scene: "pulse", path: "punch" }, // pre-mode file entry
      { cc: 32, ch: 0, scene: "lava", path: "palette.source", mode: "set", value: 1 },
      { cc: 33, ch: null, scene: "globals", path: "inputs.kick.enabled", mode: "cycle" },
      { nope: true },
      "garbage",
    ]);
    expect(store.bindings).toEqual([
      { cc: 21, ch: 0, scene: "pulse", path: "punch", mode: "absolute" },
      { cc: 32, ch: 0, scene: "lava", path: "palette.source", mode: "set", value: 1 },
      { cc: 33, ch: null, scene: "globals", path: "inputs.kick.enabled", mode: "cycle" },
    ]);
    expect(JSON.parse(JSON.stringify(store.toJSON()))).toEqual(store.bindings);
  });
});
