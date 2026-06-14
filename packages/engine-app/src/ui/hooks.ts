import { createContext, useContext, useSyncExternalStore } from "react";
import type { PreviewFrame } from "@loom/sidecar/protocol";
import type { EngineLink, EngineSnapshot } from "./engine-link";

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

/** Latest thumbnail data-URL for one instance (~6.6 Hz). */
export function useThumb(id: string | null): string | undefined {
  const link = useEngine();
  return useSyncExternalStore(link.subscribeThumbs, () =>
    id == null ? undefined : link.thumb(id),
  );
}

/** Latest full-res preview frame from the engine (Console preview overlay). */
export function usePreviewFrame(): PreviewFrame | null {
  const link = useEngine();
  return useSyncExternalStore(link.subscribePreview, link.preview);
}
