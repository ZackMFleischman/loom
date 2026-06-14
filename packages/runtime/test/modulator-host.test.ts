import { describe, expect, it } from "vitest";
import { ModulatorHost, type ManifestLike } from "../src/modulator-host";
import { Manifest } from "../src/param";
import { F } from "./helpers";

const bus = { bpm: () => 120 };
const manifest = () => {
  const m = new Manifest();
  m.float("trail", { default: 0.8, min: 0.5, max: 0.97 });
  m.bool("flash", { default: false });
  return m;
};

describe("ModulatorHost", () => {
  it("attaches, replaces, clears, reports", () => {
    const host = new ModulatorHost(bus);
    const m = manifest();
    const spec = host.attach(m, "trail", { type: "square", periodSeconds: 1 });
    expect(spec.type).toBe("square");
    expect(host.active("trail")).toBe(true);
    host.attach(m, "trail", { type: "sine", periodSeconds: 2 }); // replace (FR-1)
    expect(host.get("trail")?.spec.type).toBe("sine");
    expect(host.list()).toHaveLength(1);
    expect(host.clear("trail")).toBe(true);
    expect(host.clear("trail")).toBe(false); // no-op success
    expect(host.active("trail")).toBe(false);
  });

  it("rejects unknown params and bad specs with clear errors", () => {
    const host = new ModulatorHost(bus);
    expect(() => host.attach(manifest(), "nope", { type: "sine", periodSeconds: 1 })).toThrow(
      /unknown param/,
    );
    expect(() => host.attach(manifest(), "flash", { type: "sine", periodSeconds: 1 })).toThrow(/bool/);
  });

  it("rejects attaching to a color param", () => {
    const m = new Manifest();
    m.color("tint", { default: "#ffffff" });
    const host = new ModulatorHost(bus);
    expect(() => host.attach(m, "tint", { type: "sine", periodSeconds: 1 })).toThrow(/color/);
  });

  it("tick writes through the manifest (clamped set path, FR-2)", () => {
    const host = new ModulatorHost(bus);
    const m = manifest();
    host.attach(m, "trail", { type: "sine", periodSeconds: 1 });
    host.tick(m, F(0));
    expect(m.get("trail")!.value).toBeCloseTo(0.5, 6); // sine starts at lo = min
  });

  it("contains evaluation throws: detaches, flags, never propagates (FR-9)", () => {
    const host = new ModulatorHost(bus);
    let calls = 0;
    const booby: ManifestLike = {
      get: () => ({
        set: () => {
          calls++;
          throw new Error("boom");
        },
        toJSON: () => ({ type: "float", min: 0, max: 1, value: 0 }),
      }),
    };
    host.attach(booby, "trail", { type: "sine", periodSeconds: 1 });
    expect(() => host.tick(booby, F(0))).not.toThrow();
    expect(host.get("trail")?.error).toContain("boom");
    expect(host.active("trail")).toBe(false);
    host.tick(booby, F(1)); // errored slot is skipped
    expect(calls).toBe(1);
  });

  it("setEnabled pauses writes without detaching; re-enable resumes", () => {
    const host = new ModulatorHost(bus);
    const m = manifest();
    host.attach(m, "trail", { type: "ramp", periodSeconds: 1 });
    host.tick(m, F(0));
    const held = m.get("trail")!.value;
    expect(host.setEnabled("trail", false).enabled).toBe(false);
    expect(host.get("trail")?.enabled).toBe(false);
    expect(host.list()[0]!.enabled).toBe(false);
    expect(host.active("trail")).toBe(false); // manual control allowed while paused
    host.tick(m, F(1));
    host.tick(m, F(2));
    expect(m.get("trail")!.value).toBe(held); // param held, not written
    m.get("trail")!.set(0.9); // manual set sticks while paused
    host.tick(m, F(3));
    expect(m.get("trail")!.value).toBe(0.9);
    host.setEnabled("trail", true);
    expect(host.active("trail")).toBe(true);
    host.tick(m, F(4));
    expect(m.get("trail")!.value).not.toBe(0.9); // writing again
  });

  it("setEnabled throws on a path with no modulator; toggleEnabled flips", () => {
    const host = new ModulatorHost(bus);
    expect(() => host.setEnabled("trail", false)).toThrow(/no modulator/);
    expect(host.toggleEnabled("trail")).toBeNull();
    host.attach(manifest(), "trail", { type: "sine", periodSeconds: 1 });
    expect(host.toggleEnabled("trail")?.enabled).toBe(false);
    expect(host.toggleEnabled("trail")?.enabled).toBe(true);
  });

  it("reattach preserves the paused state; attach (replace) resets it", () => {
    const host = new ModulatorHost(bus);
    host.attach(manifest(), "trail", { type: "sine", periodSeconds: 1 });
    host.setEnabled("trail", false);
    host.reattach(manifest());
    expect(host.get("trail")?.enabled).toBe(false);
    host.attach(manifest(), "trail", { type: "sine", periodSeconds: 2 });
    expect(host.get("trail")?.enabled).toBe(true);
  });

  it("reattach survives rebuilds, orphans vanished params, recovers fixed ones (FR-4)", () => {
    const host = new ModulatorHost(bus);
    host.attach(manifest(), "trail", { type: "sine", periodSeconds: 1 });
    const gone = new Manifest(); // rebuild renamed the param away
    host.reattach(gone);
    expect(host.get("trail")?.error).toMatch(/vanished/);
    host.reattach(manifest()); // param came back — recovers
    expect(host.active("trail")).toBe(true);

    host.attach(manifest(), "trail", { type: "sine", periodSeconds: 1, lo: 0.5 });
    const narrowed = new Manifest(); // rebuild narrowed the range under the spec
    narrowed.float("trail", { default: 0.8, min: 0.7, max: 0.97 });
    host.reattach(narrowed);
    expect(host.get("trail")?.error).toMatch(/min . lo/);
  });
});
