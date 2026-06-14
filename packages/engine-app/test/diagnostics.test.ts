import { describe, expect, it } from "vitest";
import { Diagnostics, diagOptionsFromQuery } from "../src/diagnostics";

describe("Diagnostics ring", () => {
  it("stamps seq/frame/t and returns the recent tail", () => {
    const d = new Diagnostics({ capacity: 8 });
    let frame = 0;
    d.bind(() => frame, () => 60);
    frame = 100;
    d.push({ level: "info", kind: "scene.swapped", instance: "boot", msg: "a" });
    frame = 101;
    d.push({ level: "error", kind: "scene.rejected", instance: "boot", msg: "b", data: { error: "boom" } });

    const tail = d.tail(10);
    expect(tail.map((e) => e.seq)).toEqual([0, 1]);
    expect(tail[0]).toMatchObject({ frame: 100, kind: "scene.swapped", instance: "boot" });
    expect(tail[1]).toMatchObject({ frame: 101, kind: "scene.rejected", data: { error: "boom" } });
    expect(typeof tail[0]!.t).toBe("number");
  });

  it("evicts oldest events and reports `dropped` against a stale cursor", () => {
    const d = new Diagnostics({ capacity: 4 });
    d.bind(() => 0, () => 0);
    for (let i = 0; i < 10; i++) d.push({ level: "info", kind: "k", msg: `m${i}` });
    // Only the last 4 (seq 6..9) survive. An agent paged up to seq 1 missed 6..5.
    const q = d.query({ since: 1 });
    expect(q.events.map((e) => e.seq)).toEqual([6, 7, 8, 9]);
    // oldest surviving seq is 6; gap from cursor 1 → events 2..5 dropped = 4.
    expect(q.dropped).toBe(4);
    // query()'s `now` carries frame + fps; the seq cursor is added by the handler.
    expect(q.now).toHaveProperty("frame");
    expect(q.now).toHaveProperty("fps");
  });

  it("pages forward with `since` (strictly greater)", () => {
    const d = new Diagnostics({ capacity: 16 });
    d.bind(() => 0, () => 0);
    for (let i = 0; i < 5; i++) d.push({ level: "info", kind: "k", msg: `m${i}` });
    expect(d.query({ since: 2 }).events.map((e) => e.seq)).toEqual([3, 4]);
    expect(d.query({ since: 4 }).events).toEqual([]);
  });

  it("filters by kind, instance, level, and limit", () => {
    const d = new Diagnostics({ capacity: 16 });
    d.bind(() => 0, () => 0);
    d.push({ level: "info", kind: "scene.swapped", instance: "a", msg: "1" });
    d.push({ level: "error", kind: "scene.rejected", instance: "a", msg: "2" });
    d.push({ level: "warn", kind: "perf.fps.low", instance: "b", msg: "3" });
    d.push({ level: "error", kind: "instance.frozen", instance: "b", msg: "4" });

    expect(d.query({ kinds: ["scene.rejected"] }).events.map((e) => e.msg)).toEqual(["2"]);
    expect(d.query({ instance: "b" }).events.map((e) => e.msg)).toEqual(["3", "4"]);
    expect(d.query({ level: "error" }).events.map((e) => e.msg)).toEqual(["2", "4"]);
    expect(d.query({ level: "warn" }).events.map((e) => e.msg)).toEqual(["2", "3", "4"]);
    expect(d.query({ limit: 1 }).events.map((e) => e.msg)).toEqual(["4"]); // newest kept
  });

  it("is a no-op (and never throws) when disabled via ?diag=0", () => {
    const d = new Diagnostics({ enabled: false });
    d.bind(() => 0, () => 0);
    d.push({ level: "info", kind: "k", msg: "m" });
    expect(d.enabled).toBe(false);
    expect(d.total).toBe(0);
    expect(d.query().events).toEqual([]);
  });

  it("never throws into the caller even if the frame stamper throws (NFR-1)", () => {
    const d = new Diagnostics({ capacity: 4 });
    d.bind(() => {
      throw new Error("stamper blew up");
    }, () => 0);
    expect(() => d.push({ level: "info", kind: "k", msg: "m" })).not.toThrow();
  });

  it("parses the ?diag= query knob", () => {
    expect(diagOptionsFromQuery("0")).toEqual({ enabled: false });
    expect(diagOptionsFromQuery("256")).toEqual({ capacity: 256 });
    expect(diagOptionsFromQuery(null)).toEqual({});
    expect(diagOptionsFromQuery("1")).toEqual({}); // too small → default
    expect(diagOptionsFromQuery("garbage")).toEqual({});
  });
});
