import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  INDEX_SCHEMA_VERSION,
  IndexEntry,
  MarketplaceIndex,
  installHint,
  loadIndex,
  rankEntries,
  searchContent,
  toResult,
} from "../src/marketplace";
import { SearchContentArgs } from "../src/protocol";

const base = {
  name: "fooPack",
  gitUrl: "https://github.com/x/foo.git",
  description: "a foo pack",
  tags: ["retro"],
  author: "me",
  loomApi: "^1",
} as const;
const entry = (over: Partial<IndexEntry> = {}): IndexEntry => IndexEntry.parse({ ...base, ...over });

const tmp = mkdtempSync(path.join(tmpdir(), "loom-mkt-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function writeIndex(packs: unknown[]): string {
  const p = path.join(tmp, `index-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify({ schemaVersion: INDEX_SCHEMA_VERSION, packs }));
  return p;
}

describe("SearchContentArgs (FR-2 schema)", () => {
  it("defaults query to empty and accepts tags", () => {
    expect(SearchContentArgs.parse({ query: "retro" }).query).toBe("retro");
    expect(SearchContentArgs.parse({ tags: ["3d"] }).tags).toEqual(["3d"]);
  });

  it("rejects an empty request (no query and no tags)", () => {
    expect(() => SearchContentArgs.parse({})).toThrow();
    expect(() => SearchContentArgs.parse({ query: "   " })).toThrow();
  });
});

describe("MarketplaceIndex schema (FR-1 frozen)", () => {
  it("parses a valid index and rejects a wrong schemaVersion", () => {
    expect(MarketplaceIndex.parse({ schemaVersion: 1, packs: [base] }).packs.length).toBe(1);
    expect(MarketplaceIndex.safeParse({ schemaVersion: 2, packs: [] }).success).toBe(false);
  });

  it("rejects a malformed entry (bad name / non-git url)", () => {
    expect(IndexEntry.safeParse({ ...base, name: "2bad" }).success).toBe(false);
    expect(IndexEntry.safeParse({ ...base, gitUrl: "nope" }).success).toBe(false);
  });
});

describe("rankEntries (mirrors the CLI ranker)", () => {
  const packs = [
    entry({ name: "retroArcade", description: "crt", tags: ["retro", "finish"], rating: 80 }),
    entry({ name: "neonGrid", description: "an 80s retro grid", tags: ["retro"], rating: 90 }),
    entry({ name: "geoLab", description: "3d models", tags: ["3d"], rating: 50 }),
  ];

  it("ranks an exact name match first", () => {
    expect(rankEntries(packs, "retroArcade")[0]!.name).toBe("retroArcade");
  });

  it("matches across name/tag/description and excludes non-matches", () => {
    const names = rankEntries(packs, "retro").map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(["retroArcade", "neonGrid"]));
    expect(names).not.toContain("geoLab");
  });

  it("treats tags as a hard AND filter", () => {
    expect(
      rankEntries(packs, "", ["retro"])
        .map((p) => p.name)
        .sort(),
    ).toEqual(["neonGrid", "retroArcade"]);
    expect(rankEntries(packs, "", ["retro", "3d"])).toEqual([]);
  });

  it("breaks ties by rating then name", () => {
    expect(rankEntries(packs, "", ["retro"])[0]!.name).toBe("neonGrid");
  });
});

describe("installHint + toResult (FR-4 handoff)", () => {
  it("emits the exact pack:add command, with --ref when pinned", () => {
    expect(installHint(entry())).toBe("pnpm pack:add https://github.com/x/foo.git");
    expect(installHint(entry({ gitRef: "v2" }))).toBe("pnpm pack:add https://github.com/x/foo.git --ref v2");
  });
  it("toResult exposes the public search surface", () => {
    const r = toResult(entry({ rating: 7 }));
    expect(r).toMatchObject({ name: "fooPack", author: "me", loomApi: "^1", rating: 7 });
    expect(r.installHint).toContain("pack:add");
  });
});

describe("loadIndex / searchContent against a temp index", () => {
  it("loads + ranks from a written index file", async () => {
    const src = writeIndex([base, { ...base, name: "barPack", tags: ["3d"] }]);
    const results = await searchContent("foo", [], src);
    expect(results[0]!.name).toBe("fooPack");
  });

  it("loads the committed seed index (no source = default)", async () => {
    const idx = await loadIndex();
    expect(idx.schemaVersion).toBe(INDEX_SCHEMA_VERSION);
    expect(idx.packs.length).toBeGreaterThan(0);
  });
});

describe("offline/missing-index degrades cleanly (NFR-2)", () => {
  it("throws a clean error for a missing local index", async () => {
    await expect(loadIndex(path.join(tmp, "absent.json"))).rejects.toThrow(/no index found/);
  });

  it("throws a clean error for an unreachable URL", async () => {
    await expect(loadIndex("http://127.0.0.1:1/nope.json")).rejects.toThrow(/could not reach|fetch/i);
  });

  it("throws a clean error for an invalid (schema-violating) index", async () => {
    const bad = path.join(tmp, "bad.json");
    writeFileSync(bad, JSON.stringify({ schemaVersion: 1, packs: [{ name: "2bad" }] }));
    await expect(loadIndex(bad)).rejects.toThrow(/invalid/i);
  });
});
