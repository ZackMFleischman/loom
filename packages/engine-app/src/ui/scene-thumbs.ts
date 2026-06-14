/**
 * Per-scene snapshot cache: the latest thumbnail any instance of a scene ever
 * streamed, persisted across sessions. Bridges the gap the live preview can't
 * cover — the scene picker shows every scene "as of last run" instantly, and
 * the "+" tile shows the hovered scene's snapshot while its real preview
 * instance is still building (no blank/flicker mid-swap).
 */
const KEY = "loom.scenethumbs";

const cache: Record<string, string> = (() => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
})();

let dirty = false;
let flusher: number | undefined;

/** Record a scene's freshest pixels (in-memory now, persisted debounced). */
export function snapshotScene(scene: string, dataUrl: string | undefined): void {
  if (!dataUrl || cache[scene] === dataUrl) return;
  cache[scene] = dataUrl;
  dirty = true;
  flusher ??= window.setInterval(() => {
    if (!dirty) return;
    dirty = false;
    try {
      localStorage.setItem(KEY, JSON.stringify(cache));
    } catch {
      // storage full/unavailable — snapshots just won't survive a reload
    }
  }, 3000);
}

/** The scene's last-run snapshot, if it has ever rendered on this machine. */
export function sceneThumb(scene: string): string | undefined {
  return cache[scene];
}
