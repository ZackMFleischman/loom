import { describe, expect, it } from "vitest";
import { Diagnostics } from "../src/diagnostics";
import { PerfEvents, PERF_SAMPLE_EVERY } from "../src/perf-events";
import type { SessionStore } from "../src/session";

function fakeSession(frameMsById: Record<string, number>): SessionStore {
  const entries = new Map(
    Object.entries(frameMsById).map(([id, frameMs]) => [
      id,
      { id, instance: { frameMs, slowSignals: () => [] } },
    ]),
  );
  return { entries } as unknown as SessionStore;
}

describe("PerfEvents", () => {
  it("emits an fps.low edge once, then fps.recovered once", () => {
    const d = new Diagnostics({ capacity: 64 });
    d.bind(() => 0, () => 0);
    let fps = 60;
    const session = fakeSession({});
    const perf = new PerfEvents(d, session, () => fps, () => "raf");

    perf.tick(1); // healthy → nothing
    fps = 40;
    perf.tick(2); // drop → one warn
    perf.tick(3); // still low → no duplicate
    fps = 59;
    perf.tick(4); // recovered → one info

    const kinds = d.tail(20).map((e) => e.kind);
    expect(kinds.filter((k) => k === "perf.fps.low")).toHaveLength(1);
    expect(kinds.filter((k) => k === "perf.fps.recovered")).toHaveLength(1);
  });

  it("emits a per-instance frameMs spike on the high-water crossing", () => {
    const d = new Diagnostics({ capacity: 64 });
    d.bind(() => 0, () => 0);
    const session = fakeSession({ "aurora-2": 40 }); // well over ~25 ms
    const perf = new PerfEvents(d, session, () => 60, () => "raf");
    perf.tick(1);
    const spike = d.tail(20).find((e) => e.kind === "perf.frame.spike");
    expect(spike?.instance).toBe("aurora-2");
    expect(perf.worstFrameMsRecent).toBeGreaterThanOrEqual(40);
  });

  it("emits a periodic perf.sample and resets the worst-frame window", () => {
    const d = new Diagnostics({ capacity: 64 });
    d.bind(() => 0, () => 0);
    const session = fakeSession({ a: 5 });
    const perf = new PerfEvents(d, session, () => 60, () => "raf");
    perf.tick(PERF_SAMPLE_EVERY); // a sample boundary
    const sample = d.tail(20).find((e) => e.kind === "perf.sample");
    expect(sample).toBeDefined();
    expect(sample?.data).toMatchObject({ fps: 60, clockSource: "raf" });
    expect(perf.worstFrameMsRecent).toBe(0); // window reset after the sample
  });

  it("does nothing when diagnostics are disabled", () => {
    const d = new Diagnostics({ enabled: false });
    d.bind(() => 0, () => 0);
    const perf = new PerfEvents(d, fakeSession({ a: 99 }), () => 10, () => "raf");
    perf.tick(PERF_SAMPLE_EVERY);
    expect(d.total).toBe(0);
  });
});
