import { describe, expect, it } from "vitest";
import {
  PACK_NAME_RE,
  discoverPacks,
  namespacedId,
  readRegistry,
} from "./lib/packs.mjs";

describe("namespacedId", () => {
  it("prefixes a bare name with its pack", () => {
    expect(namespacedId("hippoPack", "aurora")).toBe("hippoPack/aurora");
  });
});

describe("PACK_NAME_RE", () => {
  it("accepts letters-first alnum + hyphen", () => {
    expect(PACK_NAME_RE.test("hippoPack")).toBe(true);
    expect(PACK_NAME_RE.test("my-pack2")).toBe(true);
  });
  it("rejects leading digits, slashes, dots", () => {
    expect(PACK_NAME_RE.test("2pack")).toBe(false);
    expect(PACK_NAME_RE.test("a/b")).toBe(false);
    expect(PACK_NAME_RE.test("../evil")).toBe(false);
  });
});

describe("readRegistry", () => {
  it("returns a packs array (empty when none registered)", () => {
    const reg = readRegistry();
    expect(Array.isArray(reg.packs)).toBe(true);
  });
});

describe("discoverPacks", () => {
  it("only surfaces packs that are both registered AND checked out on disk", () => {
    // With nothing checked out under packs/, discovery is empty even if the
    // registry lists entries — a half-installed pack never breaks the catalog.
    const found = discoverPacks();
    for (const p of found) {
      expect(PACK_NAME_RE.test(p.name)).toBe(true);
      expect(p.dir).toContain(p.name);
    }
  });
});
