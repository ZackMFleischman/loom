import type { DiagLevel } from "@loom/sidecar/protocol";

/**
 * Structured, queryable, in-process diagnostics — a bounded ring of typed
 * events that gives the agent (and a future Console perf view) the HISTORY the
 * snapshot surfaces lack: what build/swap/freeze/perf event led to the number
 * it's looking at (feature-requests/app-instrumentation.md).
 *
 * Design contract (NFR-1, "Never go black"):
 *  - The hot path is append-to-a-preallocated-array + integer compares ONLY.
 *    No JSON, no IO, no allocation storms. The one allocation a push makes is
 *    the caller's event object; the ring itself never grows.
 *  - {@link Diagnostics.push} is WRAPPED so a bug in instrumentation can never
 *    throw into renderFrame/tick — a failed push is swallowed, never rethrown.
 *  - Serialization (Zod, filtering, slicing) happens ONLY in the request
 *    handler ({@link Diagnostics.query}), off the render tick.
 *  - The ring only MEASURES; it never feeds a value back into render, so fixture
 *    replays stay byte-identical (NFR-4). `?diag=0` is a belt-and-suspenders off
 *    switch mirroring `?profile=0`.
 *
 * It is an in-page SINGLETON ({@link diag}) so the two readers — the agent over
 * MCP (serialized snapshot) and the future Console perf view (same in-page ring,
 * DOM) — share one source of truth. Neither reader mutates it.
 */

/** The event level. Mirrors the protocol's `DiagLevel`. */
export type Level = DiagLevel;

/**
 * One diagnostics event. `kind` is an OPEN string (a dotted domain name like
 * `scene.rejected`, `instance.rebuilt`, `perf.sample`) so new kinds can be
 * emitted without a protocol bump (NFR-5: the buffer never gates `kind`).
 * `seq`/`frame`/`t` are stamped by {@link Diagnostics.push}; callers pass the
 * rest.
 */
export interface DiagEvent {
  /** Monotonic sequence number (the agent's `since` cursor). Stamped on push. */
  seq: number;
  /** Engine frame at emit time (causal anchor). Stamped from the frame stamper. */
  frame: number;
  /** performance.now() ms at emit time. Stamped on push. */
  t: number;
  level: Level;
  /** Open dotted domain name, e.g. "scene.rejected". */
  kind: string;
  /** The instance this event is about, if any. */
  instance?: string;
  /** A short English summary (reuses the existing `[loom]` log strings). */
  msg: string;
  /** Optional structured payload (errors, fps, frameMs, …). Kept small + plain. */
  data?: Record<string, unknown>;
}

/** The fields a caller supplies to {@link Diagnostics.push} (seq/frame/t stamped). */
export type DiagInput = Omit<DiagEvent, "seq" | "frame" | "t">;

/** Result of {@link Diagnostics.query} — the slice plus eviction accounting. */
export interface DiagQueryResult {
  events: DiagEvent[];
  /**
   * Events evicted from the ring since the requested `since` cursor — so the
   * agent knows when it missed events during a quiet poll gap (FR-4).
   */
  dropped: number;
  now: { frame: number; fps: number };
}

export interface DiagQuery {
  /** Return events with `seq` strictly greater than this cursor. */
  since?: number;
  /** Filter to these kinds (exact match). */
  kinds?: readonly string[];
  /** Filter to one instance. */
  instance?: string;
  /** Minimum level (info < warn < error). */
  level?: Level;
  /** Cap the number of returned events (newest kept). */
  limit?: number;
}

const LEVEL_RANK: Record<Level, number> = { info: 0, warn: 1, error: 2 };

/** Default ring capacity (~512, tunable via the constructor / `?diag=N`). */
export const DEFAULT_DIAG_CAPACITY = 512;

export class Diagnostics {
  /** The preallocated ring; slots are `undefined` until first wrapped around. */
  private readonly ring: Array<DiagEvent | undefined>;
  private readonly capacity: number;
  /** Total pushes ever — also the next seq to assign. O(1), integer only. */
  private count = 0;
  /** Whether instrumentation is on (`?diag=0` turns it off). */
  private readonly on: boolean;
  /** Frame stamper, wired from the render service. Cheap integer read. */
  private frameOf: () => number = () => 0;
  /** fps reader for the `now` block in queries (off the tick). */
  private fpsOf: () => number = () => 0;

  constructor(opts: { capacity?: number; enabled?: boolean } = {}) {
    this.capacity = Math.max(1, opts.capacity ?? DEFAULT_DIAG_CAPACITY);
    this.on = opts.enabled ?? true;
    this.ring = new Array<DiagEvent | undefined>(this.capacity);
  }

  /** True unless `?diag=0` disabled it — callers may skip building `data` when off. */
  get enabled(): boolean {
    return this.on;
  }

