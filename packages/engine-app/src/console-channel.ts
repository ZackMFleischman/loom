import { respond } from "./bridge";
import type { EngineApi } from "./engine-api";
import { workerInterval } from "./worker-clock";

const STATE_MS = 100; // ~10 fps session state
const THUMBS_MS = 150; // ~6.6 fps tile thumbnails
const PREVIEW_MS = 120; // ~8 fps full-res preview overlay stream
const PRESENCE_TIMEOUT_MS = 5000;
/** Engine-side timeout for a reverse (engine→Console) request (FR-5). */
const CONSOLE_REQUEST_TIMEOUT_MS = 3000;

export type ConsoleChannelOpts = {
  /** This engine runs inside the Console's hidden iframe (solo mode). */
  embedded?: boolean;
  /** Called once when this engine must stand down for another engine. */
  onYield?: () => void;
};

/**
 * Engine side of the Console link: same request/response envelopes as the
 * sidecar wire, plus periodic state and thumbnail broadcasts — but only
 * while a Console has said hello recently. Works with the sidecar (and the
 * agent) completely absent.
 *
 * State broadcasts carry `engineId`/`embedded`, which doubles as engine
 * presence detection: an EMBEDDED engine that hears another engine's state
 * yields (the real Output window always wins; between two embedded peers the
 * smaller id survives). A yielded engine stops broadcasting AND stops
 * answering requests — two engines answering one request id would race.
 */
export function startConsoleChannel(api: EngineApi, opts: ConsoleChannelOpts = {}): void {
  const ch = new BroadcastChannel("loom");
  const engineId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let lastHello = -Infinity;
  let yielded = false;
  const consolePresent = () => performance.now() - lastHello < PRESENCE_TIMEOUT_MS;

  // Reverse-envelope (engine→Console) state (Phase 2). `targetConsoleId` is the
  // most-recently-hello'd Console — the one the performer just touched (decision
  // #3). The pending map mirrors the bridge's: a correlation id → resolver, each
  // with a ~3s timeout (FR-5) so a self-capture that throws or stalls becomes a
  // clean tool error, never a hung request.
  let targetConsoleId: string | null = null;
  let reqSeq = 0;
  const pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();

  /**
   * Generic engine→Console request (NFR-2 — not screenshot-specific): send
   * `{ kind:"console-request", id, target, op, payload }` to the most-recent
   * Console and resolve with its `console-response.result`. Rejects on the
   * Console's error, on no Console connected, or on the timeout.
   */
  const requestConsole = (op: string, payload: Record<string, unknown> = {}): Promise<unknown> => {
    if (yielded) return Promise.reject(new Error("engine has stood down"));
    if (targetConsoleId == null || !consolePresent()) {
      return Promise.reject(new Error("no Console connected — open /console.html"));
    }
    const id = `e${engineId}-${++reqSeq}`;
    const target = targetConsoleId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.delete(id)) reject(new Error("console did not answer"));
      }, CONSOLE_REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      ch.postMessage({ kind: "console-request", id, target, op, payload });
    });
  };
  api.setConsoleRequester(requestConsole);

  const standDown = () => {
    if (yielded) return;
    yielded = true;
    // Reject any in-flight reverse requests so callers don't hang on the timeout.
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error("engine has stood down"));
    }
    pending.clear();
    console.info("[loom] another engine is live on this origin — this one is standing down");
    opts.onYield?.();
  };

  ch.onmessage = (ev) => {
    const data: unknown = ev.data;
    if (typeof data !== "object" || data === null) return;
    const msg = data as {
      kind?: string;
      engineId?: string;
      embedded?: boolean;
      consoleId?: string;
      id?: string;
      ok?: boolean;
      result?: unknown;
      error?: string;
    };
    if (msg.kind === "state") {
      // Another engine broadcasting on this origin (BroadcastChannel never
      // echoes to the sender). Embedded engines defer to the Output window;
      // embedded peers tie-break on id.
      if (opts.embedded && (msg.embedded !== true || (msg.engineId ?? "") < engineId)) {
        standDown();
      }
      return;
    }
    if (yielded) return;
    if (msg.kind === "hello") {
      lastHello = performance.now();
      // Target the most-recently-hello'd Console (decision #3). Older Consoles
      // keep pinging too, but the last hello wins each round.
      if (typeof msg.consoleId === "string") targetConsoleId = msg.consoleId;
      api.markConsolePresent(); // lets the render loop mirror the live canvas
      return;
    }
    if (msg.kind === "console-response") {
      // Reply to a reverse request we issued. Correlate by id; ignore stragglers.
      const id = msg.id;
      if (typeof id !== "string") return;
      const p = pending.get(id);
      if (p == null) return;
      pending.delete(id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(typeof msg.error === "string" ? msg.error : "console request failed"));
      return;
    }
    if (msg.kind === "req") {
      void respond(api, JSON.stringify(data), "human").then((res) => {
        if (res !== null && !yielded) ch.postMessage(JSON.parse(res));
      });
    }
  };

  // Worker clocks, not setInterval: main-thread timers clamp to >=1 s when
  // the Output tab is hidden, which froze the Console's state and previews.
  workerInterval(() => {
    if (!yielded && consolePresent()) {
      ch.postMessage({ kind: "state", engineId, embedded: opts.embedded === true, ...api.consoleState() });
    }
  }, STATE_MS);

  let thumbsBusy = false;
  workerInterval(() => {
    if (yielded || !consolePresent() || thumbsBusy) return;
    thumbsBusy = true;
    void api
      .thumbnails()
      .then((thumbs) => {
        if (!yielded) ch.postMessage({ kind: "thumbs", thumbs });
      })
      .catch(() => {})
      .finally(() => {
        thumbsBusy = false;
      });
  }, THUMBS_MS);

  // Full-res preview stream: only runs while a preview overlay is open. Its own
  // (slower) cadence keeps the heavier readback off the thumbnail loop, and the
  // busy guard drops frames rather than queueing if a readback runs long.
  let previewBusy = false;
  workerInterval(() => {
    if (yielded || !consolePresent() || previewBusy || !api.previewActive()) return;
    previewBusy = true;
    void api
      .previewFrame()
      .then((preview) => {
        if (!yielded && preview != null) ch.postMessage({ kind: "preview", preview });
      })
      .catch(() => {})
      .finally(() => {
        previewBusy = false;
      });
  }, PREVIEW_MS);
}
