import { describe, expect, it } from "vitest";
import { Stage } from "../src/stage";
import { F } from "./helpers";

describe("Stage", () => {
  it("starts with the boot instance live, nothing staged", () => {
    const s = new Stage("live");
    expect(s.live).toBe("live");
    expect(s.staged).toBeNull();
    expect(s.tick(F(0))).toEqual({ mode: "single", live: "live" });
  });

  it("staging marks a candidate without touching live; restaging replaces", () => {
    const s = new Stage("live");
    s.stage("a");
    expect(s.staged).toBe("a");
    expect(s.live).toBe("live");
    s.stage("b");
    expect(s.staged).toBe("b");
    s.unstage();
    expect(s.staged).toBeNull();
  });

  it("staging the live instance is rejected", () => {
    const s = new Stage("live");
    expect(() => s.stage("live")).toThrow(/already live/i);
  });

  it("commit crossfades from the next frame boundary and promotes at the end", () => {
    const s = new Stage("live");
    s.stage("a");
    s.commit(F(10), 4); // fade runs over frames 11..15
    expect(s.tick(F(10))).toEqual({ mode: "single", live: "live" }); // not yet

    const mixes: number[] = [];
    for (let f = 11; f < 15; f++) {
      const d = s.tick(F(f));
      expect(d.mode).toBe("crossfade");
      if (d.mode === "crossfade") {
        expect(d.live).toBe("live");
        expect(d.staged).toBe("a");
        mixes.push(d.mix);
      }
    }
    // monotonic, every fade frame is a true blend: 0 < mix < 1
    expect(mixes[0]).toBeGreaterThan(0);
    for (let i = 1; i < mixes.length; i++) expect(mixes[i]).toBeGreaterThan(mixes[i - 1]!);
    expect(mixes.at(-1)!).toBeLessThan(1);

    expect(s.tick(F(15))).toEqual({ mode: "single", live: "a" }); // promoted
    expect(s.live).toBe("a");
    expect(s.staged).toBeNull();
  });

  it("commit with nothing staged, mid-fade, or while panicked throws", () => {
    const s = new Stage("live");
    expect(() => s.commit(F(0))).toThrow(/nothing staged/i);
    s.stage("a");
    s.commit(F(0), 10);
    s.tick(F(1));
    s.stage("b");
    expect(() => s.commit(F(2))).toThrow(/in progress/i);
    const p = new Stage("live");
    p.stage("a");
    p.panic();
    expect(() => p.commit(F(0))).toThrow(/panic/i);
  });

  it("panic holds the output, cancels an in-flight fade, and resume returns to live", () => {
    const s = new Stage("live");
    s.stage("a");
    s.commit(F(0), 10);
    s.tick(F(3)); // mid-fade
    s.panic();
    expect(s.panicked).toBe(true);
    expect(s.panicActive).toBe("hold");
    expect(s.tick(F(4))).toEqual({ mode: "hold" });
    s.resume();
    expect(s.panicked).toBe(false);
    expect(s.panicActive).toBeNull();
    // fade was cancelled: still the old live, candidate still staged
    expect(s.tick(F(5))).toEqual({ mode: "single", live: "live" });
    expect(s.staged).toBe("a");
  });

  it("scene-panic routes the panic instance without moving LIVE; resume hard-cuts back", () => {
    const s = new Stage("live");
    s.panic("scene", "panic");
    expect(s.panicked).toBe(true);
    expect(s.panicActive).toBe("scene");
    expect(s.panicSceneId).toBe("panic");
    // Output override only: the LIVE pointer is untouched (FR-4).
    expect(s.live).toBe("live");
    expect(s.tick(F(0))).toEqual({ mode: "panic-scene", panic: "panic", live: "live" });
    s.resume();
    // Hard cut straight back to the prior live instance.
    expect(s.panicActive).toBeNull();
    expect(s.tick(F(1))).toEqual({ mode: "single", live: "live" });
  });

  it("scene-panic cancels an in-flight crossfade first (FR-9)", () => {
    const s = new Stage("live");
    s.stage("a");
    s.commit(F(0), 10);
    s.tick(F(3)); // mid-fade
    s.panic("scene", "panic");
    expect(s.tick(F(4))).toEqual({ mode: "panic-scene", panic: "panic", live: "live" });
    s.resume();
    // Fade was cancelled: back to the old live, candidate still staged.
    expect(s.tick(F(5))).toEqual({ mode: "single", live: "live" });
    expect(s.staged).toBe("a");
  });

  it("re-press escalates hold→scene, but scene→hold is a no-op (FR-6)", () => {
    const s = new Stage("live");
    s.panic("hold");
    expect(s.panicActive).toBe("hold");
    // Escalate: flip the arm to SAFE SCENE and re-press.
    s.panic("scene", "panic");
    expect(s.panicActive).toBe("scene");
    expect(s.tick(F(0))).toEqual({ mode: "panic-scene", panic: "panic", live: "live" });
    // Re-press in hold while scene is active does not downgrade.
    s.panic("hold");
    expect(s.panicActive).toBe("scene");
    expect(s.tick(F(1))).toEqual({ mode: "panic-scene", panic: "panic", live: "live" });
  });

  it("scene-panic with no panic instance falls back to hold (FR-7)", () => {
    const s = new Stage("live");
    s.panic("scene", null);
    expect(s.panicActive).toBe("hold");
    expect(s.tick(F(0))).toEqual({ mode: "hold" });
  });

  it("double-resume is a harmless no-op", () => {
    const s = new Stage("live");
    s.panic("scene", "panic");
    s.resume();
    s.resume();
    expect(s.panicked).toBe(false);
    expect(s.tick(F(0))).toEqual({ mode: "single", live: "live" });
  });

  it("destroying the panic instance mid scene-panic degrades to hold", () => {
    const s = new Stage("live");
    s.panic("scene", "panic");
    s.onInstanceDestroyed("panic");
    expect(s.panicActive).toBe("hold");
    expect(s.tick(F(0))).toEqual({ mode: "hold" });
  });

  it("commit while scene-panicked is refused", () => {
    const s = new Stage("live");
    s.stage("a");
    s.panic("scene", "panic");
    expect(() => s.commit(F(0))).toThrow(/panic/i);
  });

  it("destroying the staged instance unstages it and cancels a fade to it", () => {
    const s = new Stage("live");
    s.stage("a");
    s.commit(F(0), 10);
    s.tick(F(2));
    s.onInstanceDestroyed("a");
    expect(s.staged).toBeNull();
    expect(s.tick(F(3))).toEqual({ mode: "single", live: "live" });
  });

  it("destroying the live instance leaves live null; an unrelated id is a no-op", () => {
    const s = new Stage("live");
    s.stage("a");
    s.onInstanceDestroyed("zzz");
    expect(s.live).toBe("live");
    expect(s.staged).toBe("a");
    s.onInstanceDestroyed("live");
    expect(s.live).toBeNull();
    expect(s.tick(F(0))).toEqual({ mode: "single", live: null });
  });

  it("renaming an instance carries the live/staged pointers and an in-flight fade", () => {
    const s = new Stage("live");
    s.stage("a");
    s.onInstanceRenamed("live", "main");
    s.onInstanceRenamed("a", "candidate");
    expect(s.live).toBe("main");
    expect(s.staged).toBe("candidate");
    s.commit(F(0), 10);
    s.tick(F(2)); // mid-fade
    s.onInstanceRenamed("candidate", "winner");
    for (let f = 3; f < 12; f++) s.tick(F(f));
    expect(s.tick(F(12))).toEqual({ mode: "single", live: "winner" });
  });

  it("adoptLive fills an empty live slot but never replaces one", () => {
    const s = new Stage();
    expect(s.live).toBeNull();
    s.adoptLive("boot");
    expect(s.live).toBe("boot");
    expect(() => s.adoptLive("other")).toThrow(/commit/i);
  });

  it("a zero-frame fade is a hard cut at the boundary", () => {
    const s = new Stage("live");
    s.stage("a");
    s.commit(F(0), 0);
    expect(s.tick(F(1))).toEqual({ mode: "single", live: "a" });
  });

  it("a one-frame fade shows a single 50% blend frame", () => {
    const s = new Stage("live");
    s.stage("a");
    s.commit(F(0), 1);
    expect(s.tick(F(1))).toEqual({ mode: "crossfade", live: "live", staged: "a", mix: 0.5 });
    expect(s.tick(F(2))).toEqual({ mode: "single", live: "a" });
  });
});