  /** Wire the per-frame stamper + fps reader (called once at boot). */
  bind(frameOf: () => number, fpsOf: () => number): void {
    this.frameOf = frameOf;
    this.fpsOf = fpsOf;
  }

  /**
   * Append an event. O(1), allocation-light, and WRAPPED so an instrumentation
   * bug can never throw into renderFrame/tick (NFR-1). A no-op when disabled.
   */
  push(input: DiagInput): void {
    if (!this.on) return;
    try {
      const seq = this.count++;
      const event: DiagEvent = {
        seq,
        frame: this.frameOf(),
        t: performance.now(),
        level: input.level,
        kind: input.kind,
        msg: input.msg,
        ...(input.instance != null ? { instance: input.instance } : {}),
        ...(input.data != null ? { data: input.data } : {}),
      };
      this.ring[seq % this.capacity] = event;
    } catch {
      // Instrumentation must never break the loop — drop the event silently.
    }
  }

  /** The seq of the oldest event still in the ring (0 until it first wraps). */
  private oldestSeq(): number {
    return Math.max(0, this.count - this.capacity);
  }

  /** Total events ever pushed (the next cursor an agent should page from). */
  get total(): number {
    return this.count;
  }

  /**
   * The recent tail, newest last. Cheap helper for the Console reader; the MCP
   * path uses {@link query} for filtering + eviction accounting.
   */
  tail(n: number): DiagEvent[] {
    return this.collect(this.oldestSeq()).slice(-Math.max(0, n));
  }

  /**
   * Serialize a filtered slice — called ONLY from the request handler, never on
   * the tick. Computes `dropped` (events evicted since the caller's cursor) so a
   * paging agent knows when it missed events (FR-4).
   */
  query(q: DiagQuery = {}): DiagQueryResult {
    const since = q.since;
    const oldest = this.oldestSeq();
    // Eviction accounting: if the agent's cursor is older than what survives, the
    // gap between them was dropped from the ring.
    const dropped = since != null && since < oldest ? oldest - since - 1 : 0;
    const minRank = q.level != null ? LEVEL_RANK[q.level] : 0;
    const kinds = q.kinds != null && q.kinds.length > 0 ? new Set(q.kinds) : null;
    const fromSeq = since != null ? Math.max(oldest, since + 1) : oldest;

    let events = this.collect(fromSeq);
    if (kinds != null) events = events.filter((e) => kinds.has(e.kind));
    if (q.instance != null) events = events.filter((e) => e.instance === q.instance);
    if (minRank > 0) events = events.filter((e) => LEVEL_RANK[e.level] >= minRank);
    if (q.limit != null && events.length > q.limit) events = events.slice(-q.limit);

    return { events, dropped, now: { frame: this.frameOf(), fps: this.fpsOf() } };
  }

  /** Gather live events with seq >= fromSeq, in seq order (oldest first). */
  private collect(fromSeq: number): DiagEvent[] {
    const out: DiagEvent[] = [];
    const start = Math.max(fromSeq, this.oldestSeq());
    for (let seq = start; seq < this.count; seq++) {
      const e = this.ring[seq % this.capacity];
      if (e != null && e.seq === seq) out.push(e); // seq guard: skip a slot a wrap replaced
    }
    return out;
  }
}

/** Parse `?diag=` into ring options. `0` = off; a positive int = capacity. */
export function diagOptionsFromQuery(value: string | null): { capacity?: number; enabled?: boolean } {
  if (value === "0") return { enabled: false };
  const n = value != null ? Number.parseInt(value, 10) : NaN;
  if (Number.isFinite(n) && n > 1) return { capacity: n };
  return {};
}

/**
 * The in-page singleton. Built eagerly with defaults so module-load-time emit
 * sites (rare) don't NPE; main.ts rebinds the frame stamper at boot. The
 * `?diag=` knob is read in main.ts and applied via {@link configureDiagnostics}.
 */
export let diag = new Diagnostics();

/**
 * Reconfigure the singleton from boot-time options (capacity / off switch).
 * Called once in main.ts before the loop starts; safe because nothing has been
 * pushed yet at that point.
 */
export function configureDiagnostics(opts: { capacity?: number; enabled?: boolean }): Diagnostics {
  diag = new Diagnostics(opts);
  return diag;
}

/**
 * Re-route a high-value `[loom]` event through BOTH the console (the human's
 * DevTools, where these lines already live) AND the diagnostics ring (the
 * agent's reader) — FR-2. The console call keeps the existing behavior; the ring
 * gives the same event a `kind`, a `frame`, and a remote reader. Never throws.
 */
export function logDiag(input: DiagInput): void {
  const line = `[loom] ${input.msg}`;
  try {
    if (input.level === "error") console.error(line, ...(input.data?.error != null ? [input.data.error] : []));
    else if (input.level === "warn") console.warn(line);
    else console.info(line);
  } catch {
    // a failed console call must never break the caller
  }
  diag.push(input);
}
