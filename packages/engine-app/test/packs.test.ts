import { describe, expect, it } from "vitest";
import { mergeNamespaced, packNameFromPath } from "../src/packs";

describe("packNameFromPath", () => {
  it("extracts the pack name from a packs/<name>/… path", () => {
    expect(packNameFromPath("../../../packs/hippoPack/scenes/aurora.scene.ts")).toBe("hippoPack");
    expect(packNameFromPath("/abs/packs/my-pack/modules/effects/glow.ts")).toBe("my-pack");
  });

  it("returns null for non-pack (local content) paths", () => {
    expect(packNameFromPath("../../../content/scenes/aurora.scene.ts")).toBeNull();
    expect(packNameFromPath("nothing")).toBeNull();
  });
});

describe("mergeNamespaced precedence", () => {
  it("namespaces pack items as <pack>/<id> and keeps local bare", () => {
    const local = new Map([["aurora", "local-aurora"]]);
    const merged = mergeNamespaced(local, [
      { pack: "hippoPack", id: "aurora", value: "pack-aurora" },
      { pack: "hippoPack", id: "swarm", value: "pack-swarm" },
    ]);
    expect(merged.get("aurora")).toBe("local-aurora");
    expect(merged.get("hippoPack/aurora")).toBe("pack-aurora");
    expect(merged.get("hippoPack/swarm")).toBe("pack-swarm");
  });

  it("LOCAL WINS a bare-name collision (deterministic, order-independent)", () => {
    // A pack item with the same bare name is only reachable namespaced; a bare
    // lookup must always resolve local — the marketplace relies on this.
    const local = new Map([["glow", "local-glow"]]);
    const merged = mergeNamespaced(local, [
      { pack: "fx", id: "glow", value: "pack-glow" },
    ]);
    expect(merged.get("glow")).toBe("local-glow");
    expect(merged.get("fx/glow")).toBe("pack-glow");
  });

  it("two packs with the same bare name stay distinct (no cross-pack clobber)", () => {
    const merged = mergeNamespaced(new Map(), [
      { pack: "a", id: "glow", value: "a-glow" },
      { pack: "b", id: "glow", value: "b-glow" },
    ]);
    expect(merged.get("a/glow")).toBe("a-glow");
    expect(merged.get("b/glow")).toBe("b-glow");
  });
});
