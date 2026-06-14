import type { ReactElement, ReactNode } from "react";
import type { PreviewFrame, SessionSnapshot } from "@loom/sidecar/protocol";
import type { EngineLink, EngineSnapshot, Manifests } from "../../src/ui/engine-link";
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
  private readonly thumbListeners = new Set<() => void>();

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

  subscribeThumbs = (fn: () => void): (() => void) => {
    this.thumbListeners.add(fn);
    return () => void this.thumbListeners.delete(fn);
  };
  thumb = (id: string): string | undefined => this.thumbs[id];

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
  }
  setConnected(connected: boolean): void {
    this.snapshot = { ...this.snapshot, connected };
    for (const fn of this.listeners) fn();
  }
  pushThumb(id: string, dataUrl: string): void {
    this.thumbs = { ...this.thumbs, [id]: dataUrl };
    for (const fn of this.thumbListeners) fn();
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
