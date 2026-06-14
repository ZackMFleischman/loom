import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { packsDir, readRegistry, repoRoot, writeRegistry } from "./lib/packs.mjs";

// Exercises `pnpm pack:fork` (FR-6) as a subprocess against the real repo dirs,
// using a uniquely-named throwaway pack so it never collides with real state.
// Setup plants a "pinned clone" (a real packs/<name>/ dir + a pinned registry
// entry); teardown removes every artifact and restores the registry.
const NAME = "forktestpack";
const checkout = path.join(packsDir, NAME);
const forkDir = path.join(repoRoot, "forks", NAME);

function runFork() {
  return execFileSync("node", [path.join(repoRoot, "scripts/pack.mjs"), "fork", NAME], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

let savedRegistry;
beforeEach(() => {
  savedRegistry = readRegistry();
  rmSync(checkout, { recursive: true, force: true });
  rmSync(forkDir, { recursive: true, force: true });
  // Plant a pinned "clone": real files + a .git dir that must NOT be copied.
  mkdirSync(path.join(checkout, "modules/effects"), { recursive: true });
  mkdirSync(path.join(checkout, ".git"), { recursive: true });
  writeFileSync(
    path.join(checkout, "loom-pack.json"),
    JSON.stringify({ name: NAME, version: "1.0.0", loomApi: "^1", description: "x" }),
  );
  writeFileSync(path.join(checkout, "modules/effects/fx.ts"), "// fx\n");
  writeFileSync(path.join(checkout, ".git/config"), "secret\n");
  const reg = readRegistry();
  reg.packs = reg.packs.filter((p) => p.name !== NAME);
  reg.packs.push({
    name: NAME,
    source: "https://github.com/x/clone.git",
    pin: "deadbeef00",
    branch: "main",
    loomApi: "^1",
  });
  writeRegistry(reg);
});

afterEach(() => {
  rmSync(checkout, { recursive: true, force: true });
  rmSync(forkDir, { recursive: true, force: true });
  // Drop the empty forks/ dir if we created it and it's now empty.
  try {
    rmSync(path.join(repoRoot, "forks"), { recursive: false });
  } catch {
    /* not empty / not ours — leave it */
  }
  writeRegistry(savedRegistry);
});

describe("pack:fork (FR-6)", () => {
  it("copies an installed pack into an editable, un-pinned forks/<name> tree", () => {
    const out = runFork();
    expect(out).toMatch(/forking/);

    // Files copied, .git excluded.
    expect(existsSync(path.join(forkDir, "loom-pack.json"))).toBe(true);
    expect(existsSync(path.join(forkDir, "modules/effects/fx.ts"))).toBe(true);
    expect(existsSync(path.join(forkDir, ".git"))).toBe(false);

    // Registry entry detached: pin null, source points at the local fork, branch gone.
    const e = readRegistry().packs.find((p) => p.name === NAME);
    expect(e.pin).toBe(null);
    expect(e.source).toBe(forkDir);
    expect(e.branch).toBeUndefined();

    // packs/<name> now tracks the fork (a symlink/junction).
    expect(lstatSync(checkout).isSymbolicLink()).toBe(true);
  });

  it("fails cleanly for an unknown pack", () => {
    expect(() =>
      execFileSync("node", [path.join(repoRoot, "scripts/pack.mjs"), "fork", "no-such-pack-xyz"], {
        cwd: repoRoot,
        encoding: "utf8",
      }),
    ).toThrow(/no registered pack/);
  });
});
