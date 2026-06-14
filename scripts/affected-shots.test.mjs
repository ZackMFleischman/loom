import { describe, expect, it } from "vitest";
import {
  isConsolePath,
  isGlobalContent,
  repoRel,
  sceneNameFromPath,
  selectShots,
  transitiveClosure,
} from "./affected-shots.mjs";

describe("repoRel", () => {
  it("normalizes backslashes to forward slashes", () => {
    expect(repoRel("content\\inputs.ts")).toBe("content/inputs.ts");
    expect(repoRel("content/scenes/a.scene.ts")).toBe("content/scenes/a.scene.ts");
  });
});

describe("sceneNameFromPath", () => {
  it("extracts the scene name, ignoring the live pointer", () => {
    expect(sceneNameFromPath("content/scenes/pulse.scene.ts")).toBe("pulse");
    expect(sceneNameFromPath("content/scenes/live.scene.ts")).toBeNull();
    expect(sceneNameFromPath("content/modules/effects/feedback.ts")).toBeNull();
  });
});

describe("isConsolePath / isGlobalContent", () => {
  it("recognizes console UI sources", () => {
    expect(isConsolePath("packages/engine-app/src/ui/console/FxChain.tsx")).toBe(true);
    expect(isConsolePath("packages/engine-app/src/ui/theme.ts")).toBe(true);
    expect(isConsolePath("packages/engine-app/src/main.ts")).toBe(false);
    expect(isConsolePath("content/scenes/pulse.scene.ts")).toBe(false);
  });
  it("recognizes global content that fans out to everything", () => {
    expect(isGlobalContent("content/inputs.ts")).toBe(true);
    expect(isGlobalContent("content/scenes/live.scene.ts")).toBe(true);
    expect(isGlobalContent("content/test/cases.ts")).toBe(true);
    expect(isGlobalContent("content/modules/effects/feedback.ts")).toBe(false);
    expect(isGlobalContent("content/scenes/pulse.scene.ts")).toBe(false);
  });
});

describe("transitiveClosure", () => {
  it("collects the file and everything it transitively imports, cycle-safe", () => {
    const edges = {
      a: ["b"],
      b: ["c"],
      c: ["a"], // cycle back
    };
    const importsOf = (f) => edges[f] ?? [];
    expect([...transitiveClosure("a", importsOf)].sort()).toEqual(["a", "b", "c"]);
  });
});

describe("selectShots", () => {
  // Synthetic content graph:
  //   scene a → effects/fx → _shared
  //   scene b → sources/src
  const sceneFiles = new Map([
    ["a", "content/scenes/a.scene.ts"],
    ["b", "content/scenes/b.scene.ts"],
  ]);
  const edges = {
    "content/scenes/a.scene.ts": ["content/modules/effects/fx.ts"],
    "content/modules/effects/fx.ts": ["content/modules/_shared.ts"],
    "content/scenes/b.scene.ts": ["content/modules/sources/src.ts"],
  };
  const importsOf = (f) => edges[f] ?? [];

  it("shoots a scene whose file changed directly", () => {
    const r = selectShots({ changed: ["content/scenes/b.scene.ts"], sceneFiles, importsOf });
    expect(r.scenes).toEqual(["b"]);
    expect(r.console).toBe(false);
  });

  it("fans a module change out to the scenes that transitively import it", () => {
    const r = selectShots({ changed: ["content/modules/_shared.ts"], sceneFiles, importsOf });
    expect(r.scenes).toEqual(["a"]); // only a depends on _shared
  });

  it("combines a direct scene change with a module fan-out, deduped and sorted", () => {
    const r = selectShots({
      changed: ["content/modules/sources/src.ts", "content/scenes/a.scene.ts"],
      sceneFiles,
      importsOf,
    });
    expect(r.scenes).toEqual(["a", "b"]);
  });

  it("flags console changes and shoots no scenes for a console-only diff", () => {
    const r = selectShots({
      changed: ["packages/engine-app/src/ui/console/FxChain.tsx"],
      sceneFiles,
      importsOf,
    });
    expect(r.scenes).toEqual([]);
    expect(r.console).toBe(true);
  });

  it("ignores global content and unrelated package changes (fallback handled by caller)", () => {
    const r = selectShots({
      changed: ["content/inputs.ts", "packages/runtime/src/signal.ts", "README.md"],
      sceneFiles,
      importsOf,
    });
    expect(r.scenes).toEqual([]);
    expect(r.console).toBe(false);
  });

  it("caps the scene count, prioritizing directly-changed scenes, and reports truncation", () => {
    const many = new Map([
      ["s1", "content/scenes/s1.scene.ts"],
      ["s2", "content/scenes/s2.scene.ts"],
      ["s3", "content/scenes/s3.scene.ts"],
    ]);
    // all three import the shared module; s2's own file also changed
    const e = {
      "content/scenes/s1.scene.ts": ["content/modules/_shared.ts"],
      "content/scenes/s2.scene.ts": ["content/modules/_shared.ts"],
      "content/scenes/s3.scene.ts": ["content/modules/_shared.ts"],
    };
    const imp = (f) => e[f] ?? [];
    const r = selectShots({
      changed: ["content/modules/_shared.ts", "content/scenes/s2.scene.ts"],
      sceneFiles: many,
      importsOf: imp,
      cap: 2,
    });
    expect(r.scenes.length).toBe(2);
    expect(r.scenes[0]).toBe("s2"); // direct change wins a slot first
    expect(r.truncated).toBe(true);
  });
});
