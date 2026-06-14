import { ResponseMsg, type RequestType } from "./protocol";

/** Minimal surface the broker needs from a socket; `ws` satisfies it. */
export interface SocketLike {
  send(data: string): void;
}

interface Pending {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Correlates sidecar requests with engine responses over a single attached
 * socket. Transport-agnostic so it unit-tests with fake sockets; index.ts
 * attaches the live `ws` connection (latest connection wins).
 */
export class Broker {
  private socket: SocketLike | null = null;
  private readonly pending = new Map<string, Pending>();
  private seq = 0;

  get connected(): boolean {
    return this.socket !== null;
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
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${type} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ id, kind: "req", type, args }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
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
    if (msg.ok) entry.resolve(msg.result);
    else entry.reject(new Error(msg.error));
  }

  private rejectAll(err: Error): void {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
  }
}
