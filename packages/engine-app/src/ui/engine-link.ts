import type { PreviewFrame, SessionSnapshot } from "@loom/sidecar/protocol";

/** One tweakable param as the engine describes it over the channel. */
export type ParamDesc = {
  type: "float" | "int" | "bool" | "color";
  value: number | boolean | string;
  default: number | boolean | string;
  min?: number;
  max?: number;
  step?: number;
  /** Value names for int selectors (palette.source) — UI renders a toggle. */
  labels?: string[];
  /** Per-option color previews (palette-index sliders) — UI renders a chooser. */
  swatches?: string[][];
  /** Active color space when a color param is decomposed into channels. */
  colorSpace?: "hex" | "hsv" | "rgb";
  /** Set on a channel param: the color path it drives (e.g. "palette.primary.2"). */
  channelOf?: string;
  /** Channel letter for a channel param: "h"/"s"/"v" or "r"/"g"/"b". */
  channel?: string;
  description?: string;
  /** Hidden from the default params box (e.g. the auto-added input trim); the
   *  panel's "advanced" toggle reveals it. Stays fully live regardless. */
  hidden?: boolean;
  /** Active modulator config, or null when the param is hand-driven (FR-8). */
  modulator?: Record<string, unknown> | null;
  /** Author-declared [min, max]; present only when the live range was overridden. */
  defaultRange?: [number, number];
};

export type Manifests = Record<string, Record<string, ParamDesc>>;

export type EngineSnapshot = {
  session: SessionSnapshot | null;
  manifests: Manifests;
  connected: boolean;
};

/** The BroadcastChannel surface EngineLink needs — injectable for unit tests. */
export type ChannelLike = {
  postMessage(msg: unknown): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  close(): void;
};

export type EngineLinkOptions = {
  /** Per-tab request-id prefix so pages sharing the channel ignore each other's responses. */
  prefix: string;
  channel?: ChannelLike;
  /** Frame scheduler for write coalescing (rAF in the browser). */
  schedule?: (cb: () => void) => void;
  now?: () => number;
};

const HELLO_MS = 2000;
const CONNECTED_POLL_MS = 500;
const STALE_MS = 1500;
const REQ_TIMEOUT_MS = 5000;

const defaultSchedule: (cb: () => void) => void =
  typeof requestAnimationFrame === "function"
    ? (cb) => requestAnimationFrame(() => cb())
    : (cb) => void setTimeout(cb, 16);

/**
 * The page side of the Console link: request/response envelopes over
 * BroadcastChannel("loom") (same shapes as the sidecar wire), hello-presence,
 * and external stores (state, thumbs) shaped for useSyncExternalStore.
 * React-free on purpose — unit-tested in Node with a fake channel.
 */
export class EngineLink {
  private readonly ch: ChannelLike;
  private readonly prefix: string;
  private readonly schedule: (cb: () => void) => void;
  private readonly now: () => number;

  private seq = 0;
  private readonly pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  private snapshot: EngineSnapshot = { session: null, manifests: {}, connected: false };
  private readonly listeners = new Set<() => void>();
  private thumbsMap: Record<string, string> = {};
  private readonly thumbListeners = new Set<() => void>();
  private previewFrame: PreviewFrame | null = null;
  private readonly previewListeners = new Set<() => void>();

  private lastStateAt = -Infinity;
  private readonly timers: Array<ReturnType<typeof setInterval>> = [];

  private readonly queued = new Map<
    string,
    { instance: string; path: string; value: number | boolean | string }
  >();
  private flushScheduled = false;

