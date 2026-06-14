import type { FrameCtx } from "@loom/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DebugSurface, type DebugSurfaceDeps, type LoomDebug } from "../src/debug-surface";

/** A fake session entry shaped like the DebugSurface instances mapper expects. */
function entry(id: string, opts: { error?: unknown } = {}) {
  return {
    id,
    sceneName: `${id}-scene`,
    builds: 1,
    pinned: undefined,
    instance: { error: opts.error ?? null, slowSignals: () => [] },
    modulators: { list: () => [] },
    chain: { list: () => [] },
    lastUpdateRejected: false,
  };
}

function harness(opts: { entries?: ReturnType<typeof entry>[]; live?: string | null } = {}) {
  const entries = new Map((opts.entries ?? [entry("boot")]).map((e) => [e.id, e]));
  const inputsVals = { kick: 0.1 };
  const paletteVals = { "palette.primary.0": "#fff" };
  let agent = false;
  const deps = {
    audio: { mode: "test", rms: { get: () => 0.5 }, resume: vi.fn() },
    timeBus: { bpm: 120 },
    fps: { current: 60 },
    stage: { live: opts.live ?? "boot", staged: null, panicked: false, panicActive: null },
    session: { entries, get: (id: string) => entries.get(id) },
    inputs: { values: () => inputsVals },
    palettes: { manifest: { values: () => paletteVals } },
    midi: { inject: vi.fn() },
    panicInfo: () => ({ name: "panic", status: "ok" as const, error: null }),
    armed: () => ({ panicMode: "hold" as const, agentCommitArmed: agent }),
  } as unknown as DebugSurfaceDeps;
  const surface = new DebugSurface(deps);
  return { surface, setAgent: (v: boolean) => (agent = v) };
}

const frame = (n: number): FrameCtx => ({ frame: n, now: n / 60, dt: 1 / 60 });
const loom = () => (globalThis as { window: { __loom?: LoomDebug } }).window.__loom!;

beforeEach(() => {
  vi.stubGlobal("window", {} as Window);
  vi.stubGlobal("document", { hidden: false });
});
afterEach(() => vi.unstubAllGlobals());

describe("DebugSurface install", () => {
  it("installs window.__loom with the initial panic info + live hooks", () => {
    const { surface } = harness();
    expect(loom()).toBeDefined();
    expect(loom().panicScene).toEqual({ name: "panic", status: "ok", error: null });
    expect(loom().instances).toEqual([]);
    expect(typeof loom().resumeAudio).toBe("function");
    void surface; // construction is the assertion
  });
});

describe("DebugSurface.update scalars", () => {
  it("refreshes cheap scalar fields every frame", () => {
    const { surface, setAgent } = harness({ live: "boot" });
    surface.update(frame(7), { onsetCount: 3, currentMix: 0.25 });
    expect(loom().frame).toBe(7);
    expect(loom().rms).toBe(0.5);
    expect(loom().onsetCount).toBe(3);
    expect(loom().mix).toBe(0.25);
    expect(loom().live).toBe("boot");
    expect(loom().inputs).toEqual({ kick: 0.1 });
    expect(loom().agentCommitArmed).toBe(false);
    setAgent(true);
    surface.update(frame(8), { onsetCount: 3, currentMix: null });
    expect(loom().frame).toBe(8);
    expect(loom().agentCommitArmed).toBe(true); // armed flag is per-frame, not throttled
  });

  it("surfaces a frozen live instance's error", () => {
    const { surface } = harness({ entries: [entry("boot", { error: new Error("boom") })], live: "boot" });
    surface.update(frame(1), { onsetCount: 0, currentMix: null });
    expect(loom().instanceError).toContain("boom");
  });
});

describe("DebugSurface.update instances throttle", () => {
  it("rebuilds the instances array on frame 0 then only every 6th update", () => {
    const { surface } = harness({ entries: [entry("boot"), entry("pulse-1")] });
    surface.update(frame(0), { onsetCount: 0, currentMix: null });
    const built = loom().instances;
    expect(built.map((i) => i.id)).toEqual(["boot", "pulse-1"]);
    // Updates 1..5 keep the SAME array reference (no rebuild, no allocation).
    for (let i = 1; i < 6; i++) {
      surface.update(frame(i), { onsetCount: 0, currentMix: null });
      expect(loom().instances).toBe(built);
    }
    // The 6th update (call index 6) rebuilds → a fresh reference.
    surface.update(frame(6), { onsetCount: 0, currentMix: null });
    expect(loom().instances).not.toBe(built);
    expect(loom().instances.map((i) => i.id)).toEqual(["boot", "pulse-1"]);
  });
});
