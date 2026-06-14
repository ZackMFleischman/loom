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

  it("says hello on construction (presence) carrying its consoleId", () => {
    expect(page.sent).toContainEqual({ kind: "hello", consoleId: link.consoleId });
  });

  describe("reverse envelope (engine→Console requests)", () => {
    it("runs the matching op handler and replies with console-response (addressed to this console)", async () => {
      link.onConsoleOp("screenshot_console", (payload) => ({ shot: "png", echo: payload.maxWidth }));
      const replies: unknown[] = [];
      engine.onmessage = (ev) => {
        const m = ev.data as { kind?: string };
        if (m.kind === "console-response") replies.push(ev.data);
      };
      engine.postMessage({
        kind: "console-request",
        id: "e1",
        target: link.consoleId,
        op: "screenshot_console",
        payload: { maxWidth: 640 },
      });
      await vi.waitFor(() => expect(replies).toHaveLength(1));
      expect(replies[0]).toEqual({
        kind: "console-response",
        id: "e1",
        consoleId: link.consoleId,
        ok: true,
        result: { shot: "png", echo: 640 },
      });
    });

    it("ignores a request addressed to a DIFFERENT console (most-recent-hello targeting)", async () => {
      const handler = vi.fn(() => ({ shot: "png" }));
      link.onConsoleOp("screenshot_console", handler);
      const replies: unknown[] = [];
      engine.onmessage = (ev) => {
        if ((ev.data as { kind?: string }).kind === "console-response") replies.push(ev.data);
      };
      engine.postMessage({
        kind: "console-request",
        id: "e2",
        target: "some-other-console",
        op: "screenshot_console",
        payload: {},
      });
      await Promise.resolve();
      expect(handler).not.toHaveBeenCalled();
      expect(replies).toHaveLength(0);
    });

    it("replies ok:false for an unknown op", async () => {
      const replies: Array<Record<string, unknown>> = [];
      engine.onmessage = (ev) => {
        const m = ev.data as Record<string, unknown>;
        if (m.kind === "console-response") replies.push(m);
      };
      engine.postMessage({ kind: "console-request", id: "e3", target: link.consoleId, op: "nope", payload: {} });
      await vi.waitFor(() => expect(replies).toHaveLength(1));
      expect(replies[0]!.ok).toBe(false);
      expect(String(replies[0]!.error)).toMatch(/unknown console op/);
    });

    it("maps a throwing handler to ok:false (never a hang)", async () => {
      link.onConsoleOp("screenshot_console", () => {
        throw new Error("rasterizer exploded");
      });
      const replies: Array<Record<string, unknown>> = [];
      engine.onmessage = (ev) => {
        const m = ev.data as Record<string, unknown>;
        if (m.kind === "console-response") replies.push(m);
      };
      engine.postMessage({
        kind: "console-request",
        id: "e4",
        target: link.consoleId,
        op: "screenshot_console",
        payload: {},
      });
      await vi.waitFor(() => expect(replies).toHaveLength(1));
      expect(replies[0]!.ok).toBe(false);
      expect(String(replies[0]!.error)).toMatch(/rasterizer exploded/);
    });

    it("onConsoleOp returns an unregister fn", async () => {
      const off = link.onConsoleOp("op", () => "v");
      off();
      const replies: Array<Record<string, unknown>> = [];
      engine.onmessage = (ev) => {
        const m = ev.data as Record<string, unknown>;
        if (m.kind === "console-response") replies.push(m);
      };
      engine.postMessage({ kind: "console-request", id: "e5", target: link.consoleId, op: "op", payload: {} });
      await vi.waitFor(() => expect(replies).toHaveLength(1));
      expect(replies[0]!.ok).toBe(false); // handler gone → unknown op
    });
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

  it("re-arms the flush after a frame: a later write schedules a new flush", () => {
    link.sendParam("live", "a", 1);
    expect(frames.length).toBe(1);
    frames[0]!(); // flush #1
    link.sendParam("live", "a", 9);
    expect(frames.length).toBe(2); // a fresh flush is scheduled, not swallowed
    frames[1]!();
    const writes = page.sent.filter((m) => (m as { type?: string }).type === "set_param") as Array<{
      args: { value: number };
    }>;
    expect(writes.at(-1)?.args.value).toBe(9);
  });

  it("correlates by request id — ignores a response addressed to another tab", async () => {
    const other = new EngineLink({
      prefix: "u-",
      channel: engine, // shares the same engine end
      schedule: (cb) => frames.push(cb),
      now: () => Date.now(),
    });
    // The engine echoes whatever id it is asked, so each tab only matches its own.
    engine.onmessage = (ev) => {
      const m = ev.data as { id?: string; kind: string };
      if (m.kind === "req") engine.postMessage({ id: m.id, kind: "res", ok: true, result: m.id });
    };
    await expect(link.req("stage", {})).resolves.toMatch(/^t-/);
    other.dispose();
  });

  it("does not reject a request whose id never matches (pending stays until timeout)", async () => {
    engine.onmessage = (ev) => {
      const m = ev.data as { kind: string };
      if (m.kind === "req") engine.postMessage({ id: "someone-else-7", kind: "res", ok: true });
    };
    const p = link.req("commit", {});
    const expectation = expect(p).rejects.toThrow(/timed out/);
    vi.advanceTimersByTime(5001);
    await expectation;
  });

  it("emits repeated hello pings on the presence interval", () => {
    const helloCount = () => page.sent.filter((m) => (m as { kind?: string }).kind === "hello").length;
    const initial = helloCount();
    vi.advanceTimersByTime(2000); // one HELLO_MS interval
    expect(helloCount()).toBe(initial + 1);
    vi.advanceTimersByTime(2000);
    expect(helloCount()).toBe(initial + 2);
  });

  it("sends a param-range request straight out (skips coalescing)", async () => {
    engine.onmessage = (ev) => {
      const m = ev.data as { id: string; kind: string; type?: string };
      if (m.kind === "req" && m.type === "set_param_range") {
        engine.postMessage({ id: m.id, kind: "res", ok: true, result: { ok: true } });
      }
    };
    await expect(link.sendParamRange("live", "size", { min: 0, max: 4 })).resolves.toEqual({ ok: true });
    // No frame flush was scheduled by a range write.
    expect(frames.length).toBe(0);
    const ranges = page.sent.filter((m) => (m as { type?: string }).type === "set_param_range");
    expect(ranges).toHaveLength(1);
  });

  it("delivers preview frames to preview subscribers only", () => {
    const onPreview = vi.fn();
    const onState = vi.fn();
    link.subscribePreview(onPreview);
    link.subscribe(onState);
    const frame = { instance: "boot", width: 1, height: 1 };
    engine.postMessage({ kind: "preview", preview: frame });
    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(onState).not.toHaveBeenCalled();
    expect(link.preview()).toEqual(frame);
  });

  it("ignores non-object and unknown-kind messages", () => {
    const onState = vi.fn();
    link.subscribe(onState);
    engine.postMessage(null);
    engine.postMessage(42);
    engine.postMessage({ kind: "bogus" });
    expect(onState).not.toHaveBeenCalled();
  });

  it("unsubscribes cleanly (listener stops receiving)", () => {
    const onState = vi.fn();
    const off = link.subscribe(onState);
    engine.postMessage({ kind: "state", session: SESS, manifests: {} });
    expect(onState).toHaveBeenCalledTimes(1);
    off();
    engine.postMessage({ kind: "state", session: SESS, manifests: {} });
    expect(onState).toHaveBeenCalledTimes(1); // no further calls
  });

  it("dispose clears timers and closes the channel", () => {
    const closed = vi.fn();
    page.close = closed;
    link.dispose();
    expect(closed).toHaveBeenCalledTimes(1);
    const helloBefore = page.sent.filter((m) => (m as { kind?: string }).kind === "hello").length;
    vi.advanceTimersByTime(10000); // timers are gone — no new hellos
    const helloAfter = page.sent.filter((m) => (m as { kind?: string }).kind === "hello").length;
    expect(helloAfter).toBe(helloBefore);
  });
});
