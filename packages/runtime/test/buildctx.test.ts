import { describe, expect, it } from "vitest";
import { BuildCtx } from "../src/buildctx";
import { Signal } from "../src/signal";
import type { AudioBusLike } from "../src/inputbus/audio";
import type { TimeBus } from "../src/inputbus/time";

/** BuildCtx stores the buses but uniformOf/color never touch them. */
const ctx = () => new BuildCtx(null as unknown as AudioBusLike, null as unknown as TimeBus);
const lastLabel = (c: BuildCtx) => c.updaters[c.updaters.length - 1]!.label;

describe("BuildCtx updater attribution", () => {
  it("uniformOf inherits a param signal's path as its updater label", () => {
    const c = ctx();
    const p = c.float("speed", { default: 1, min: 0, max: 2, description: "" });
    c.uniformOf(p.signal());
    expect(lastLabel(c)).toBe("speed");
  });

  it("uniformOf takes an explicit label over the signal's own", () => {
    const c = ctx();
    c.uniformOf(new Signal(() => 0).named("inner"), "explicit");
    expect(lastLabel(c)).toBe("explicit");
  });

  it("a constant uniformOf registers no updater (nothing to pull)", () => {
    const c = ctx();
    c.uniformOf(5);
    expect(c.updaters).toHaveLength(0);
  });

  it("color() labels its updater with the param path", () => {
    const c = ctx();
    c.color("tint", { default: "#ffffff", description: "" });
    expect(lastLabel(c)).toBe("tint");
  });
});
