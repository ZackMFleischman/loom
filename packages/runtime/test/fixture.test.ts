import { describe, expect, it } from "vitest";
import { FixtureDataSchema, FixturePlayer } from "../src/fixture";

const f = (frame: number) => ({ frame, now: frame / 60, dt: 1 / 60 });

const trace = {
  name: "t",
  bpm: 120,
  channels: ["kick", "bass"],
  frames: [
    [1, 0.1],
    [0, 0.2],
    [0.5, 0.3],
  ],
};

describe("FixturePlayer", () => {
  it("replays channel values by frame index", () => {
    const p = new FixturePlayer(trace);
    const kick = p.signal("kick");
    const bass = p.signal("bass");
    expect(kick.get(f(0))).toBe(1);
    expect(bass.get(f(1))).toBe(0.2);
    expect(kick.get(f(2))).toBe(0.5);
  });

  it("loops past the end of the trace", () => {
    const p = new FixturePlayer(trace);
    const kick = p.signal("kick");
    expect(kick.get(f(3))).toBe(1);
    expect(kick.get(f(7))).toBe(0); // 7 % 3 = 1
  });

  it("anchors at the base frame (live-loop creation time)", () => {
    const p = new FixturePlayer(trace, 100);
    const kick = p.signal("kick");
    expect(kick.get(f(100))).toBe(1);
    expect(kick.get(f(102))).toBe(0.5);
  });

  it("unknown channels read 0 (never throw mid-set)", () => {
    const p = new FixturePlayer(trace);
    expect(p.signal("nope").get(f(0))).toBe(0);
  });

  it("the schema rejects empty traces", () => {
    expect(FixtureDataSchema.safeParse({ name: "x", bpm: 120, channels: [], frames: [] }).success).toBe(false);
    expect(FixtureDataSchema.safeParse(trace).success).toBe(true);
  });

  it("replays bit-identically: two players over the same trace agree everywhere", () => {
    const a = new FixturePlayer(trace);
    const b = new FixturePlayer(trace);
    for (let i = 0; i < 9; i++) {
      expect(a.signal("kick").get(f(i))).toBe(b.signal("kick").get(f(i)));
      expect(a.signal("bass").get(f(i))).toBe(b.signal("bass").get(f(i)));
    }
  });
});
