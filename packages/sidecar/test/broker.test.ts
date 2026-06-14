import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Broker } from "../src/broker";

function fakeSocket() {
  return {
    sent: [] as string[],
    send(data: string) {
      this.sent.push(data);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Broker", () => {
  it("rejects immediately when no engine is connected", async () => {
    const broker = new Broker();
    await expect(broker.request("get_session", {})).rejects.toThrow(/not connected/i);
  });

  it("sends a req envelope with a unique id per request", () => {
    const broker = new Broker();
    const sock = fakeSocket();
    broker.attach(sock);
    void broker.request("get_session", {}).catch(() => {});
    void broker.request("set_param", { path: "trail", value: 0.5 }).catch(() => {});
    expect(sock.sent).toHaveLength(2);
    const [a, b] = sock.sent.map((s) => JSON.parse(s));
    expect(a.kind).toBe("req");
    expect(a.type).toBe("get_session");
    expect(b.type).toBe("set_param");
    expect(b.args).toEqual({ path: "trail", value: 0.5 });
    expect(a.id).not.toBe(b.id);
  });

  it("resolves when the matching response arrives", async () => {
    const broker = new Broker();
    const sock = fakeSocket();
    broker.attach(sock);
    const p = broker.request("get_session", {});
    const { id } = JSON.parse(sock.sent[0]!);
    broker.handleMessage(JSON.stringify({ id, kind: "res", ok: true, result: { bpm: 120 } }));
    await expect(p).resolves.toEqual({ bpm: 120 });
  });

  it("rejects with the engine's error message on a failure response", async () => {
    const broker = new Broker();
    const sock = fakeSocket();
    broker.attach(sock);
    const p = broker.request("set_param", { path: "nope", value: 1 });
    const { id } = JSON.parse(sock.sent[0]!);
    broker.handleMessage(JSON.stringify({ id, kind: "res", ok: false, error: "unknown param" }));
    await expect(p).rejects.toThrow("unknown param");
  });

  it("times out a request that never gets a response", async () => {
    const broker = new Broker();
    broker.attach(fakeSocket());
    const p = broker.request("get_session", {}, 5000);
    const assertion = expect(p).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(5001);
    await assertion;
  });

  it("rejects in-flight requests when the engine detaches", async () => {
    const broker = new Broker();
    const sock = fakeSocket();
    broker.attach(sock);
    const p = broker.request("get_session", {});
    broker.attach(null);
    await expect(p).rejects.toThrow(/disconnected/i);
    expect(broker.connected).toBe(false);
  });

  it("a late response after timeout is ignored without crashing", async () => {
    const broker = new Broker();
    const sock = fakeSocket();
    broker.attach(sock);
    const p = broker.request("get_session", {}, 1000);
    const assertion = expect(p).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
    const { id } = JSON.parse(sock.sent[0]!);
    broker.handleMessage(JSON.stringify({ id, kind: "res", ok: true, result: 1 }));
  });

  it("ignores malformed messages", () => {
    const broker = new Broker();
    broker.attach(fakeSocket());
    broker.handleMessage("not json {{{");
    broker.handleMessage(JSON.stringify({ id: "ghost", kind: "res", ok: true, result: 1 }));
    expect(broker.connected).toBe(true);
  });

  it("reports each settled request to onSettle with tool, duration, and outcome (FR-6)", async () => {
    const broker = new Broker();
    const sock = fakeSocket();
    const settled: Array<{ tool: string; outcome: string; error?: string }> = [];
    broker.onSettle = (tool, _ms, outcome, error) => settled.push({ tool, outcome, ...(error != null ? { error } : {}) });
    broker.attach(sock);

    // ok
    const p1 = broker.request("get_session", {});
    broker.handleMessage(JSON.stringify({ id: JSON.parse(sock.sent[0]!).id, kind: "res", ok: true, result: 1 }));
    await p1;
    // error
    const p2 = broker.request("set_param", { path: "x", value: 1 });
    broker.handleMessage(
      JSON.stringify({ id: JSON.parse(sock.sent[1]!).id, kind: "res", ok: false, error: "bad" }),
    );
    await expect(p2).rejects.toThrow("bad");
    // timeout
    const p3 = broker.request("screenshot", {}, 1000);
    const a3 = expect(p3).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(1001);
    await a3;

    expect(settled).toEqual([
      { tool: "get_session", outcome: "ok" },
      { tool: "set_param", outcome: "error", error: "bad" },
      { tool: "screenshot", outcome: "timeout", error: "timed out after 1000 ms" },
    ]);
  });

  it("settles in-flight requests as errors when the engine detaches", async () => {
    const broker = new Broker();
    const settled: string[] = [];
    broker.onSettle = (tool, _ms, outcome) => settled.push(`${tool}:${outcome}`);
    broker.attach(fakeSocket());
    const p = broker.request("get_session", {});
    broker.attach(null);
    await expect(p).rejects.toThrow(/disconnected/i);
    expect(settled).toEqual(["get_session:error"]);
  });
});
