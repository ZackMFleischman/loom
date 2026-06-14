import type { WebGPURenderer } from "three/webgpu";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FixtureService, type FixtureServiceDeps } from "../src/fixture-service";
import type { SessionStore } from "../src/session";

/** Build a FixtureService over fakes; default rack has two channels. */
function make(opts: { channels?: Record<string, number>; entry?: object } = {}) {
  const channels = opts.channels ?? { kick: 0, bass: 0 };
  const values = { ...channels };
  const session = {
    require: (id: string) => {
      if (opts.entry === undefined) throw new Error(`unknown instance "${id}"`);
      return opts.entry;
    },
  };
  const readTargetToDataUrl = vi.fn();
  const deps = {
    session: session as unknown as SessionStore,
    renderer: {} as WebGPURenderer,
    inputs: { values: () => values },
    palettes: {} as FixtureServiceDeps["palettes"],
    timeBus: { bpm: 128 } as FixtureServiceDeps["timeBus"],
    readTargetToDataUrl,
  } satisfies FixtureServiceDeps;
  return { svc: new FixtureService(deps), values };
}

afterEach(() => vi.restoreAllMocks());

describe("FixtureService.record / recordFrame", () => {
  it("rejects recording when the rack has no channels", () => {
    const { svc } = make({ channels: {} });
    expect(() => svc.record("x", 3)).toThrow(/no channels/);
  });

  it("rejects a second recording while one is in flight", () => {
    const { svc } = make();
    void svc.record("a", 5);
    expect(() => svc.record("b", 5)).toThrow(/already in flight/);
  });

  it("accumulates one row per frame, stamps BPM, posts the trace, and resolves", async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve({ ok: true } as Response));
    vi.stubGlobal("fetch", fetchMock);
    const { svc, values } = make({ channels: { kick: 0, bass: 0 } });
    const done = svc.record("loop", 2);
    values.kick = 0.5;
    values.bass = 0.1;
    svc.recordFrame();
    values.kick = 0.9;
    svc.recordFrame(); // second frame completes the recording
    const result = await done;
    expect(result).toMatchObject({ saved: "loop", frames: 2, channels: ["kick", "bass"], bpm: 128 });
    expect(result.path).toContain("loop");
    // The POST body carries both rows in channel order.
    const init = fetchMock.mock.calls[0]?.[1];
    const body = JSON.parse(init?.body as string);
    expect(body).toMatchObject({ name: "loop", bpm: 128, channels: ["kick", "bass"], frames: [[0.5, 0.1], [0.9, 0.1]] });
  });

  it("rejects the record promise when the save POST fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 }) as Response));
    const { svc } = make();
    const done = svc.record("loop", 1);
    svc.recordFrame();
    await expect(done).rejects.toThrow(/fixture save failed/);
  });

  it("recordFrame is a no-op when nothing is recording", () => {
    const { svc } = make();
    expect(() => svc.recordFrame()).not.toThrow();
  });
});

describe("FixtureService.shots guards", () => {
  it("throws on an unknown instance", async () => {
    const { svc } = make({}); // no entry configured → session.require throws
    await expect(svc.shots("ghost", [0])).rejects.toThrow(/unknown instance/);
  });

  it("throws when the entry replays no fixture", async () => {
    const { svc } = make({ entry: { fixture: null } });
    await expect(svc.shots("boot", [0])).rejects.toThrow(/replays no fixture/);
  });
});
