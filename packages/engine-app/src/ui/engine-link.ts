import type { InstanceInfo, PreviewFrame, SessionSnapshot } from "@loom/sidecar/protocol";

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

/**
 * One instance's slice (the fields a Tile actually reads), exposed as its own
 * external store so a Tile re-renders on ITS data only — not on every 10 Hz
 * state broadcast (FR-1). Mirrors the `InstanceInfo` subset the Tile/ParamPanel
 * touch; the EngineLink keeps a STABLE reference for an unchanged instance
 * across ticks so `useSyncExternalStore` bails out of the re-render.
 */
export type InstanceSlice = InstanceInfo;

/**
 * Session-level scalars Header reads (bpm/rms/fps/frame/audio/midi/projects/…).
 * Split out so the Header re-renders only when one of these changes, not on the
 * per-instance churn that dominates a busy session.
 */
export type SessionMeta = Omit<SessionSnapshot, "instances">;

/** The session-level pointers a Tile reads (which tile is live/staged + PANIC). */
export type StagePointers = { live: string | null; staged: string | null; panicked: boolean };

/**
 * The narrow projection a Tile actually DISPLAYS (FR-1). Deliberately excludes
 * the high-churn telemetry a tile never shows — `slowSignals` (whose sort order
 * flickers between near-equal tiny EMAs every tick) and `nodes`/`chain`/
 * `modulators` (ParamPanel's concern) — so a tile wakes only when its own
 * visible state changes, not on every engine tick. `frameMs` is quantized to the
 * 0.1 ms the `.framems`/`tilefps` readouts show.
 */
export type TileSlice = {
  id: string;
  scene: string;
  status: InstanceInfo["status"];
  error: string | null;
  frameMs: number;
  pinned: "panic" | null;
};

function toTileSlice(inst: InstanceInfo): TileSlice {
  return {
    id: inst.id,
    scene: inst.scene,
    status: inst.status,
    error: inst.error ?? null,
    frameMs: Math.round((inst.frameMs ?? 0) * 10) / 10,
    pinned: inst.pinned ?? null,
  };
}

/**
 * Quantize an instance's live telemetry to the precision the UI shows, so a
 * sub-display-threshold wiggle doesn't change the slice's identity and wake the
 * tile (FR-1). `frameMs` → 0.1 ms (the `.framems` / `tilefps` granularity);
 * `slowSignals` ms → 0.1 (the PerfOverlay shows 2dp but it's not a tile reader
 * and reads the whole snapshot anyway). Returns a NEW object only when a value
 * actually changed at that precision — identity-preserving downstream.
 */
function quantizeTelemetry(inst: InstanceInfo): InstanceInfo {
  const r1 = (n: number) => Math.round(n * 10) / 10;
  return {
    ...inst,
    frameMs: r1(inst.frameMs ?? 0),
    slowSignals: (inst.slowSignals ?? []).map((s) => ({ label: s.label, ms: r1(s.ms) })),
  };
}

/** The BroadcastChannel surface EngineLink needs — injectable for unit tests. */
export type ChannelLike = {
  postMessage(msg: unknown): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  close(): void;
};

/**
 * Handler for an engine→Console reverse request (the generic reverse-envelope
 * primitive). Keyed by `op`; returns the response payload (resolved into the
 * `console-response`). A throw becomes an `ok:false` response — never a hang.
 */
export type ConsoleOpHandler = (payload: Record<string, unknown>) => Promise<unknown> | unknown;

