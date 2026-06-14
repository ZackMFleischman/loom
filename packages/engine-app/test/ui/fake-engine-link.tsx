import type { ReactElement, ReactNode } from "react";
import type { PreviewFrame, SessionSnapshot } from "@loom/sidecar/protocol";
import type {
  EngineLink,
  EngineSnapshot,
  InstanceSlice,
  Manifests,
  ParamDesc,
  SessionMeta,
  StagePointers,
  TileSlice,
} from "../../src/ui/engine-link";
import { EngineProvider } from "../../src/ui/hooks";

/**
 * A driveable, React-free stand-in for {@link EngineLink} for UI tests.
 *
 * The real link's `subscribe`/`getSnapshot`/`thumb`/`preview` seam (the surface
 * `useSyncExternalStore` reads) is reproduced exactly, plus `push*` helpers a
 * test calls to simulate engine messages and assert the hooks re-render. No
 * BroadcastChannel, no timers — deterministic. Built so the same fake also backs
 * the deferred Phase-3 component tests (it provides the full EngineLink-shaped
 * methods the components call).
 */
export class FakeEngineLink {
  snapshot: EngineSnapshot = { session: null, manifests: {}, connected: false };
  private readonly listeners = new Set<() => void>();

  private thumbs: Record<string, string> = {};
  private readonly thumbListenersById = new Map<string, Set<() => void>>();

  // Selector-store slices (FR-1) the components/hooks read.
  private readonly tileSlices = new Map<string, TileSlice>();
  private readonly tileListeners = new Map<string, Set<() => void>>();
  private readonly instanceSlices = new Map<string, InstanceSlice>();
  private readonly instanceListeners = new Map<string, Set<() => void>>();
  private readonly manifestSlices = new Map<string, Record<string, ParamDesc>>();
  private readonly manifestListeners = new Map<string, Set<() => void>>();
  private instanceIdsList: string[] = [];
  private readonly idsListeners = new Set<() => void>();
  private sessionMeta: SessionMeta | null = null;
  private readonly metaListeners = new Set<() => void>();
  private stagePointers: StagePointers = { live: null, staged: null, panicked: false };
  private readonly stageListeners = new Set<() => void>();
  private engineFps = 0;
  private readonly fpsListeners = new Set<() => void>();

  private previewFrame: PreviewFrame | null = null;
  private readonly previewListeners = new Set<() => void>();

  /** Records of writes the components/hooks send, for assertions. */
  readonly params: Array<{ instance: string; path: string; value: number | boolean | string }> = [];
  readonly requests: Array<{ type: string; args: Record<string, unknown> }> = [];

  // ── useSyncExternalStore surface (stable identities) ───────────────────────
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  getSnapshot = (): EngineSnapshot => this.snapshot;

  private connectedFlag = false;
  private readonly connectedListeners = new Set<() => void>();
  subscribeConnected = (fn: () => void): (() => void) => {
    this.connectedListeners.add(fn);
    return () => void this.connectedListeners.delete(fn);
  };
  connected = (): boolean => this.connectedFlag;
  private hasSessionFlag = false;
  private readonly hasSessionListeners = new Set<() => void>();
  subscribeHasSession = (fn: () => void): (() => void) => {
    this.hasSessionListeners.add(fn);
    return () => void this.hasSessionListeners.delete(fn);
  };
  hasSession = (): boolean => this.hasSessionFlag;
  private availableScenesList: string[] = [];
  private readonly scenesListeners = new Set<() => void>();
  subscribeAvailableScenes = (fn: () => void): (() => void) => {
    this.scenesListeners.add(fn);
    return () => void this.scenesListeners.delete(fn);
  };
  availableScenes = (): string[] => this.availableScenesList;

  subscribeThumb =
    (id: string) =>
    (fn: () => void): (() => void) => {
      const set = this.thumbListenersById.get(id) ?? new Set();
      this.thumbListenersById.set(id, set);
      set.add(fn);
      return () => void set.delete(fn);
    };
  thumb = (id: string): string | undefined => this.thumbs[id];

