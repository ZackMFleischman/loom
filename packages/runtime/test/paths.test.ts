import { describe, expect, it } from "vitest";
import {
  fixtureName,
  fxStepPath,
  hasFxSegment,
  inputTrimPath,
  isFxPath,
  isModBinding,
  isPalettePath,
  layerRigPath,
  modBindingPath,
  modTarget,
  nodeFxPrefix,
  PALETTE_SOURCE_PATH,
  paletteStopPath,
  rackKnobPath,
  RESERVED_NODE_NAMES,
  ROOT_FX_PREFIX,
} from "../src/paths";

describe("manifest path conventions", () => {
  it("builds input-rack paths", () => {
    expect(inputTrimPath("kick")).toBe("input.kick.amount");
    expect(rackKnobPath("kick", "threshold")).toBe("inputs.kick.threshold");
  });

  it("builds palette paths and routes by prefix", () => {
    expect(paletteStopPath("primary", 0)).toBe("palette.primary.0");
    expect(PALETTE_SOURCE_PATH).toBe("palette.source");
    expect(isPalettePath("palette.primary.0")).toBe(true);
    expect(isPalettePath("inputs.kick.gain")).toBe(false);
  });

  it("builds layer-rig paths", () => {
    expect(layerRigPath("logo", "scale")).toBe("logo.layer.scale");
  });

  it("builds chain-step paths and distinguishes root vs node chains", () => {
    expect(ROOT_FX_PREFIX).toBe("fx");
    expect(nodeFxPrefix("logo")).toBe("logo.fx");
    expect(fxStepPath(ROOT_FX_PREFIX, "glitch-1", "mix")).toBe("fx.glitch-1.mix");
    expect(fxStepPath(nodeFxPrefix("logo"), "blur-2", "amount")).toBe("logo.fx.blur-2.amount");
    // isFxPath: root chain only; hasFxSegment: root OR node chain.
    expect(isFxPath("fx.glitch-1.mix")).toBe(true);
    expect(isFxPath("logo.fx.blur-2.amount")).toBe(false);
    expect(hasFxSegment("fx.glitch-1.mix")).toBe(true);
    expect(hasFxSegment("logo.fx.blur-2.amount")).toBe(true);
    expect(hasFxSegment("logo.layer.scale")).toBe(false);
  });

  it("wraps and unwraps mod: binding targets", () => {
    expect(modBindingPath("trail")).toBe("mod:trail");
    expect(isModBinding("mod:trail")).toBe(true);
    expect(isModBinding("trail")).toBe(false);
    expect(modTarget(modBindingPath("fx.glitch-1.enabled"))).toBe("fx.glitch-1.enabled");
  });

  it("parses fixture: input refs", () => {
    expect(fixtureName("fixture:kick-trace")).toBe("kick-trace");
  });

  it("reserves the namespace heads and instance aliases as node names", () => {
    for (const name of ["fx", "input", "palette", "live", "globals", "actions", "root"]) {
      expect(RESERVED_NODE_NAMES.has(name)).toBe(true);
    }
  });
});
