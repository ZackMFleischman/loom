import { isCamNode, isGeoNode, Signal, type TexNode } from "@loom/runtime";
import { describe, expect, it } from "vitest";
import { buildCase, CASES } from "./cases";
import { discoverModules, preservesInputPasses, type ModuleFolder } from "./harness";

/**
 * Tier 1 — metadata/contract. Runs against every defineModule export found
 * under content/modules (discovery is automatic; the completeness test below
 * is what forces a new module to bring a test case with it).
 */

const modules = discoverModules();
const FOLDER_KIND: Record<ModuleFolder, string> = {
  control: "control",
  sources: "source",
  effects: "effect",
  geo: "geo",
};

describe("stdlib discovery", () => {
  it("finds the library", () => {
    expect(modules.length).toBeGreaterThanOrEqual(20);
  });

  it("every module on disk has a test case (new modules merge with tests)", () => {
    const missing = modules.filter((m) => CASES[m.name] == null).map((m) => m.name);
    expect(missing, `add cases to content/test/cases.ts for: ${missing.join(", ")}`).toEqual([]);
  });

  it("every test case corresponds to a module on disk (no stale cases)", () => {
    const names = new Set(modules.map((m) => m.name));
    const stale = Object.keys(CASES).filter((n) => !names.has(n));
    expect(stale).toEqual([]);
  });

  it("module names are unique across the library", () => {
    const names = modules.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe.each(modules)("tier-1 contract: $name", (d) => {
  it("kind matches its folder", () => {
    expect(d.factory.meta.kind).toBe(FOLDER_KIND[d.folder]);
  });

  it("metadata is complete (description, example)", () => {
    expect(d.factory.meta.description.length).toBeGreaterThan(8);
    expect(Array.isArray(d.factory.meta.tags)).toBe(true);
    // The catalog leans on examples; every stdlib module ships one.
    expect(d.factory.meta.example, "meta.example missing").toBeTruthy();
  });

  it("builds and returns the shape its kind promises", () => {
    const { out } = buildCase(d);
    if (d.factory.meta.kind === "control") {
      expect(out).toBeInstanceOf(Signal);
      return;
    }
    if (d.factory.meta.kind === "geo") {
      // Geo modules return scene-graph fragments (GeoNode) or camera rigs (CamNode).
      expect(isGeoNode(out) || isCamNode(out), "geo modules return a GeoNode or CamNode").toBe(true);
      return;
    }
    const tex = out as TexNode;
    expect(tex && typeof tex).toBe("object");
    expect((tex.color as { isNode?: boolean })?.isNode, "color must be a TSL node").toBe(true);
    expect(Array.isArray(tex.passes)).toBe(true);
  });

  it("manifest ranges are honest (min < max, default inside)", () => {
    const { h } = buildCase(d);
    for (const path of h.ctx.manifest.paths()) {
      const j = h.ctx.manifest.get(path)!.toJSON() as {
        type: string;
        min?: number;
        max?: number;
        default?: unknown;
      };
      if (j.type !== "float" && j.type !== "int") continue;
      expect(j.min, `${path} has no min`).toBeTypeOf("number");
      expect(j.max, `${path} has no max`).toBeTypeOf("number");
      expect(j.min!, `${path}: degenerate range`).toBeLessThan(j.max!);
      expect(j.default, `${path}: default outside range`).toBeGreaterThanOrEqual(j.min!);
      expect(j.default, `${path}: default outside range`).toBeLessThanOrEqual(j.max!);
    }
  });
});

const effects = modules.filter((m) => m.factory.meta.kind === "effect");

describe.each(effects)("tier-1 pass ordering: $name", (d) => {
  it("returns [...input.passes, ...own] — input passes first, in order", () => {
    const { out, inputPasses } = buildCase(d);
    expect(preservesInputPasses(out as TexNode, inputPasses)).toBe(true);
  });
});
