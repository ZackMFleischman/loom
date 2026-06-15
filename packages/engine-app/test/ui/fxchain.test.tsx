import type { ChainStepInfo, EffectInfo } from "@loom/sidecar/protocol";
import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FxChain } from "../../src/ui/console/FxChain";
import type { ControlsSlice, InstanceStructure, ParamDesc } from "../../src/ui/engine-link";
import { FakeEngineLink, withEngine } from "./fake-engine-link";

/** A one-step chain (a single `blur` primitive with id `s1`). */
function oneStepStructure(): InstanceStructure {
  return {
    id: "boot",
    scene: "pulse",
    status: "ok",
    error: null,
    nodes: [],
    chain: [
      {
        id: "s1",
        effect: "blur",
        kind: "primitive",
        mix: 1,
        enabled: true,
      } as ChainStepInfo,
    ],
  };
}

/** A manifest exposing the step's standard chain params (mix/enabled + one knob). */
function manifest(): Record<string, ParamDesc> {
  return {
    "fx.s1.mix": { type: "float", value: 1, default: 1, min: 0, max: 1 },
    "fx.s1.enabled": { type: "bool", value: true, default: true },
    "fx.s1.fade": { type: "float", value: 0.2, default: 0.2, min: 0, max: 2 },
    "fx.s1.radius": { type: "float", value: 4, default: 4, min: 0, max: 20 },
  };
}

function controls(effects: EffectInfo[]): ControlsSlice {
  return {
    bindings: [],
    midi: { status: "off", devices: [], learning: null, recent: [] },
    availableEffects: effects,
    scenes: { boot: "pulse" },
  };
}

const BLUR: EffectInfo = { name: "blur", kind: "primitive" };

describe("FxChain", () => {
  it("keeps a step card's DOM node across an unrelated re-render (no remount)", () => {
    const link = new FakeEngineLink();
    link.pushStructure(oneStepStructure());
    link.pushControls(controls([BLUR]));

    const { container } = render(
      withEngine(link, <FxChain instance="boot" manifest={manifest()} />),
    );

    const before = container.querySelector('[data-fxstep="s1"]');
    expect(before).not.toBeNull();

    // Wake FxChain via an unrelated slice change (a fresh controls identity) that
    // leaves the chain itself untouched. A stable component tree reconciles and
    // keeps the same DOM node; a remount (new component identity every render)
    // would destroy and recreate it — eating in-flight clicks and thrashing perf.
    act(() => link.pushControls(controls([BLUR])));

    const after = container.querySelector('[data-fxstep="s1"]');
    expect(after).toBe(before);
  });

  it("sends a set_chain dropping the step when ✕ is clicked", () => {
    const link = new FakeEngineLink();
    link.pushStructure(oneStepStructure());
    link.pushControls(controls([BLUR]));

    const { container } = render(
      withEngine(link, <FxChain instance="boot" manifest={manifest()} />),
    );

    const remove = container.querySelector('[data-fxremove="s1"]') as HTMLElement;
    expect(remove).not.toBeNull();
    fireEvent.click(remove);

    const call = link.requests.find((r) => r.type === "set_chain");
    expect(call).toBeDefined();
    expect(call!.args).toMatchObject({ instance: "boot", steps: [] });
  });
});
