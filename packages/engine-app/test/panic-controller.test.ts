import { describe, expect, it, vi } from "vitest";
import { PANIC_ID, PanicController } from "../src/panic-controller";
import type { SessionStore } from "../src/session";

type FakeEntry = { id: string; sceneName: string; pinned?: "panic" };

/** A SessionStore stand-in with just the surface PanicController touches. */
function fakeSession(opts: { createThrows?: boolean } = {}) {
  const entries = new Map<string, FakeEntry>();
  const store = {
    entries,
    get: (id: string) => entries.get(id),
    require: (id: string) => {
      const e = entries.get(id);
      if (!e) throw new Error(`unknown ${id}`);
      return e;
    },
    create: vi.fn((def: { name: string }, id: string) => {
      if (opts.createThrows) throw new Error("build boom");
      const e: FakeEntry = { id, sceneName: def.name };
      entries.set(id, e);
      return e;
    }),
    rebuild: vi.fn((_id: string, _def: { name: string }) => true),
  };
  return { store, entries };
}

const def = (name: string) => ({ name }) as never;

function make(opts: { createThrows?: boolean } = {}) {
  const { store, entries } = fakeSession(opts);
  const persistPanicScene = vi.fn();
  const pc = new PanicController({
    session: store as unknown as SessionStore,
    persistPanicScene,
    initialSceneName: "panic",
  });
  return { pc, store, entries, persistPanicScene };
}

describe("PanicController.info / instanceId before any build", () => {
  it("reports error health and no instance", () => {
    const { pc } = make();
    expect(pc.instanceId()).toBeNull();
    expect(pc.info()).toEqual({ name: "panic", status: "error", error: "panic instance not built yet" });
  });
});

describe("PanicController.tryBuild", () => {
  it("creates and pins the warm instance on first build", () => {
    const { pc, entries } = make();
    expect(pc.tryBuild(def("panic"))).toBe(true);
    expect(entries.get(PANIC_ID)?.pinned).toBe("panic");
    expect(pc.instanceId()).toBe(PANIC_ID);
    expect(pc.info()).toEqual({ name: "panic", status: "ok", error: null });
  });

  it("rebuilds (not recreates) when the warm instance already exists", () => {
    const { pc, store } = make();
    pc.tryBuild(def("panic"));
    store.create.mockClear();
    store.rebuild.mockReturnValueOnce(true);
    expect(pc.tryBuild(def("panic2"))).toBe(true);
    expect(store.create).not.toHaveBeenCalled();
    expect(store.rebuild).toHaveBeenCalledWith(PANIC_ID, expect.anything());
    expect(pc.sceneName).toBe("panic2");
  });

  it("flags health (keeps running) when a rebuild is rejected", () => {
    const { pc, store } = make();
    pc.tryBuild(def("panic"));
    store.rebuild.mockReturnValueOnce(false);
    expect(pc.tryBuild(def("panic3"))).toBe(false);
    expect(pc.info().status).toBe("ok"); // instance still exists/pinned
    expect(pc.info().error).toBeNull(); // pinned entry overrides buildError in info()
  });

  it("falls back to hold (no instance) when the first build throws", () => {
    const { pc } = make({ createThrows: true });
    expect(pc.tryBuild(def("panic"))).toBe(false);
    expect(pc.instanceId()).toBeNull();
    expect(pc.info().status).toBe("error");
    expect(pc.info().error).toContain("failed to build");
  });
});

describe("PanicController.setInstance", () => {
  it("moves the SAFE marker to an already-warm instance and persists", () => {
    const { pc, entries, persistPanicScene } = make();
    pc.tryBuild(def("panic")); // pins PANIC_ID
    entries.set("pulse-1", { id: "pulse-1", sceneName: "pulse" });
    pc.setInstance("pulse-1");
    expect(entries.get("pulse-1")?.pinned).toBe("panic");
    expect(entries.get(PANIC_ID)?.pinned).toBeUndefined();
    expect(pc.sceneName).toBe("pulse");
    expect(pc.instanceId()).toBe("pulse-1");
    expect(persistPanicScene).toHaveBeenCalledTimes(1);
  });

  it("is a no-op (no persist) when the target is already the safe instance", () => {
    const { pc, persistPanicScene } = make();
    pc.tryBuild(def("panic"));
    pc.setInstance(PANIC_ID);
    expect(persistPanicScene).not.toHaveBeenCalled();
  });
});

describe("PanicController.noteSafeRebuild", () => {
  it("clears health on a good HMR rebuild and flags on a rejected one", () => {
    const { pc } = make();
    pc.noteSafeRebuild(false, def("safe"));
    // No pinned entry yet → buildError surfaces.
    expect(pc.info().error).toContain("update rejected");
    pc.noteSafeRebuild(true, def("safe"));
    expect(pc.info().error).toBeNull();
  });
});
