/**
 * Console self-capture (feature: screenshot_console, Phase 1).
 *
 * The Console rasterizes its OWN DOM in-page — no browser permissions, no user
 * gesture, no external process (resolved decision #2: in-page self-capture over
 * CDP). It runs in the Console's window/thread, so it never blocks the Output
 * window's render loop (FR-7). Fidelity is APPROXIMATE: this is a DOM re-render
 * via SVG-foreignObject, not a compositor read (FR-6) — good for layout/state/
 * feedback, not pixel-perfect color (that stays with `screenshot` on instances).
 *
 * The Console UI is the friendly case for this technique: vanilla DOM + MUI,
 * `<img>` thumbnails that are already dataURLs, and `<canvas>` tiles we snapshot
 * inline. Same-origin only — see the rasterizer's taint note.
 */
import { rasterize } from "./vendor/dom-rasterize";

/** Default output cap (NFR-3): keeps a 1080p Console PNG snappy over WS + MCP. */
export const DEFAULT_MAX_WIDTH = 1280;

export type ConsoleCapture = { dataUrl: string; width: number; height: number };

/**
 * Capture the whole Console viewport to a PNG data URL.
 *
 * @param maxWidth output width cap in px (default 1280); `0` = native resolution.
 *   The height scales to preserve aspect, bounding payload size.
 *
 * Resolves to `{ dataUrl, width, height }`; rejects (never hangs) on a
 * rasterizer throw or an oversized canvas, so callers map failure to a clean
 * structured error (FR-5).
 */
export async function captureConsole(maxWidth: number = DEFAULT_MAX_WIDTH): Promise<ConsoleCapture> {
  // The whole cockpit. document.body covers tiles, badges, param panels, status
  // bar and stage strip — exactly what the agent is reasoning about (FR-4).
  const root = document.body;
  if (root == null) throw new Error("no Console DOM to capture");
  // Read the page's own background so transparent regions don't come back black.
  const background = window.getComputedStyle(root).backgroundColor || "#000";
  return rasterize(root, { maxWidth, background });
}

/**
 * Dev nicety (FR / Surfaces): trigger a capture and download it as a PNG. Wired
 * to the Console's `s` key — free debugging for the human, and it exercises the
 * exact capture path the agent uses, without an agent in the loop.
 */
export async function downloadConsoleCapture(maxWidth: number = DEFAULT_MAX_WIDTH): Promise<void> {
  const { dataUrl } = await captureConsole(maxWidth);
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = `loom-console-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
