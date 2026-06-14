import type { RenderTarget, WebGPURenderer } from "three/webgpu";

/**
 * Read a RenderTarget back into a data URL — the one implementation of the
 * "readRenderTargetPixelsAsync → canvas → toDataURL" dance (screenshots,
 * thumbnails, fixture shots). Handles the WebGL bottom-up framebuffer flip
 * and optional rescaling in one place.
 */
export async function readTargetToDataUrl(
  renderer: WebGPURenderer,
  rt: RenderTarget,
  width: number,
  height: number,
  opts: { mime?: string; quality?: number; outW?: number; outH?: number } = {},
): Promise<string> {
  const buf = (await renderer.readRenderTargetPixelsAsync(rt, 0, 0, width, height)) as
    | Uint8Array
    | Uint8ClampedArray;
  const pixels = new Uint8ClampedArray(buf.buffer, buf.byteOffset, width * height * 4);
  const src = document.createElement("canvas");
  src.width = width;
  src.height = height;
  src.getContext("2d")!.putImageData(new ImageData(pixels.slice(), width, height), 0, 0);

  const outW = opts.outW ?? width;
  const outH = opts.outH ?? height;
  const out = document.createElement("canvas");
  out.width = outW;
  out.height = outH;
  const octx = out.getContext("2d")!;
  // WebGL framebuffers read bottom-up; WebGPU reads top-down.
  if ((renderer.backend as { isWebGLBackend?: boolean }).isWebGLBackend === true) {
    octx.translate(0, outH);
    octx.scale(1, -1);
  }
  octx.drawImage(src, 0, 0, outW, outH);
  return out.toDataURL(opts.mime ?? "image/jpeg", opts.quality ?? 0.72);
}
