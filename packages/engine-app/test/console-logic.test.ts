import type { ChainStepInfo } from "@loom/sidecar/protocol";
import { describe, expect, it } from "vitest";
import { chainSteps, insertStep, removeStep, reorderStep, stepKnobs } from "../src/ui/console/chain-ops";
import type { ParamDesc } from "../src/ui/engine-link";
import { groupParams, splitRig } from "../src/ui/console/param-groups";

const f = (): ParamDesc => ({ type: "float", value: 0, default: 0, min: 0, max: 1 });
const manifest = (paths: string[]): Record<string, ParamDesc> => Object.fromEntries(paths.map((p) => [p, f()]));

describe("groupParams", () => {
  it("flattens dotless params and buckets dotted ones", () => {
    const { flat, groups } = groupParams(manifest(["speed", "logo.tiltX", "logo.tiltY", "bowl.scale"]), []);
    expect(flat.map(([p]) => p)).toEqual(["speed"]);
    expect([...groups.keys()].sort()).toEqual(["bowl", "logo"]);
    expect(groups.get("logo")!.map(([p]) => p)).toEqual(["logo.tiltX", "logo.tiltY"]);
  });

  it("keeps palette.source flat despite the dot", () => {
    const { flat } = groupParams(manifest(["palette.source", "palette.primary"]), []);
    expect(flat.map(([p]) => p)).toContain("palette.source");
  });

  it("drops root fx.* and node <node>.fx.* chain knobs", () => {
    const { flat, groups } = groupParams(
      manifest(["fx.glitch-1.mix", "logo.fx.blur-2.amount", "logo.layer.scale"]),
      [{ id: "logo", parent: null }],
    );
    expect(flat).toHaveLength(0);
    expect(groups.get("logo")!.map(([p]) => p)).toEqual(["logo.layer.scale"]); // node fx knob dropped
  });

  it("gives every layer node a section and records parentage", () => {
    const { groups, nodeIds, parentOf } = groupParams(manifest(["speed"]), [
      { id: "logo", parent: null },
      { id: "halo", parent: "logo" },
    ]);
    expect(groups.has("logo")).toBe(true);
    expect(groups.has("halo")).toBe(true);
    expect(nodeIds.has("halo")).toBe(true);
    expect(parentOf.get("halo")).toBe("logo");
  });
});

describe("splitRig", () => {
  it("separates layer-rig params from the rest", () => {
    const entries = manifest(["logo.layer.x", "logo.layer.scale", "logo.tiltX"]);
    const { rig, rest } = splitRig(Object.entries(entries), "logo");
    expect(rig.map(([p]) => p)).toEqual(["logo.layer.x", "logo.layer.scale"]);
    expect(rest.map(([p]) => p)).toEqual(["logo.tiltX"]);
  });

  it("renders flat (rest = all) when there are no rig params", () => {
    const entries = Object.entries(manifest(["logo.tiltX", "logo.tiltY"]));
    const { rig, rest } = splitRig(entries, "logo");
    expect(rig).toHaveLength(0);
    expect(rest).toHaveLength(2);
  });
});

describe("chain-ops", () => {
  const chain: ChainStepInfo[] = [
    { id: "glitch-1", effect: "glitch", kind: "primitive", mix: 1, enabled: true },
    { id: "blur-2", effect: "blur", kind: "primitive", mix: 0.5, enabled: true },
  ];

  it("chainSteps keeps id+effect so the engine carries knobs forward", () => {
    expect(chainSteps(chain)).toEqual([
      { id: "glitch-1", effect: "glitch" },
      { id: "blur-2", effect: "blur" },
    ]);
  });

  it("insertStep adds an id-less step at the index without mutating", () => {
    const steps = chainSteps(chain);
    const out = insertStep(steps, "echo", 1);
    expect(out.map((s) => s.effect)).toEqual(["glitch", "echo", "blur"]);
    expect(out[1]!.id).toBeUndefined();
    expect(steps).toHaveLength(2); // original untouched
  });

  it("removeStep drops by id", () => {
    expect(removeStep(chainSteps(chain), "glitch-1").map((s) => s.effect)).toEqual(["blur"]);
  });

  it("reorderStep moves a step; equal indices clone unchanged", () => {
    expect(reorderStep(chainSteps(chain), 0, 1).map((s) => s.effect)).toEqual(["blur", "glitch"]);
    expect(reorderStep(chainSteps(chain), 1, 1).map((s) => s.effect)).toEqual(["glitch", "blur"]);
  });

  it("stepKnobs returns knobs under the step prefix, excluding mix/enabled", () => {
    const m = manifest(["fx.glitch-1.mix", "fx.glitch-1.enabled", "fx.glitch-1.amount", "fx.blur-2.radius"]);
    expect(stepKnobs(m, "fx.", "glitch-1").map(([p]) => p)).toEqual(["fx.glitch-1.amount"]);
  });
});