  // Selector-store read surface (stable per-id subscribe factories are fine here;
  // the hooks wrap them in useCallback).
  subscribeTile =
    (id: string) =>
    (fn: () => void): (() => void) => {
      const set = this.tileListeners.get(id) ?? new Set();
      this.tileListeners.set(id, set);
      set.add(fn);
      return () => void set.delete(fn);
    };
  tile = (id: string): TileSlice | undefined => this.tileSlices.get(id);
  subscribeInstance =
    (id: string) =>
    (fn: () => void): (() => void) => {
      const set = this.instanceListeners.get(id) ?? new Set();
      this.instanceListeners.set(id, set);
      set.add(fn);
      return () => void set.delete(fn);
    };
  instance = (id: string): InstanceSlice | undefined => this.instanceSlices.get(id);
  subscribeManifest =
    (id: string) =>
    (fn: () => void): (() => void) => {
      const set = this.manifestListeners.get(id) ?? new Set();
      this.manifestListeners.set(id, set);
      set.add(fn);
      return () => void set.delete(fn);
    };
  manifest = (id: string): Record<string, ParamDesc> | undefined => this.manifestSlices.get(id);
  subscribeInstanceIds = (fn: () => void): (() => void) => {
    this.idsListeners.add(fn);
    return () => void this.idsListeners.delete(fn);
  };
  ids = (): string[] => this.instanceIdsList;
  subscribeMeta = (fn: () => void): (() => void) => {
    this.metaListeners.add(fn);
    return () => void this.metaListeners.delete(fn);
  };
  meta = (): SessionMeta | null => this.sessionMeta;
  subscribeStagePointers = (fn: () => void): (() => void) => {
    this.stageListeners.add(fn);
    return () => void this.stageListeners.delete(fn);
  };
  pointers = (): StagePointers => this.stagePointers;
  subscribeEngineFps = (fn: () => void): (() => void) => {
    this.fpsListeners.add(fn);
    return () => void this.fpsListeners.delete(fn);
  };
  fps = (): number => this.engineFps;

  subscribePreview = (fn: () => void): (() => void) => {
    this.previewListeners.add(fn);
    return () => void this.previewListeners.delete(fn);
  };
  preview = (): PreviewFrame | null => this.previewFrame;

  // ── Write surface the components call ──────────────────────────────────────
  sendParam(instance: string, path: string, value: number | boolean | string): void {
    this.params.push({ instance, path, value });
  }
  sendParamRange(
    instance: string,
    path: string,
    opts: { min?: number; max?: number; restoreDefault?: boolean },
  ): Promise<unknown> {
    this.requests.push({ type: "set_param_range", args: { instance, path, ...opts } });
    return Promise.resolve({});
  }
  req(type: string, args: Record<string, unknown> = {}): Promise<unknown> {
    this.requests.push({ type, args });
    return Promise.resolve({});
  }
  dispose(): void {}

  // ── Test drivers: simulate engine pushes ───────────────────────────────────
  pushState(session: SessionSnapshot | null, manifests: Manifests = {}, connected = true): void {
    this.snapshot = { session, manifests, connected };
    for (const fn of this.listeners) fn();
    this.setConnected(connected);
    if (connected && !this.hasSessionFlag) {
      this.hasSessionFlag = true;
      for (const fn of this.hasSessionListeners) fn();
    }
  }
  setConnected(connected: boolean): void {
    this.snapshot = { ...this.snapshot, connected };
    for (const fn of this.listeners) fn();
    if (connected !== this.connectedFlag) {
      this.connectedFlag = connected;
      for (const fn of this.connectedListeners) fn();
    }
  }
  pushThumb(id: string, dataUrl: string): void {
    this.thumbs = { ...this.thumbs, [id]: dataUrl };
    for (const fn of this.thumbListenersById.get(id) ?? []) fn();
  }
  /** Drive a tile slice (FR-1 selector store) and wake its subscribers. */
  pushTile(slice: TileSlice): void {
    this.tileSlices.set(slice.id, slice);
    for (const fn of this.tileListeners.get(slice.id) ?? []) fn();
  }
  pushPreview(frame: PreviewFrame | null): void {
    this.previewFrame = frame;
    for (const fn of this.previewListeners) fn();
  }

  /** Type-erased view for code that wants the real EngineLink type. */
  asLink(): EngineLink {
    return this as unknown as EngineLink;
  }
}

/** Wrap a tree in an EngineProvider bound to a fake link (Phase-3 scaffolding). */
export function withEngine(link: FakeEngineLink, children: ReactNode): ReactElement {
  return <EngineProvider value={link.asLink()}>{children}</EngineProvider>;
}
