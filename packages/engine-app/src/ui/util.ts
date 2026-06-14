/** Error sink for fire-and-forget cockpit requests — never throw into React. */
export const fail = (err: unknown) => console.error("[loom-ui]", err);

/**
 * Lightweight re-render counter (console-performance-stability FR-1 / Phase 4.2).
 * Each major component calls `countRender("Tile")` at render so a regression in
 * the memoization is *visible* (the perf harness reads `window.__perfRenders`),
 * not just felt. It only INCREMENTS integers — no allocation, no effect — so it
 * never disturbs the render path or the never-go-black contract.
 */
type RenderCounts = Record<string, number>;
declare global {
  interface Window {
    __perfRenders?: RenderCounts;
  }
}
export function countRender(component: string): void {
  if (typeof window === "undefined") return;
  window.__perfRenders ??= {};
  const counts = window.__perfRenders;
  counts[component] = (counts[component] ?? 0) + 1;
}

/**
 * Chrome gates WebMIDI behind a per-origin permission prompt, and the engine
 * (Output window) is a bare projector page nobody clicks. Requesting access
 * from the cockpit pops the prompt in the window the human is actually using;
 * the grant is origin-wide, and the engine re-attaches the moment it lands.
 */
export function primeMidiPermission(): void {
  const nav = navigator as Navigator & { requestMIDIAccess?: () => Promise<unknown> };
  void nav.requestMIDIAccess?.().catch(() => {});
}
