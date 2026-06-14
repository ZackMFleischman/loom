// Shared headless-Chromium GL flags for the validators.
//
// LOOM's automated checks assert against three's WebGL2 fallback — their pixel
// thresholds are calibrated for it (see docs/architecture.md "Validation
// approach"). Two knobs make that happen on any host:
//
// 1. GL backend (glArgs): WHICH GL implementation Chromium offers.
//    - Windows dev machines: ANGLE over D3D11 (the real GPU).
//    - Linux CI (GitHub runners): no GPU, so SwiftShader (Chromium's software
//      GL) provides the WebGL2 context. Without it the canvas is black.
//
// 2. WebGPU selection (forceWebGL2): three's WebGPURenderer auto-picks WebGPU
//    whenever navigator.gpu exists. Recent headless Chromium (Chrome 148 on the
//    runners) exposes navigator.gpu regardless of flags, and that software
//    WebGPU path renders blank/white or hangs the screenshot. Chromium flags do
//    NOT reliably turn it off, so we hide navigator.gpu from the page instead —
//    then WebGPURenderer falls back to the WebGL2 backend the checks expect.
//
// GL backend default is chosen by platform; override with
//   LOOM_GL=d3d11 | swiftshader | egl
import { platform } from "node:os";

const choice = process.env.LOOM_GL ?? (platform() === "win32" ? "d3d11" : "swiftshader");

/** GL-backend args, spread into a validator's chromium.launch({ args }). */
export const glArgs =
  choice === "swiftshader"
    ? ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
    : choice === "egl"
      ? ["--use-gl=egl"]
      : ["--enable-unsafe-webgpu", "--enable-features=Vulkan", `--use-angle=${choice}`];

// Runs before any page script: makes navigator.gpu read as undefined so three's
// WebGPURenderer selects its WebGL2 backend. Defined on the prototype (where the
// real accessor lives) with the instance as a fallback.
const HIDE_WEBGPU = () => {
  const hide = (obj) => {
    try {
      Object.defineProperty(obj, "gpu", { configurable: true, get: () => undefined });
    } catch {}
  };
  hide(Navigator.prototype);
  hide(navigator);
};

/**
 * Force the WebGL2 backend for a Playwright page or context (both expose
 * addInitScript). Call after creation, before the first goto.
 */
export const forceWebGL2 = (pageOrContext) => pageOrContext.addInitScript(HIDE_WEBGPU);

// A `&res=WxH` query fragment when LOOM_RES is set, else "". Software WebGL2 on
// CI can't render LOOM's heavy scenes (pho-nebula's multi-pass feedback) at the
// default 1920×1080 fast enough for a screenshot — the compositor never hands
// Playwright a frame and the shot times out. Lowering the internal render res
// (e.g. LOOM_RES=640x360) cuts fragment cost ~9× and frames land in time. Empty
// by default, so local hardware-GL runs keep full-resolution fidelity.
export const resQuery = process.env.LOOM_RES ? `&res=${process.env.LOOM_RES}` : "";
