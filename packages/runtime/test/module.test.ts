import { describe, expect, it } from "vitest";
import { defineModule } from "../src/module";

describe("defineModule", () => {
  it("attaches validated metadata to the factory", () => {
    const lagish = defineModule(
      {
        name: "lagish",
        kind: "control",
        description: "smooths a value",
        tags: ["smooth"],
      },
      (_ctx: unknown, opts: { amount: number }) => opts.amount,
    );
    expect(lagish.meta.name).toBe("lagish");
    expect(lagish.meta.kind).toBe("control");
    expect(lagish.meta.tags).toEqual(["smooth"]);
    expect(lagish(null, { amount: 3 })).toBe(3);
  });

  it("defaults tags to empty", () => {
    const m = defineModule(
      { name: "plain", kind: "source", description: "d" },
      () => 1,
    );
    expect(m.meta.tags).toEqual([]);
  });

  it("rejects bad names", () => {
    expect(() =>
      defineModule({ name: "Bad Name!", kind: "control", description: "d" }, () => 0),
    ).toThrow();
  });

  it("rejects unknown kinds", () => {
    expect(() =>
      defineModule(
        { name: "x", kind: "wizard" as never, description: "d" },
        () => 0,
      ),
    ).toThrow();
  });

  it("rejects missing description", () => {
    expect(() =>
      defineModule({ name: "x", kind: "control" } as never, () => 0),
    ).toThrow();
  });
});
