import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./lib/packs.mjs";

// Exercises `pnpm pack:search` (FR-3) as a subprocess against the committed seed
// index. Runs `node scripts/pack.mjs search ...` directly so it reads the real
// content/marketplace/index.json.
function search(args, env = {}) {
  return execFileSync("node", [path.join(repoRoot, "scripts/pack.mjs"), "search", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

describe("pack:search CLI (FR-3)", () => {
  it("prints ranked results with an install hint for a matching query", () => {
    const out = search(["retro"]);
    expect(out).toMatch(/retroArcade/);
    expect(out).toMatch(/install: pnpm pack:add /);
    // The trust posture line is always printed (NFR-3).
    expect(out).toMatch(/popularity, not a security audit/);
  });

  it("passes a pinned ref through the install hint", () => {
    const out = search(["organic", "--tag", "audio-reactive"]);
    expect(out).toMatch(/hippoPack/);
    expect(out).toMatch(/--ref /);
  });

  it("reports a clean 'no results' message for a non-matching query", () => {
    const out = search(["zzzznomatchqzz"]);
    expect(out).toMatch(/no marketplace entries match/);
  });

  it("degrades cleanly (exit 1, clean message) when the index is missing (NFR-2)", () => {
    let err;
    try {
      search(["retro"], { LOOM_MARKETPLACE_INDEX: "./definitely-absent-index.json" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.status).toBe(1);
    // The clean error reaches stderr.
    expect(String(err.stderr)).toMatch(/no index found/);
  });
});
