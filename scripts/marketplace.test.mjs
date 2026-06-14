import { describe, expect, it } from "vitest";
import {
  CATALOG_TAGS,
  INDEX_SCHEMA_VERSION,
  installHint,
  loadIndex,
  rankEntries,
  toResult,
  validateIndex,
} from "./lib/marketplace.mjs";
import { DEFAULT_INDEX_PATH } from "./lib/marketplace.mjs";

// A minimal valid entry factory.
const entry = (over = {}) => ({
  name: "fooPack",
  gitUrl: "https://github.com/x/foo.git",
  description: "a foo pack",
  tags: ["retro"],
  author: "me",
  loomApi: "^1",
  ...over,
});
const index = (packs) => ({ schemaVersion: INDEX_SCHEMA_VERSION, packs });

describe("validateIndex (FR-1 frozen schema)", () => {
  it("accepts a well-formed index", () => {
    const r = validateIndex(index([entry()]));
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("requires the frozen schemaVersion", () => {
    expect(validateIndex({ schemaVersion: 99, packs: [] }).ok).toBe(false);
    expect(validateIndex(index([])).ok).toBe(true); // empty packs is valid
  });

  it("rejects a non-object / missing packs array", () => {
    expect(validateIndex(null).ok).toBe(false);
    expect(validateIndex([]).ok).toBe(false);
    expect(validateIndex({ schemaVersion: INDEX_SCHEMA_VERSION }).ok).toBe(false);
  });

  it("requires every mandatory string field", () => {
    for (const f of ["name", "gitUrl", "description", "author", "loomApi"]) {
      const bad = entry();
      delete bad[f];
      const r = validateIndex(index([bad]));
      expect(r.ok, `missing ${f} should fail`).toBe(false);
      expect(r.errors.join(" ")).toContain(f);
    }
  });

  it("validates name shape and rejects duplicates", () => {
    expect(validateIndex(index([entry({ name: "2bad" })])).ok).toBe(false);
    expect(validateIndex(index([entry({ name: "a/b" })])).ok).toBe(false);
    const dup = validateIndex(index([entry({ name: "dupe" }), entry({ name: "dupe" })]));
    expect(dup.ok).toBe(false);
    expect(dup.errors.join(" ")).toContain("duplicate");
  });

  it("rejects a non-git gitUrl and a negative rating", () => {
    expect(validateIndex(index([entry({ gitUrl: "not-a-url" })])).ok).toBe(false);
    expect(validateIndex(index([entry({ rating: -1 })])).ok).toBe(false);
    expect(validateIndex(index([entry({ rating: 10 })])).ok).toBe(true);
  });

  it("requires tags to be an array but allows an empty one", () => {
    expect(validateIndex(index([entry({ tags: "retro" })])).ok).toBe(false);
    expect(validateIndex(index([entry({ tags: [] })])).ok).toBe(true);
  });

  it("warns (does not error) on an off-vocabulary tag", () => {
    const r = validateIndex(index([entry({ tags: ["totally-made-up"] })]));
    expect(r.ok).toBe(true);
    expect(r.warnings.join(" ")).toContain("totally-made-up");
  });
});

describe("the committed seed index is valid", () => {
  it("loads + validates content/marketplace/index.json", async () => {
    const idx = await loadIndex(DEFAULT_INDEX_PATH);
    expect(idx.schemaVersion).toBe(INDEX_SCHEMA_VERSION);
    expect(idx.packs.length).toBeGreaterThan(0);
    for (const p of idx.packs) {
      // Every seed tag is in the documented vocabulary.
      for (const t of p.tags) expect(CATALOG_TAGS).toContain(t);
    }
  });
});

describe("rankEntries (FR-2/3 shared ranker)", () => {
  const packs = [
    entry({ name: "retroArcade", description: "crt scanlines", tags: ["retro", "finish"], rating: 80 }),
    entry({ name: "neonGrid", description: "an 80s retro grid", tags: ["retro", "generative"], rating: 90 }),
    entry({ name: "geoLab", description: "3d models", tags: ["3d"], rating: 50 }),
  ];

  it("ranks an exact name match first", () => {
    const r = rankEntries(packs, "retroArcade");
    expect(r[0].name).toBe("retroArcade");
  });

  it("matches across name, tag, and description", () => {
    const names = rankEntries(packs, "retro").map((p) => p.name);
    expect(names).toContain("retroArcade");
    expect(names).toContain("neonGrid");
    expect(names).not.toContain("geoLab");
  });

  it("applies tags as a hard AND filter", () => {
    expect(
      rankEntries(packs, "", ["retro"])
        .map((p) => p.name)
        .sort(),
    ).toEqual(["neonGrid", "retroArcade"]);
    expect(rankEntries(packs, "", ["retro", "3d"])).toEqual([]); // no entry has both
  });

  it("breaks score ties by rating then name (deterministic)", () => {
    // Both match the tag equally on score; higher rating wins the tie.
    const r = rankEntries(packs, "", ["retro"]);
    expect(r[0].name).toBe("neonGrid"); // rating 90 > 80
  });

  it("returns nothing for a query that matches no entry", () => {
    expect(rankEntries(packs, "zzzznomatch")).toEqual([]);
  });
});

describe("installHint (FR-4 handoff) + toResult", () => {
  it("emits a bare pack:add for an unpinned entry", () => {
    expect(installHint(entry())).toBe("pnpm pack:add https://github.com/x/foo.git");
  });
  it("passes a pinned gitRef through as --ref", () => {
    expect(installHint(entry({ gitRef: "v2.0" }))).toBe("pnpm pack:add https://github.com/x/foo.git --ref v2.0");
  });
  it("toResult carries the public surface incl. installHint", () => {
    const r = toResult(entry({ rating: 5 }));
    expect(r).toMatchObject({ name: "fooPack", author: "me", loomApi: "^1", rating: 5 });
    expect(r.installHint).toContain("pack:add");
  });
});

describe("loadIndex offline/degrades cleanly (NFR-2)", () => {
  it("throws a clean error for a missing local index", async () => {
    await expect(loadIndex("./definitely-not-here.json")).rejects.toThrow(/no index found/);
  });

  it("throws a clean error for an unreachable URL", async () => {
    await expect(loadIndex("http://127.0.0.1:1/nope.json")).rejects.toThrow(/could not reach|fetch/i);
  });
});
