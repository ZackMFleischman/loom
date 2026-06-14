import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSnapshot } from "@loom/sidecar/protocol";
import { EngineLink, type ChannelLike } from "../src/ui/engine-link";

/** Two-ended in-memory stand-in for BroadcastChannel("loom"). */
class FakeChannel implements ChannelLike {
  other: FakeChannel | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  sent: unknown[] = [];
  postMessage(msg: unknown): void {
    this.sent.push(msg);
    this.other?.onmessage?.({ data: msg });
  }
  close(): void {}
}

const SESS = { live: "boot", staged: null } as unknown as SessionSnapshot;

describe("EngineLink", () => {
  let page: FakeChannel; // the page end (EngineLink owns it)
  let engine: FakeChannel; // the engine end (the test plays the engine)
  let frames: Array<() => void>;
  let link: EngineLink;

  beforeEach(() => {
    vi.useFakeTimers();
    page = new FakeChannel();
    engine = new FakeChannel();
    page.other = engine;
    engine.other = page;
    frames = [];
    link = new EngineLink({
      prefix: "t-",
      channel: page,
      schedule: (cb) => frames.push(cb),
      now: () => Date.now(),
    });
  });

  afterEach(() => {
    link.dispose();
    vi.useRealTimers();
  });

  it("says hello on construction (presence)", () => {
    expect(page.sent).toContainEqual({ kind: "hello" });
  });

  it("resolves a request with the matching ok response", async () => {
    engine.onmessage = (ev) => {
      const m = ev.data as { id: string; kind: string; type: string };
      if (m.kind === "req" && m.type === "stage") {
        engine.postMessage({ id: m.id, kind: "res", ok: true, result: { staged: "x" } });
      }
    };
    await expect(link.req("stage", { instance: "x" })).resolves.toEqual({ staged: "x" });
  });

  it("rejects a request on an error response", async () => {
    engine.onmessage = (ev) => {
      const m = ev.data as { id: string; kind: string };
      if (m.kind === "req") engine.postMessage({ id: m.id, kind: "res", ok: false, error: "nope" });
    };
    await expect(link.req("commit", {})).rejects.toThrow("nope");
  });

  it("times out an unanswered request after 5s", async () => {
    const p = link.req("stage", {});
    const expectation = expect(p).rejects.toThrow(/timed out/);
    vi.advanceTimersByTime(5001);
    await expectation;
  });

  it("publishes state snapshots and flips connected", () => {
    expect(link.getSnapshot().connected).toBe(false);
    engine.postMessage({ kind: "state", session: SESS, manifests: { boot: {} } });
    const snap = link.getSnapshot();
    expect(snap.connected).toBe(true);
    expect(snap.session).toEqual(SESS);
    expect(snap.manifests).toEqual({ boot: {} });
    // No further state for >1.5s → disconnected (polled every 500ms).
    vi.advanceTimersByTime(2000);
    expect(link.getSnapshot().connected).toBe(false);
  });

  it("notifies subscribers on state and on thumbs separately", () => {
    const onState = vi.fn();
    const onThumbs = vi.fn();
    link.subscribe(onState);
    link.subscribeThumbs(onThumbs);
    engine.postMessage({ kind: "state", session: SESS, manifests: {} });
    engine.postMessage({ kind: "thumbs", thumbs: { boot: "data:image/png;base64,x" } });
    expect(onState).toHaveBeenCalledTimes(1);
    expect(onThumbs).toHaveBeenCalledTimes(1);
    expect(link.thumb("boot")).toBe("data:image/png;base64,x");
  });

  it("coalesces param writes per instance:path per frame", () => {
    link.sendParam("live", "a", 1);
    link.sendParam("live", "a", 2);
    link.sendParam("live", "b", 3);
    expect(frames.length).toBe(1); // one scheduled flush
    const before = page.sent.filter((m) => (m as { type?: string }).type === "set_param").length;
    expect(before).toBe(0);
    frames[0]!();
    const writes = page.sent.filter((m) => (m as { type?: string }).type === "set_param") as Array<{
      args: { path: string; value: number };
    }>;
    expect(writes).toHaveLength(2);
    expect(writes.find((w) => w.args.path === "a")?.args.value).toBe(2);
    expect(writes.find((w) => w.args.path === "b")?.args.value).toBe(3);
  });
});
