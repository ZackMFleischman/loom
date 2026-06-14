import type { RenderTarget, WebGPURenderer } from "three/webgpu";

/**
 * Two REUSED scratch canvases for the readback dance (crash mitigation, FR-5):
 * thumbnails ran at ~6.6 Hz × N instances, and each pass used to
 * `document.createElement("canvas")` TWICE — a lot of short-lived canvas/context
 * allocation churn that, under a driver with a low canvas/context ceiling, is a
 * plausible OOM/abort contributor. One pair, resized in place, replaces all of
 * it. The readback is serialized (one pass at a time behind the `thumbsBusy`
 * guard, and screenshots are awaited), so sharing these is safe; only the final
 * `toDataURL` string escapes, never a canvas reference.
 */
let srcCanvas: HTMLCanvasElement | null = null;
let outCanvas: HTMLCanvasElement | null = null;

function scratch(which: "src" | "out", w: number, h: number): HTMLCanvasElement {
  let c = which === "src" ? srcCanvas : outCanvas;
  if (c == null) {
    c = document.createElement("canvas");
    if (which === "src") srcCanvas = c;
    else outCanvas = c;
  }
  if (c.width !== w) c.width = w;
  if (c.height !== h) c.height = h;
  return c;
}

/**
 * Read a RenderTarget back into a data URL — the one implementation of the
 * "readRenderTargetPixelsAsync → canvas → toDataURL" dance (screenshots,
 * thumbnails, fixture shots). Handles the WebGL bottom-up framebuffer flip
 * and optional rescaling in one place. Reuses two scratch canvases (above)
 * instead of allocating per call.
 */
export async function readTargetToDataUrl(
  renderer: WebGPURenderer,
  rt: RenderTarget,
  width: number,
  height: number,
  opts: { mime?: string; quality?: number; outW?: number; outH?: number } = {},
): Promise<string> {
  const buf = (await renderer.readRenderTargetPixelsAsync(rt, 0, 0, width, height)) as Uint8Array | Uint8ClampedArray;
  const pixels = new Uint8ClampedArray(buf.buffer, buf.byteOffset, width * height * 4);
  const src = scratch("src", width, height);
  src.getContext("2d")!.putImageData(new ImageData(pixels.slice(), width, height), 0, 0);

  const outW = opts.outW ?? width;
  const outH = opts.outH ?? height;
  const out = scratch("out", outW, outH);
  const octx = out.getContext("2d")!;
  octx.setTransform(1, 0, 0, 1, 0, 0); // reset any flip from a previous call
  octx.clearRect(0, 0, outW, outH);
  // WebGL framebuffers read bottom-up; WebGPU reads top-down.
  if ((renderer.backend as { isWebGLBackend?: boolean }).isWebGLBackend === true) {
    octx.translate(0, outH);
    octx.scale(1, -1);
  }
  octx.drawImage(src, 0, 0, outW, outH);
  return out.toDataURL(opts.mime ?? "image/jpeg", opts.quality ?? 0.72);
}
