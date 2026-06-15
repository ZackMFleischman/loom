import { createContext, useCallback, useContext, useSyncExternalStore } from "react";
import type { PreviewFrame } from "@loom/sidecar/protocol";
import type {
  ControlsSlice,
  EngineLink,
  EngineSnapshot,
  InstanceSlice,
  InstanceStructure,
  ParamDesc,
  SessionMeta,
  StagePointers,
  TileSlice,
} from "./engine-link";

const EngineContext = createContext<EngineLink | null>(null);
export const EngineProvider = EngineContext.Provider;

export function useEngine(): EngineLink {
  const link = useContext(EngineContext);
  if (!link) throw new Error("EngineProvider missing");
  return link;
}

/** Latest engine state (~10 Hz) + connection flag. */
export function useEngineState(): EngineSnapshot {
  const link = useEngine();
  return useSyncExternalStore(link.subscribe, link.getSnapshot);
}

/**
 * One instance's slice (FR-1): re-renders only when THAT instance's fields
 * change, not on every 10 Hz state broadcast. The store keeps a stable slice
 * reference while the instance is unchanged, so a memoized Tile bails out.
 */
export function useInstance(id: string): InstanceSlice | undefined {
  const link = useEngine();
  const subscribe = useCallback((fn: () => void) => link.subscribeInstance(id)(fn), [link, id]);
  const getSnapshot = useCallback(() => link.instance(id), [link, id]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

/**
 * One tile's NARROW display slice (FR-1): the Tile reader. Wakes only when the
 * tile's visible state (status/scene/frameMs@0.1/pinned) changes — NOT on the
 * full instance slice's per-tick telemetry churn (slowSignals sort flicker,
 * node/chain edits). This is what actually kills the per-tile re-render storm.
 */
export function useTile(id: string): TileSlice | undefined {
  const link = useEngine();
  const subscribe = useCallback((fn: () => void) => link.subscribeTile(id)(fn), [link, id]);
  const getSnapshot = useCallback(() => link.tile(id), [link, id]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

/**
 * One instance's STRUCTURE slice (scene/nodes/chain — no telemetry). ParamPanel +
 * FxChain read this so they re-render on a real chain/node edit, NOT on the per-tick
 * frameMs wiggle that churns the full instance slice (which would re-render the whole
 * param panel every tick). (FR-1)
 */
export function useStructure(id: string | null): InstanceStructure | undefined {
  const link = useEngine();
  const subscribe = useCallback(
    (fn: () => void) => (id == null ? () => {} : link.subscribeStructure(id)(fn)),
    [link, id],
  );
  const getSnapshot = useCallback(() => (id == null ? undefined : link.structure(id)), [link, id]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

/**
 * The controls slice (FR-1): MIDI bindings, MIDI status, the effect library, and the
 * id→scene map the param/FX widgets read. Its own store so ParamWidget/ModPopover/
 * FxChain — mounted once per param in an open panel — re-render only on a real
 * binding/MIDI/effect change, never on the 10 Hz frame tick. This is the leaf-level
 * fix that stops an open param panel from re-rendering its whole widget list 10×/s.
 */
export function useControls(): ControlsSlice {
  const link = useEngine();
  return useSyncExternalStore(link.subscribeControls, link.controls);
}

/** The instance-id list / order (grid membership) — wakes only on add/remove/reorder. */
export function useInstanceIds(): string[] {
  const link = useEngine();
  return useSyncExternalStore(link.subscribeInstanceIds, link.ids);
}

/** Available scene names for the "+" picker — stable while the catalog is unchanged. */
export function useAvailableScenes(): string[] {
  const link = useEngine();
  return useSyncExternalStore(link.subscribeAvailableScenes, link.availableScenes);
}

/** Session-level scalars (Header): bpm/rms/fps/frame/audio/midi/projects/panic/… */
export function useSessionMeta(): SessionMeta | null {
  const link = useEngine();
  return useSyncExternalStore(link.subscribeMeta, link.meta);
}

/** Narrow connection flag — ConsoleApp reads this so its DndContext stays stable. */
export function useConnected(): boolean {
  const link = useEngine();
  return useSyncExternalStore(link.subscribeConnected, link.connected);
}

/** Sticky "engine has sent state" flag — gates the ConsoleApp tree; flips once. */
export function useHasSession(): boolean {
  const link = useEngine();
  return useSyncExternalStore(link.subscribeHasSession, link.hasSession);
}

/** Stage pointers (live/staged/panicked) — what a Tile reads; rarely changes. */
export function useStagePointers(): StagePointers {
  const link = useEngine();
  return useSyncExternalStore(link.subscribeStagePointers, link.pointers);
}

/** Rounded Output engine fps — the per-tile fps ceiling (changes ~1 Hz). */
export function useEngineFps(): number {
  const link = useEngine();
  return useSyncExternalStore(link.subscribeEngineFps, link.fps);
}

/** One instance's manifest slice (ParamPanel) — stable while the manifest is unchanged. */
export function useManifest(id: string | null): Record<string, ParamDesc> | undefined {
  const link = useEngine();
  const subscribe = useCallback(
    (fn: () => void) => (id == null ? () => {} : link.subscribeManifest(id)(fn)),
    [link, id],
  );
  const getSnapshot = useCallback(() => (id == null ? undefined : link.manifest(id)), [link, id]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

/**
 * Latest thumbnail data-URL for one instance (~6.6 Hz). Per-id subscription
 * (FR-1/FR-2): a thumb pass wakes only the tiles it actually re-read, so an
 * unchanged tile no longer re-renders + re-decodes its JPEG on every pass.
 */
export function useThumb(id: string | null): string | undefined {
  const link = useEngine();
  const subscribe = useCallback((fn: () => void) => (id == null ? () => {} : link.subscribeThumb(id)(fn)), [link, id]);
  const getSnapshot = useCallback(() => (id == null ? undefined : link.thumb(id)), [link, id]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Latest full-res preview frame from the engine (Console preview overlay). */
export function usePreviewFrame(): PreviewFrame | null {
  const link = useEngine();
  return useSyncExternalStore(link.subscribePreview, link.preview);
}
