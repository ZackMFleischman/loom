import { PROTOCOL_VERSION, RequestMsg } from "@loom/sidecar/protocol";
import type { EngineApi, Source } from "./engine-api";

/**
 * Engine side of the sidecar protocol: socket, reconnection, and request
 * parsing. Commands run through the shared EngineApi dispatch as "agent";
 * a throwing handler becomes an ok:false response — never an engine crash.
 */
const RECONNECT_MS = 2000;

export function startBridge(url: string, api: EngineApi): () => void {
  let ws: WebSocket | null = null;
  let stopped = false;

  function connect(): void {
    if (stopped) return;
    ws = new WebSocket(url);
    ws.onopen = () => {
      console.info(`[loom] sidecar connected (${url})`);
      // Advertise our protocol generation so a standalone plugin sidecar can
      // warn on a version skew (NFR-1). Backward-safe: an older sidecar drops
      // any message it can't parse as a response envelope.
      try {
        ws?.send(JSON.stringify({ kind: "hello", role: "engine", protocol: PROTOCOL_VERSION }));
      } catch {
        // non-fatal — the connection itself drives recovery
      }
    };
    ws.onmessage = (ev) => {
      void respond(api, String(ev.data), "agent").then((res) => {
        if (res !== null && ws?.readyState === WebSocket.OPEN) ws.send(res);
      });
    };
    ws.onclose = () => {
      ws = null;
      if (!stopped) setTimeout(connect, RECONNECT_MS);
    };
    ws.onerror = () => ws?.close();
  }

  connect();
  // Stop = no reconnects (a yielded embedded engine must never race the real
  // Output engine for "latest connection wins" at the sidecar).
  return () => {
    stopped = true;
    ws?.close();
  };
}

/** Parse a raw request, dispatch it, and serialize the response envelope. */
export async function respond(api: EngineApi, raw: string, source: Source): Promise<string | null> {
  let req: RequestMsg;
  try {
    req = RequestMsg.parse(JSON.parse(raw));
  } catch {
    return null; // not a request we can even correlate — drop it
  }
  try {
    const result = await api.handleRequest(req, source);
    return JSON.stringify({ id: req.id, kind: "res", ok: true, result });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ id: req.id, kind: "res", ok: false, error });
  }
}
