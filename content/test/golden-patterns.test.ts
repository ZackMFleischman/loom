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

  // A texture() sample built inside a TSL Fn() function-scope is NOT collected
  // into the material's sampler bindings by three's node backend — the sampler
  // reads unbound, so the shader silently renders BLACK (build ok, instanceError
  // null). Sample textures at the TOP LEVEL of build() and pass the value in.
  // (uniform() nodes cross the Fn boundary fine; this is why ctx.palette.ramp()
  // is now built from the stop UNIFORMS and is safe inside an Fn — see
  // mandelbulb. Only RAW texture() samples remain hazardous.)
  // Heuristic: flag a `texture(` call lexically inside a block-bodied Fn().
  function rawTextureInsideFn(src: string): boolean {
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
      if (/\btexture\s*\(/.test(src.slice(open, end))) return true;
    }
    return false;
  }

  it("no module samples a raw texture() inside an Fn() (unbound sampler → black; sample at top level)", () => {
    const offenders = Object.entries(rawModuleSources())
      .filter(([, src]) => rawTextureInsideFn(src))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  it("no scene samples a raw texture() inside an Fn() (unbound sampler → black; sample at top level)", () => {
    const offenders = Object.entries(rawSceneSources())
      .filter(([, src]) => rawTextureInsideFn(src))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });
});
