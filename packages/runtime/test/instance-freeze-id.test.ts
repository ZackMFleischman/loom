import { vec4 } from "three/tsl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Instance } from "../src/instance";
import { LOOP_GUARD_PREFIX } from "../src/loopguard-prefix";
import { Manifest } from "../src/param";
import type { Pass } from "../src/texnode";
import { F } from "./helpers";

/**
 * Freeze-id contract: a render-time throw freezes the instance (NFR-2) and the
 * structured `instance.frozen` / `loopguard.tripped` event must carry the
 * INSTANCE id (not the scene name) when one is set — so `get_diagnostics
 * { instance:<id> }` matches a freeze on a sandbox whose id ≠ scene name.
 */

/** A pass whose render() throws — drives the NFR-2 freeze path deterministically. */
function throwingPass(message: string): Pass {
  return {
    render() {
      throw new Error(message);
    },
    dispose() {},
  };
}

/** Build a minimal Instance with one throwing pass; the quad never renders. */
function frozenInstance(sceneName: string, message: string): Instance {
  return new Instance(sceneName, new Manifest(), [], [throwingPass(message)], vec4(0, 0, 0, 1));
}

const fakeRenderer = {
  getRenderTarget: () => null,
  setRenderTarget: () => {},
} as never;

afterEach(() => {
  Instance.diagSink = null;
});

describe("Instance freeze diagnostics id", () => {
  it("emits instance.frozen carrying the instance id, not the scene name", () => {
    const events: Array<{ kind: string; instance?: string; data?: Record<string, unknown> }> = [];
    Instance.diagSink = (e) => events.push(e);

    const inst = frozenInstance("pulse", "boom");
    inst.instanceId = "pulse-2"; // id ≠ scene name (the bug's repro condition)
    inst.renderFrame(fakeRenderer, F(7));

    expect(inst.error).toBeInstanceOf(Error);
    const frozen = events.find((e) => e.kind === "instance.frozen");
    expect(frozen).toBeDefined();
    expect(frozen?.instance).toBe("pulse-2"); // the id, not "pulse"
    expect(frozen?.data?.scene).toBe("pulse"); // scene name preserved in data
  });

  it("falls back to the scene name when no instance id is set (headless kernel use)", () => {
    const events: Array<{ kind: string; instance?: string }> = [];
    Instance.diagSink = (e) => events.push(e);

    const inst = frozenInstance("pulse", "boom"); // instanceId left null
    inst.renderFrame(fakeRenderer, F(1));

    expect(events.find((e) => e.kind === "instance.frozen")?.instance).toBe("pulse");
  });

  it("tags a loop-guard trip as loopguard.tripped, still carrying the instance id", () => {
    const events: Array<{ kind: string; instance?: string }> = [];
    Instance.diagSink = (e) => events.push(e);

    const inst = frozenInstance("spin", `${LOOP_GUARD_PREFIX}budget exceeded`);
    inst.instanceId = "spin-9";
    inst.renderFrame(fakeRenderer, F(3));

    const ev = events.find((e) => e.kind === "loopguard.tripped");
    expect(ev).toBeDefined();
    expect(ev?.instance).toBe("spin-9");
  });
});
