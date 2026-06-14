import { ResponseMsg, type RequestType } from "./protocol";

/** Minimal surface the broker needs from a socket; `ws` satisfies it. */
export interface SocketLike {
  send(data: string): void;
}

interface Pending {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** The tool + mint time, for the latency hook (FR-6). */
  type: RequestType;
  t0: number;
}

/**
 * Correlates sidecar requests with engine responses over a single attached
 * socket. Transport-agnostic so it unit-tests with fake sockets; index.ts
 * attaches the live `ws` connection (latest connection wins).
 */
/** Settle outcome for a request, reported to {@link Broker.onSettle} (FR-6). */
export type Outcome = "ok" | "error" | "timeout";

export class Broker {
  private socket: SocketLike | null = null;
  private readonly pending = new Map<string, Pending>();
  private seq = 0;

  /**
   * Per-request latency hook (FR-6): called when a request settles, with the
   * tool name, mint-to-settle duration in ms, the outcome, and an error message
   * when it failed. Set by index.ts to feed ToolMetrics. Wrapped so a bad hook
   * can never break a tool call.
   */
  onSettle: ((tool: RequestType, durationMs: number, outcome: Outcome, error?: string) => void) | null = null;

  get connected(): boolean {
    return this.socket !== null;
  }

  private settle(type: RequestType, t0: number, outcome: Outcome, error?: string): void {
    if (this.onSettle == null) return;
    try {
      this.onSettle(type, performance.now() - t0, outcome, error);
    } catch {
      // metrics must never break a request
    }
  }

  /** Attach the live engine socket, or null on disconnect (rejects in-flight). */
  attach(socket: SocketLike | null): void {
    this.socket = socket;
    if (socket === null) this.rejectAll(new Error("engine disconnected"));
  }

  request(type: RequestType, args: Record<string, unknown>, timeoutMs = 5000): Promise<unknown> {
    if (this.socket === null) {
      return Promise.reject(
        new Error("engine not connected — is the Output window running (`pnpm dev`)?"),
      );
    }
    const id = `r${++this.seq}`;
    const socket = this.socket;
    const t0 = performance.now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.settle(type, t0, "timeout", `timed out after ${timeoutMs} ms`);
        reject(new Error(`${type} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, type, t0 });
      try {
        socket.send(JSON.stringify({ id, kind: "req", type, args }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        const e = err instanceof Error ? err : new Error(String(err));
        this.settle(type, t0, "error", e.message);
        reject(e);
      }
    });
  }

  /** Feed a raw engine message in; malformed or unknown-id messages are ignored. */
  handleMessage(raw: string): void {
    let msg: ResponseMsg;
    try {
      msg = ResponseMsg.parse(JSON.parse(raw));
    } catch {
      return;
    }
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.ok) {
      this.settle(entry.type, entry.t0, "ok");
      entry.resolve(msg.result);
    } else {
      this.settle(entry.type, entry.t0, "error", msg.error);
      entry.reject(new Error(msg.error));
    }
  }

  private rejectAll(err: Error): void {
    for (const { reject, timer, type, t0 } of this.pending.values()) {
      clearTimeout(timer);
      this.settle(type, t0, "error", err.message);
      reject(err);
    }
    this.pending.clear();
  }
}
