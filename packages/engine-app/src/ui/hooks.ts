import { createContext, useCallback, useContext, useSyncExternalStore } from "react";
import type { PreviewFrame } from "@loom/sidecar/protocol";
import type {
  EngineLink,
  EngineSnapshot,
  InstanceSlice,
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

/** The instance-id list / order (grid membership) — wakes only on add/remove/reorder. */
export function useInstanceIds(): string[] {
  const link = useEngine();
  return useSyncExternalStore(link.subscribeInstanceIds, link.ids);
}

/** Session-level scalars (Header): bpm/rms/fps/frame/audio/midi/projects/panic/… */
export function useSessionMeta(): SessionMeta | null {
  const link = useEngine();
  return useSyncExternalStore(link.subscribeMeta, link.meta);
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

/** Latest thumbnail data-URL for one instance (~6.6 Hz). */
export function useThumb(id: string | null): string | undefined {
  const link = useEngine();
  return useSyncExternalStore(link.subscribeThumbs, () => (id == null ? undefined : link.thumb(id)));
}

/** Latest full-res preview frame from the engine (Console preview overlay). */
export function usePreviewFrame(): PreviewFrame | null {
  const link = useEngine();
  return useSyncExternalStore(link.subscribePreview, link.preview);
}
