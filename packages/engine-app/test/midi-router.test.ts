import type { BindingOps, CcEvent } from "@loom/runtime";
import { describe, expect, it, vi } from "vitest";
import { MidiRouter, type MidiRouterDeps } from "../src/midi-router";

/** A param that records which mutation was applied. */
function fakeParam() {
  return {
    setNormalized: vi.fn(),
    set: vi.fn(),
    cycle: vi.fn(),
  };
}

type FakeParam = ReturnType<typeof fakeParam>;

/** Build a MidiRouter over fakes; returns the router plus the handles to assert on. */
function harness(opts: {
  rack?: Record<string, FakeParam>;
  palette?: Record<string, FakeParam>;
  entries?: Array<{ sceneName: string; params?: Record<string, FakeParam>; modulators?: object }>;
}) {
  const rack = opts.rack ?? {};
  const palette = opts.palette ?? {};
  const entries = (opts.entries ?? []).map((e) => ({
    sceneName: e.sceneName,
    instance: { manifest: { get: (p: string) => e.params?.[p] } },
    modulators: e.modulators ?? {},
  }));
  const persist = {
    globals: vi.fn(),
    palettes: vi.fn(),
    scene: vi.fn(),
    bindings: vi.fn(),
  };
  // Capture the CC handler start() registers; capture the BindingOps each CC drives.
  let ccHandler: ((e: CcEvent) => void) | undefined;
  const handleCc = vi.fn((_e: CcEvent, _ops: BindingOps) => ({ learned: false }));
  const globalsModulators = {
    toggleEnabled: vi.fn(),
    setEnabled: vi.fn(),
    get: vi.fn(() => ({})),
  };
  const deps = {
    midi: { onCc: (h: (e: CcEvent) => void) => (ccHandler = h) },
    session: { entries: { values: () => entries.values() } },
    inputs: { manifest: { get: (p: string) => rack[p] } },
    palettes: { manifest: { get: (p: string) => palette[p] } },
    globalsModulators,
    bindings: { handleCc },
    persist,
  } as unknown as MidiRouterDeps;
  const router = new MidiRouter(deps);
  return { router, persist, globalsModulators, handleCc, fire: (e: CcEvent) => ccHandler?.(e), start: () => router.start() };
}

describe("MidiRouter.writeParam", () => {
  it("routes a globals rack path to the input manifest and persists globals", () => {
    const knob = fakeParam();
    const { router, persist } = harness({ rack: { "inputs.kick.threshold": knob } });
    router.writeParam("globals", "inputs.kick.threshold", (p) => p.set(0.4));
    expect(knob.set).toHaveBeenCalledWith(0.4);
    expect(persist.globals).toHaveBeenCalledTimes(1);
    expect(persist.palettes).not.toHaveBeenCalled();
  });

  it("routes a globals palette path to the palette manifest and persists palettes", () => {
    const stop = fakeParam();
    const { router, persist } = harness({ palette: { "palette.primary.0": stop } });
    router.writeParam("globals", "palette.primary.0", (p) => p.set("#ff0000"));
    expect(stop.set).toHaveBeenCalledWith("#ff0000");
    expect(persist.palettes).toHaveBeenCalledTimes(1);
    expect(persist.globals).not.toHaveBeenCalled();
  });

  it("writes every matching instance of the scene and persists once; leaves other scenes alone", () => {
    const a = fakeParam();
    const b = fakeParam();
    const other = fakeParam();
    const { router, persist } = harness({
      entries: [
        { sceneName: "pulse", params: { speed: a } },
        { sceneName: "pulse", params: { speed: b } },
        { sceneName: "swirl", params: { speed: other } },
      ],
    });
    router.writeParam("pulse", "speed", (p) => p.setNormalized(0.5));
    expect(a.setNormalized).toHaveBeenCalledWith(0.5);
    expect(b.setNormalized).toHaveBeenCalledWith(0.5);
    expect(other.setNormalized).not.toHaveBeenCalled();
    expect(persist.scene).toHaveBeenCalledWith("pulse");
  });

  it("does not persist a scene when no param matched", () => {
    const { router, persist } = harness({ entries: [{ sceneName: "pulse", params: {} }] });
    router.writeParam("pulse", "nope", (p) => p.cycle());
    expect(persist.scene).not.toHaveBeenCalled();
  });
});

describe("MidiRouter.setModEnabled", () => {
  it("toggles the globals palette modulator and persists palettes", () => {
    const { router, globalsModulators, persist } = harness({});
    router.setModEnabled("globals", "palette.primary.0.h", "toggle");
    expect(globalsModulators.toggleEnabled).toHaveBeenCalledWith("palette.primary.0.h");
    expect(persist.palettes).toHaveBeenCalled();
  });

  it("toggles an instance modulator on the matching scene only", () => {
    const mods = { toggleEnabled: vi.fn(), setEnabled: vi.fn(), get: vi.fn() };
    const otherMods = { toggleEnabled: vi.fn(), setEnabled: vi.fn(), get: vi.fn() };
    const { router } = harness({
      entries: [
        { sceneName: "pulse", modulators: mods },
        { sceneName: "swirl", modulators: otherMods },
      ],
    });
    router.setModEnabled("pulse", "speed", "toggle");
    expect(mods.toggleEnabled).toHaveBeenCalledWith("speed");
    expect(otherMods.toggleEnabled).not.toHaveBeenCalled();
  });
});

describe("MidiRouter.start (onCc wiring)", () => {
  it("routes an 'actions' setValue binding to onAction, not a param write", () => {
    const { router, start, fire, handleCc } = harness({});
    const seen: string[] = [];
    router.onAction = (p) => seen.push(p);
    // The binding layer resolves this CC to a setValue on the actions scene.
    handleCc.mockImplementationOnce((_e, ops) => {
      ops.setValue("actions", "live.next", 1);
      return { learned: false };
    });
    start();
    fire({ cc: 1, channel: 0, value: 127 } as unknown as CcEvent);
    expect(seen).toEqual(["live.next"]);
  });

  it("persists bindings when a CC completes a learn", () => {
    const { start, fire, handleCc, persist } = harness({});
    handleCc.mockImplementationOnce(() => ({ learned: true }));
    start();
    fire({ cc: 5, channel: 0, value: 64 } as unknown as CcEvent);
    expect(persist.bindings).toHaveBeenCalledTimes(1);
  });
});