export type EngineLinkOptions = {
  /** Per-tab request-id prefix so pages sharing the channel ignore each other's responses. */
  prefix: string;
  channel?: ChannelLike;
  /** Frame scheduler for write coalescing (rAF in the browser). */
  schedule?: (cb: () => void) => void;
  now?: () => number;
  /** Stable id announced in `hello` so the engine can address THIS Console
   *  (most-recent-hello targeting). Defaults to the request-id prefix. */
  consoleId?: string;
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
  /** This Console's stable id, announced in `hello` for reverse-request targeting. */
  readonly consoleId: string;
  /** Reverse-request op handlers (engine→Console), keyed by op name. */
  private readonly opHandlers = new Map<string, ConsoleOpHandler>();

  private seq = 0;
  private readonly pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  private snapshot: EngineSnapshot = { session: null, manifests: {}, connected: false };
  private readonly listeners = new Set<() => void>();
  private thumbsMap: Record<string, string> = {};
  private readonly thumbListeners = new Set<() => void>();

  // ── Narrow selector stores (FR-1) ──────────────────────────────────────────
  // Stable per-slice references so a component re-renders on ITS slice only.
  // Each is recomputed on a `state` message but KEEPS its previous identity when
  // the slice's content is unchanged (structural compare), so useSyncExternalStore
  // bails out. Listeners are sliced too: only the affected slice's subscribers
  // wake. The monolithic `snapshot`/`subscribe` above stays for whole-tree
  // readers (ConsoleApp owns selection/order); the slices kill the per-tile storm.
  private instanceSlices = new Map<string, InstanceSlice>();
  private readonly instanceSliceJson = new Map<string, string>();
  private readonly instanceListeners = new Map<string, Set<() => void>>();
  // The narrow tile projection (display fields only) — separate from the full
  // instance slice so a tile never wakes on slowSignals/nodes churn (FR-1).
  private readonly tileSlices = new Map<string, TileSlice>();
  private readonly tileSliceJson = new Map<string, string>();
  private readonly tileListeners = new Map<string, Set<() => void>>();
  private instanceIds: string[] = [];
  private readonly idsListeners = new Set<() => void>();
  private sessionMeta: SessionMeta | null = null;
  private sessionMetaJson = "";
  private readonly metaListeners = new Set<() => void>();
  // Stage pointers + rounded fps: the only session-level fields a Tile reads.
  // Kept as their own rarely-changing slices so a tile never wakes on the 10 Hz
  // frame-counter tick (which DOES churn sessionMeta, for the Header readout).
  private stagePointers: StagePointers = { live: null, staged: null, panicked: false };
  private stagePointersJson = "";
  private readonly stageListeners = new Set<() => void>();
  private engineFps = 0;
  private readonly fpsListeners = new Set<() => void>();
  private readonly manifestSlices = new Map<string, Record<string, ParamDesc>>();
  private readonly manifestJson = new Map<string, string>();
  private readonly manifestListeners = new Map<string, Set<() => void>>();
  private previewFrame: PreviewFrame | null = null;
  private readonly previewListeners = new Set<() => void>();

  private lastStateAt = -Infinity;
  private readonly timers: Array<ReturnType<typeof setInterval>> = [];

  private readonly queued = new Map<string, { instance: string; path: string; value: number | boolean | string }>();
  private flushScheduled = false;

  constructor(opts: EngineLinkOptions) {
    this.prefix = opts.prefix;
    this.consoleId = opts.consoleId ?? opts.prefix;
    // BroadcastChannel's DOM onmessage is typed for MessageEvent; ChannelLike
    // only needs `{ data }`. Structurally compatible at runtime — cast across.
    this.ch = opts.channel ?? (new BroadcastChannel("loom") as unknown as ChannelLike);
    this.schedule = opts.schedule ?? defaultSchedule;
    this.now = opts.now ?? (() => performance.now());

    this.ch.onmessage = (ev) => this.onMessage(ev.data);
    this.ch.postMessage({ kind: "hello", consoleId: this.consoleId });
    this.timers.push(setInterval(() => this.ch.postMessage({ kind: "hello", consoleId: this.consoleId }), HELLO_MS));
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

  // ── Selector-store accessors (FR-1) ─────────────────────────────────────────

  /** Subscribe to one instance's slice; wakes only when THAT instance changes. */
  subscribeInstance =
    (id: string) =>
    (fn: () => void): (() => void) => {
      let set = this.instanceListeners.get(id);
      if (set == null) {
        set = new Set();
        this.instanceListeners.set(id, set);
      }
      set.add(fn);
      return () => {
        const s = this.instanceListeners.get(id);
        s?.delete(fn);
        if (s != null && s.size === 0) this.instanceListeners.delete(id);
      };
    };
  /** This instance's current slice (stable identity while unchanged), or undefined. */
  instance = (id: string): InstanceSlice | undefined => this.instanceSlices.get(id);

  /** Subscribe to one tile's NARROW display projection (FR-1) — the Tile reader. */
  subscribeTile =
    (id: string) =>
    (fn: () => void): (() => void) => {
      let set = this.tileListeners.get(id);
      if (set == null) {
        set = new Set();
        this.tileListeners.set(id, set);
      }
      set.add(fn);
      return () => {
        const s = this.tileListeners.get(id);
        s?.delete(fn);
        if (s != null && s.size === 0) this.tileListeners.delete(id);
      };
    };
  /** This tile's narrow display slice (stable while its visible state is unchanged). */
  tile = (id: string): TileSlice | undefined => this.tileSlices.get(id);

  /** Subscribe to the session-meta slice (Header scalars; no per-instance churn). */
  subscribeMeta = (fn: () => void): (() => void) => {
    this.metaListeners.add(fn);
    return () => {
      this.metaListeners.delete(fn);
    };
  };
  meta = (): SessionMeta | null => this.sessionMeta;

  /** Subscribe to the instance-id LIST (grid membership/order), not the contents. */
  subscribeInstanceIds = (fn: () => void): (() => void) => {
    this.idsListeners.add(fn);
    return () => {
      this.idsListeners.delete(fn);
    };
  };
  ids = (): string[] => this.instanceIds;

  /** Subscribe to the stage pointers (live/staged/panicked) — what a Tile reads. */
  subscribeStagePointers = (fn: () => void): (() => void) => {
    this.stageListeners.add(fn);
    return () => {
      this.stageListeners.delete(fn);
    };
  };
  pointers = (): StagePointers => this.stagePointers;

  /** Subscribe to the rounded engine fps (tileFps ceiling). */
  subscribeEngineFps = (fn: () => void): (() => void) => {
    this.fpsListeners.add(fn);
    return () => {
      this.fpsListeners.delete(fn);
    };
  };
  fps = (): number => this.engineFps;

  /** Subscribe to one instance's manifest (ParamPanel); stable while unchanged. */
  subscribeManifest =
    (id: string) =>
    (fn: () => void): (() => void) => {
      let set = this.manifestListeners.get(id);
      if (set == null) {
        set = new Set();
        this.manifestListeners.set(id, set);
      }
      set.add(fn);
      return () => {
        const s = this.manifestListeners.get(id);
        s?.delete(fn);
        if (s != null && s.size === 0) this.manifestListeners.delete(id);
      };
    };
  manifest = (id: string): Record<string, ParamDesc> | undefined => this.manifestSlices.get(id);

  /**
   * Recompute the narrow slices from a fresh state message, KEEPING identity for
   * any slice whose serialized content is unchanged so subscribers don't wake.
   * Structural compare is JSON over small objects at ~10 Hz — cheap, and it's the
   * one place this cost lives (vs. a full-tree React reconcile every tick).
   */
  private updateSlices(session: SessionSnapshot, manifests: Manifests): void {
    // 1. Per-instance slices + the id list. CRUCIAL for FR-1: `frameMs` and
    // `slowSignals` are live per-frame telemetry that wiggle EVERY tick (smoothed
    // EMAs), so comparing the raw slice would wake every tile every tick — the
    // storm would survive the memoization. Quantize that telemetry to the
    // precision the UI actually shows (frameMs → 0.1 ms, the `.framems`/`tilefps`
    // granularity) so a tile wakes only when its DISPLAYED value changes.
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const raw of session.instances ?? []) {
      const inst = quantizeTelemetry(raw);
      seen.add(inst.id);
      ids.push(inst.id);
      const json = JSON.stringify(inst);
      if (this.instanceSliceJson.get(inst.id) !== json) {
        this.instanceSliceJson.set(inst.id, json);
        this.instanceSlices.set(inst.id, inst);
        for (const fn of this.instanceListeners.get(inst.id) ?? []) fn();
      }
      // The narrow tile projection — its own change detection so a tile wakes
      // only on its visible state, not the full slice's telemetry churn.
      const tile = toTileSlice(inst);
      const tileJson = JSON.stringify(tile);
      if (this.tileSliceJson.get(inst.id) !== tileJson) {
        this.tileSliceJson.set(inst.id, tileJson);
        this.tileSlices.set(inst.id, tile);
        for (const fn of this.tileListeners.get(inst.id) ?? []) fn();
      }
    }
    for (const id of [...this.instanceSlices.keys()]) {
      if (!seen.has(id)) {
        this.instanceSlices.delete(id);
        this.instanceSliceJson.delete(id);
        this.tileSlices.delete(id);
        this.tileSliceJson.delete(id);
        for (const fn of this.instanceListeners.get(id) ?? []) fn();
        for (const fn of this.tileListeners.get(id) ?? []) fn();
      }
    }
    const idsJson = JSON.stringify(ids);
    if (JSON.stringify(this.instanceIds) !== idsJson) {
      this.instanceIds = ids;
      for (const fn of this.idsListeners) fn();
    }

    // 2. Session-meta slice (everything except the instances array). This DOES
    // churn ~10 Hz because `frame` increments each tick — but only the Header
    // (the frame counter) subscribes to it, so it's one re-render, not the tree.
    const { instances: _drop, ...meta } = session;
    const metaJson = JSON.stringify(meta);
    if (metaJson !== this.sessionMetaJson) {
      this.sessionMetaJson = metaJson;
      this.sessionMeta = meta as SessionMeta;
      for (const fn of this.metaListeners) fn();
    }

    // 2a. Stage pointers — what a Tile reads. Their own slice so a tile never
    // wakes on the frame-counter tick that churns sessionMeta above.
    const pointers: StagePointers = {
      live: session.live,
      staged: session.staged,
      panicked: session.panicked,
    };
    const pointersJson = JSON.stringify(pointers);
    if (pointersJson !== this.stagePointersJson) {
      this.stagePointersJson = pointersJson;
      this.stagePointers = pointers;
      for (const fn of this.stageListeners) fn();
    }

    // 2b. Rounded engine fps — the tileFps ceiling. Rounded so a tile re-renders
    // at most ~1 Hz on fps wobble, not every tick.
    const fps = Math.round(session.fps);
    if (fps !== this.engineFps) {
      this.engineFps = fps;
      for (const fn of this.fpsListeners) fn();
    }

    // 3. Per-instance manifest slices (ParamPanel reads manifests[selected]).
    const haveManifests = new Set<string>();
    for (const [id, m] of Object.entries(manifests)) {
      haveManifests.add(id);
      const json = JSON.stringify(m);
      if (this.manifestJson.get(id) !== json) {
        this.manifestJson.set(id, json);
        this.manifestSlices.set(id, m);
        for (const fn of this.manifestListeners.get(id) ?? []) fn();
      }
    }
    for (const id of [...this.manifestSlices.keys()]) {
      if (!haveManifests.has(id)) {
        this.manifestSlices.delete(id);
        this.manifestJson.delete(id);
        for (const fn of this.manifestListeners.get(id) ?? []) fn();
      }
    }
  }

  // Full-res preview stream (Console preview overlay). The latest frame, plus a
  // store shaped for useSyncExternalStore.
  subscribePreview = (fn: () => void): (() => void) => {
    this.previewListeners.add(fn);
    return () => {
      this.previewListeners.delete(fn);
    };
  };
  preview = (): PreviewFrame | null => this.previewFrame;

  /**
   * Register a handler for an engine→Console reverse-request op (the generic
   * reverse-envelope primitive, NFR-2). The engine addresses this Console by id
   * (most-recent hello) with `{ kind:"console-request", id, target, op, payload }`;
   * the matching handler runs in THIS page and replies with `console-response`.
   * Returns an unregister fn.
   */
  onConsoleOp(op: string, handler: ConsoleOpHandler): () => void {
    this.opHandlers.set(op, handler);
    return () => {
      if (this.opHandlers.get(op) === handler) this.opHandlers.delete(op);
    };
  }

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
        void this.req("set_param", { instance: w.instance, path: w.path, value: w.value }).catch((err) =>
          console.error("[loom-ui]", err),
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
      const session = msg.session as SessionSnapshot;
      const manifests = (msg.manifests as Manifests | undefined) ?? {};
      this.snapshot = { session, manifests, connected: true };
      this.updateSlices(session, manifests);
      this.pruneThumbs(session);
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
      return;
    }
    if (msg.kind === "console-request") {
      // Engine→Console reverse request. Only answer when addressed to THIS
      // Console (most-recent-hello targeting) so two open Consoles never race
      // one id. A missing/throwing op handler becomes an ok:false response.
      if (msg.target !== this.consoleId) return;
      const id = msg.id as string;
      const op = msg.op as string;
      const payload = (msg.payload as Record<string, unknown> | undefined) ?? {};
      void this.runConsoleOp(op, payload).then((res) => {
        // `res` spreads to top-level `ok` + (`result` | `error`) — the exact keys
        // the engine's console-channel reads off the response (msg.ok/result/error).
        this.ch.postMessage({ kind: "console-response", id, consoleId: this.consoleId, ...res });
      });
    }
  }

  private async runConsoleOp(
    op: string,
    payload: Record<string, unknown>,
  ): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
    const handler = this.opHandlers.get(op);
    if (handler == null) return { ok: false, error: `unknown console op "${op}"` };
    try {
      return { ok: true, result: await handler(payload) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Drop cached thumbnails for instances no longer in the session (FR-4): the
   * thumbsMap is spread-merged every pass and was never pruned, so a destroyed
   * instance's data-URL lived forever. The state stream is the authoritative
   * instance list; prune against it. Cheap — runs at most ~10 Hz on a small map.
   */
  private pruneThumbs(session: SessionSnapshot | null): void {
    if (session == null) return;
    const live = new Set((session.instances ?? []).map((i) => i.id));
    let changed = false;
    for (const id of Object.keys(this.thumbsMap)) {
      if (!live.has(id)) {
        delete this.thumbsMap[id];
        changed = true;
      }
    }
    if (changed) this.emitThumbs();
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
  private emitThumbs(): void {
    for (const fn of this.thumbListeners) fn();
  }
}
