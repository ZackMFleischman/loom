/**
 * Per-scene snapshot cache: the latest thumbnail any instance of a scene ever
 * streamed, persisted across sessions. Bridges the gap the live preview can't
 * cover — the scene picker shows every scene "as of last run" instantly, and
 * the "+" tile shows the hovered scene's snapshot while its real preview
 * instance is still building (no blank/flicker mid-swap).
 *
 * BOUNDED (FR-4): the cache had NO eviction — every scene ever previewed kept
 * its latest full data-URL in a JSON blob re-stringified every 3 s, growing
 * toward the ~5 MB localStorage quota in a long session (a slow leak that
 * precedes an OOM abort). It is now an LRU with both an entry cap AND a byte
 * budget: the least-recently-snapshotted scenes are evicted first so the blob
 * stays bounded regardless of how many scenes a session touches.
 */
const KEY = "loom.scenethumbs";
/** Hard caps: whichever binds first wins. ~30 × ~25 KB JPEGs ≈ 0.75 MB << 5 MB. */
const MAX_ENTRIES = 30;
const MAX_BYTES = 2_000_000;

/** Insertion-ordered map = LRU: re-inserting on touch moves a key to the end. */
const cache: Map<string, string> = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, string>;
    return new Map(Object.entries(raw));
  } catch {
    return new Map();
  }
})();

let dirty = false;
let flusher: number | undefined;

/** Rough byte size of the cached data-URLs (data-URLs are ASCII, so 1 char ≈ 1 byte). */
function totalBytes(): number {
  let n = 0;
  for (const [k, v] of cache) n += k.length + v.length;
  return n;
}

/** Evict least-recently-used entries until both budgets are satisfied. */
function evict(): void {
  while (cache.size > MAX_ENTRIES || (cache.size > 1 && totalBytes() > MAX_BYTES)) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest == null) break;
    cache.delete(oldest);
  }
}

/** Record a scene's freshest pixels (in-memory now, persisted debounced). */
export function snapshotScene(scene: string, dataUrl: string | undefined): void {
  if (!dataUrl || cache.get(scene) === dataUrl) return;
  cache.delete(scene); // re-insert at the end → most-recently-used
  cache.set(scene, dataUrl);
  evict();
  dirty = true;
  flusher ??= window.setInterval(() => {
    if (!dirty) return;
    dirty = false;
    try {
      localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(cache)));
    } catch {
      // storage full/unavailable — snapshots just won't survive a reload
    }
  }, 3000);
}

/** The scene's last-run snapshot, if it has ever rendered on this machine. */
export function sceneThumb(scene: string): string | undefined {
  return cache.get(scene);
}
