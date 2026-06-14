import type { Stage } from "@loom/runtime";
import { describe, expect, it, vi } from "vitest";
import { ProjectsController } from "../src/projects-controller";
import type { SessionStore } from "../src/session";

type FakeEntry = { id: string; pinned?: "panic" };

/** Stage/session stand-ins exposing just the surface maybeCull touches. */
function harness(opts: { entries: FakeEntry[]; live: string | null; fading?: boolean }) {
  const entries = new Map(opts.entries.map((e) => [e.id, e]));
  const destroyed: string[] = [];
  const stage = {
    get live() {
      return opts.live;
    },
    fading: opts.fading ?? false,
    onInstanceDestroyed: vi.fn((id: string) => destroyed.push(id)),
  };
  const session = {
    get: (id: string) => entries.get(id),
    destroy: vi.fn((id: string) => entries.delete(id)),
  };
  const pc = new ProjectsController({
    session: session as unknown as SessionStore,
    stage: stage as unknown as Stage,
    scenes: () => new Map(),
  });
  return { pc, stage, session, entries, destroyed };
}

/** Seed the deferred-cull state load() would normally set. */
function arm(pc: ProjectsController, loaded: string[], stale: string[]) {
  (pc as unknown as { pendingCull: unknown }).pendingCull = {
    loaded: new Set(loaded),
    stale: new Set(stale),
  };
}

describe("ProjectsController.maybeCull", () => {
  it("does nothing while the commit is still fading", () => {
    const { pc, session } = harness({ entries: [{ id: "old-1" }], live: "new-1", fading: true });
    arm(pc, ["new-1"], ["old-1"]);
    pc.maybeCull();
    expect(session.destroy).not.toHaveBeenCalled();
  });

  it("does nothing until a loaded instance is the live output", () => {
    const { pc, session } = harness({ entries: [{ id: "old-1" }], live: "old-1" });
    arm(pc, ["new-1"], ["old-1"]); // new-1 isn't live yet
    pc.maybeCull();
    expect(session.destroy).not.toHaveBeenCalled();
  });

  it("reaps the replaced instances once a loaded one is live, sparing live + pinned", () => {
    const { pc, session, destroyed } = harness({
      entries: [{ id: "old-1" }, { id: "old-2" }, { id: "panic", pinned: "panic" }, { id: "new-1" }],
      live: "new-1",
    });
    arm(pc, ["new-1"], ["old-1", "old-2", "panic", "new-1"]);
    pc.maybeCull();
    expect(destroyed.sort()).toEqual(["old-1", "old-2"]); // pinned + live spared
    // Idempotent: the cull state is cleared, a second tick is a no-op.
    session.destroy.mockClear();
    pc.maybeCull();
    expect(session.destroy).not.toHaveBeenCalled();
  });
});
