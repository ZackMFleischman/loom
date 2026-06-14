import { describe, expect, it } from "vitest";
import { PanicController } from "../src/panic-controller";
import type { SessionStore } from "../src/session";

type FakeEntry = { id: string; sceneName: string; pinned?: "panic"; instance: { error: unknown } };

/** A SessionStore stand-in with just the surface PanicController touches. */
function fakeSession() {
  const entries = new Map<string, FakeEntry>();
  const add = (id: string, sceneName: string, error: unknown = null) => {
    const e: FakeEntry = { id, sceneName, instance: { error } };
    entries.set(id, e);
    return e;
  };
  const store = {
    entries,
    get: (id: string) => entries.get(id),
    require: (id: string) => {
      const e = entries.get(id);
      if (!e) throw new Error(`unknown ${id}`);
      return e;
    },
  };
  return { store, entries, add };
}

function make() {
  const { store, entries, add } = fakeSession();
  const pc = new PanicController({ session: store as unknown as SessionStore });
  return { pc, entries, add };
}

describe("PanicController.info / instanceId with no designation (the boot default)", () => {
  it("reports a clean 'none' status and no instance — scene-panic is opt-in", () => {
    const { pc } = make();
    expect(pc.instanceId()).toBeNull();
    expect(pc.info()).toEqual({ name: "", status: "none", error: null });
  });
});

describe("PanicController.setInstance (the runtime ⛑ designation)", () => {
  it("designates an existing instance with no build; instanceId + info reflect it", () => {
    const { pc, entries, add } = make();
    add("pulse-1", "pulse");
    pc.setInstance("pulse-1");
    expect(entries.get("pulse-1")?.pinned).toBe("panic");
    expect(pc.instanceId()).toBe("pulse-1");
    expect(pc.info()).toEqual({ name: "pulse", status: "ok", error: null });
  });

  it("moves the marker to a new target (exactly one pinned)", () => {
    const { pc, entries, add } = make();
    add("pulse-1", "pulse");
    add("gradient-1", "gradient");
    pc.setInstance("pulse-1");
    pc.setInstance("gradient-1");
    expect(entries.get("pulse-1")?.pinned).toBeUndefined();
    expect(entries.get("gradient-1")?.pinned).toBe("panic");
    expect([...entries.values()].filter((e) => e.pinned === "panic")).toHaveLength(1);
    expect(pc.instanceId()).toBe("gradient-1");
  });

  it("is a no-op when the target is already designated", () => {
    const { pc, entries, add } = make();
    add("pulse-1", "pulse");
    pc.setInstance("pulse-1");
    pc.setInstance("pulse-1");
    expect(entries.get("pulse-1")?.pinned).toBe("panic");
    expect(pc.instanceId()).toBe("pulse-1");
  });

  it("throws on an unknown instance id", () => {
    const { pc } = make();
    expect(() => pc.setInstance("nope")).toThrow(/unknown/);
  });
});

describe("PanicController health when the designated target errors (FR-7)", () => {
  it("reports 'error' and makes scene-panic unavailable (instanceId null → hold)", () => {
    const { pc, add } = make();
    add("boom-1", "boom", "render boom");
    pc.setInstance("boom-1");
    expect(pc.info()).toEqual({ name: "boom", status: "error", error: "render boom" });
    // A broken target degrades scene-panic to hold: instanceId() returns null.
    expect(pc.instanceId()).toBeNull();
  });
});