  constructor(opts: EngineLinkOptions) {
    this.prefix = opts.prefix;
    // BroadcastChannel's DOM onmessage is typed for MessageEvent; ChannelLike
    // only needs `{ data }`. Structurally compatible at runtime — cast across.
    this.ch = opts.channel ?? (new BroadcastChannel("loom") as unknown as ChannelLike);
    this.schedule = opts.schedule ?? defaultSchedule;
    this.now = opts.now ?? (() => performance.now());

    this.ch.onmessage = (ev) => this.onMessage(ev.data);
    this.ch.postMessage({ kind: "hello" });
    this.timers.push(setInterval(() => this.ch.postMessage({ kind: "hello" }), HELLO_MS));
    this.timers.push(
      setInterval(() => {
        const connected = this.now() - this.lastStateAt < STALE_MS;
        if (connected !== this.snapshot.connected) {
          this.snapshot = { ...this.snapshot, connected };
          this.emit();
        }
      }, CONNECTED_POLL_MS),
    );
  }

  // Stable identities for useSyncExternalStore.
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getSnapshot = (): EngineSnapshot => this.snapshot;
  subscribeThumbs = (fn: () => void): (() => void) => {
    this.thumbListeners.add(fn);
    return () => {
      this.thumbListeners.delete(fn);
    };
  };
  thumb = (id: string): string | undefined => this.thumbsMap[id];

  // Full-res preview stream (Console preview overlay). The latest frame, plus a
  // store shaped for useSyncExternalStore.
  subscribePreview = (fn: () => void): (() => void) => {
    this.previewListeners.add(fn);
    return () => {
      this.previewListeners.delete(fn);
    };
  };
  preview = (): PreviewFrame | null => this.previewFrame;

  req(type: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const id = `${this.prefix}${++this.seq}`;
    return new Promise((resolve, reject) => {
      // Register pending BEFORE posting: a synchronous channel (the test fake)
      // delivers the response inside postMessage, so the handler must already
      // find this id. Real BroadcastChannel is async, so ordering is harmless.
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${type} timed out — engine not responding`));
      }, REQ_TIMEOUT_MS);
      this.ch.postMessage({ id, kind: "req", type, args });
    });
  }

  /** Frame-coalesced param writes: drags feel instant without flooding the channel. */
  sendParam(instance: string, path: string, value: number | boolean | string): void {
    this.queued.set(`${instance}:${path}`, { instance, path, value });
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    this.schedule(() => {
      this.flushScheduled = false;
      for (const w of this.queued.values()) {
        void this.req("set_param", { instance: w.instance, path: w.path, value: w.value }).catch(
          (err) => console.error("[loom-ui]", err),
        );
      }
      this.queued.clear();
    });
  }

  /**
   * Widen/narrow a slider's bounds (Console power-tool). Occasional, so it skips
   * the frame-coalesced write path and goes straight out as a request.
   */
  sendParamRange(
    instance: string,
    path: string,
    opts: { min?: number; max?: number; restoreDefault?: boolean },
  ): Promise<unknown> {
    return this.req("set_param_range", { instance, path, ...opts });
  }

  dispose(): void {
    for (const t of this.timers) clearInterval(t);
    this.ch.close();
  }

  private onMessage(data: unknown): void {
    if (typeof data !== "object" || data === null) return;
    const msg = data as { kind?: string } & Record<string, unknown>;
    if (msg.kind === "res") {
      const p = this.pending.get(msg.id as string);
      if (!p) return; // another tab's response
      this.pending.delete(msg.id as string);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(String(msg.error)));
      return;
    }
    if (msg.kind === "state") {
      this.lastStateAt = this.now();
      this.snapshot = {
        session: msg.session as SessionSnapshot,
        manifests: (msg.manifests as Manifests | undefined) ?? {},
        connected: true,
      };
      this.emit();
      return;
    }
    if (msg.kind === "thumbs") {
      this.thumbsMap = { ...this.thumbsMap, ...(msg.thumbs as Record<string, string>) };
      this.emitThumbs();
      return;
    }
    if (msg.kind === "preview") {
      this.previewFrame = msg.preview as PreviewFrame;
      for (const fn of this.previewListeners) fn();
    }
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
  private emitThumbs(): void {
    for (const fn of this.thumbListeners) fn();
  }
}
