import { describe, expect, it } from "vitest";
import { ToolMetrics } from "../src/metrics";

describe("ToolMetrics", () => {
  it("counts calls per tool and folds batch sub-calls", () => {
    const m = new ToolMetrics();
    m.record("set_param", { path: "a", value: 1 });
    m.record("set_params", { values: { a: 1, b: 2 } });
    m.record("batch", { calls: [{ tool: "set_params" }, { tool: "screenshot" }, { tool: "get_session" }] });
    m.record("batch", { calls: [{ tool: "set_param" }] });

    const s = m.summary();
    expect(s.total).toBe(4);
    expect(s.set_param).toBe(1);
    expect(s.set_params).toBe(1);
    expect(s.batch).toBe(2);
    expect(s.batchedCalls).toBe(4); // 3 + 1
    expect(s.avgBatchSize).toBe(2); // (3 + 1) / 2
  });

  it("flags consecutive same-instance set_param runs as missed set_params folds", () => {
    const m = new ToolMetrics();
    // Three set_param to "live" in a row: the 2nd and 3rd could have folded → 2 missed.
    m.record("set_param", { path: "a", value: 1 }); // instance defaults to "live"
    m.record("set_param", { path: "b", value: 2 });
    m.record("set_param", { path: "c", value: 3 });
    expect(m.summary().missedBatchable).toBe(2);
  });

  it("does not count an isolated set_param, and a different tool breaks the run", () => {
    const m = new ToolMetrics();
    m.record("set_param", { path: "a", value: 1 });
    m.record("screenshot", {}); // breaks the run
    m.record("set_param", { path: "b", value: 2 }); // fresh run, not a miss
    expect(m.summary().missedBatchable).toBe(0);
  });

  it("treats a different instance as a fresh run, not a fold", () => {
    const m = new ToolMetrics();
    m.record("set_param", { instance: "boot", path: "a", value: 1 });
    m.record("set_param", { instance: "sandbox", path: "a", value: 1 }); // different instance
    m.record("set_param", { instance: "sandbox", path: "b", value: 2 }); // same as previous → 1 miss
    expect(m.summary().missedBatchable).toBe(1);
  });
});
