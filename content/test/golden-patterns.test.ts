import { describe, expect, it } from "vitest";
import { rawModuleSources, rawSceneSources } from "./harness";

/**
 * Golden patterns the skills describe, encoded as tests (source scans).
 * Audio-reactive code consumes NAMED rack channels — onset detection is owned
 * by content/inputs.ts (R6.4). A module/scene calling audio.onset() is a
 * local re-detection: a differently-tuned kick must be a new named channel.
 */

/** Files allowed to re-detect (none today; additions need a written reason). */
const ONSET_ALLOWLIST: string[] = [];

const RE_DETECTION = /\baudio\s*\.\s*onset\s*\(/;

describe("golden patterns", () => {
  it("no module re-detects onsets locally (use named rack channels)", () => {
    const offenders = Object.entries(rawModuleSources())
      .filter(([file, src]) => RE_DETECTION.test(src) && !ONSET_ALLOWLIST.includes(file))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  it("no scene re-detects onsets locally (use ctx.input)", () => {
    const offenders = Object.entries(rawSceneSources())
      .filter(([file, src]) => RE_DETECTION.test(src) && !ONSET_ALLOWLIST.includes(file))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  it("modules never import the engine app or sidecar", () => {
    const offenders = Object.entries(rawModuleSources())
      .filter(([, src]) => /from\s+["']@loom\/sidecar|engine-app/.test(src))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  // TSL's `time` node reads the renderer's WALL clock — it bypasses the frame
  // clock, so fixture replays stop being deterministic and a paused virtual
  // clock keeps animating. Animate with ctx.uniformOf(ctx.time.now) instead.
  const TSL_TIME_IMPORT = /import\s*\{[^}]*\btime\b[^}]*\}\s*from\s*["']three\/tsl["']/;

  it("no module imports TSL `time` (wall clock — use ctx.uniformOf(ctx.time.now))", () => {
    const offenders = Object.entries(rawModuleSources())
      .filter(([, src]) => TSL_TIME_IMPORT.test(src))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  it("no scene imports TSL `time` (wall clock — use ctx.uniformOf(ctx.time.now))", () => {
    const offenders = Object.entries(rawSceneSources())
      .filter(([, src]) => TSL_TIME_IMPORT.test(src))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  // ctx.palette.ramp() returns a texture() sample node. A texture sample built
  // inside a TSL Fn() function-scope is NOT collected into the material's
  // sampler bindings by three's node backend — the sampler reads unbound, so
  // the shader silently renders BLACK (build ok, instanceError null). Build the
  // ramp at the top level of build() and pass the value in, OR inside an Fn use
  // the ctx.palette.color(i) UNIFORMS and mix() the gradient by hand (uniforms
  // cross the Fn boundary fine). See mandelbulb's ramp5 helper for the pattern.
  // Heuristic: flag a `palette.ramp(` call lexically inside a block-bodied Fn().
  function paletteRampInsideFn(src: string): boolean {
    for (const m of src.matchAll(/\bFn\s*\(/g)) {
      const open = src.indexOf("{", m.index);
      if (open === -1) continue;
      let depth = 0;
      let end = open;
      for (; end < src.length; end++) {
        if (src[end] === "{") depth++;
        else if (src[end] === "}") {
          depth -= 1;
          if (depth === 0) {
            end++;
            break;
          }
        }
      }
      if (/palette\s*\.\s*ramp\s*\(/.test(src.slice(open, end))) return true;
    }
    return false;
  }

  it("no module calls ctx.palette.ramp() inside an Fn() (texture sample → black; use color(i) uniforms)", () => {
    const offenders = Object.entries(rawModuleSources())
      .filter(([, src]) => paletteRampInsideFn(src))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  it("no scene calls ctx.palette.ramp() inside an Fn() (texture sample → black; use color(i) uniforms)", () => {
    const offenders = Object.entries(rawSceneSources())
      .filter(([, src]) => paletteRampInsideFn(src))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });
});
