import { BuildCtx, defineModule, texNode, type Pass, type SignalLike, type TexNode } from "@loom/runtime";
import { abs, mix, step, texture, uniform, uv, vec2, vec4 } from "three/tsl";
import { SRGBColorSpace, VideoTexture } from "three/webgpu";
import { localSpace, type Transform } from "../effects/transform";

export interface WebcamOpts {
  /** Camera device id (from enumerateDevices); omit for the default camera. */
  deviceId?: string;
  /** >0.5 mirrors horizontally (selfie view, default on). */
  mirror?: SignalLike;
  /** Optional live placement; omit to center (contain-by-height like image). */
  transform?: Transform;
}

/**
 * Live camera as a source (the TD Video Device In TOP): getUserMedia video →
 * texture, placed like `image`/`video`. Permission/device failures stay
 * transparent and log — the build never throws. Half of VJing is a camera.
 */
export const webcam = defineModule(
  {
    name: "webcam",
    kind: "source",
    description: "Live camera input drawn aspect-correct like image (mirrored by default).",
    tags: ["camera", "webcam", "live", "media", "base"],
    example: 'webcam(ctx, { mirror: 1, transform: { scale: 1 } })',
  },
  (ctx: BuildCtx, opts: WebcamOpts = {}): TexNode => {
    const el = document.createElement("video");
    el.muted = true;
    el.playsInline = true;
    el.autoplay = true;
    const aspect = uniform(16 / 9);

    try {
      navigator.mediaDevices
        ?.getUserMedia({
          video: opts.deviceId ? { deviceId: { exact: opts.deviceId } } : true,
          audio: false,
        })
        .then((stream) => {
          el.srcObject = stream;
          el.addEventListener("loadedmetadata", () => {
            if (el.videoWidth > 0 && el.videoHeight > 0) aspect.value = el.videoWidth / el.videoHeight;
          });
          void el.play()?.catch?.(() => {});
        })
        .catch((err) => console.warn("[loom] webcam unavailable — source stays transparent", err));
    } catch (err) {
      console.warn("[loom] webcam unavailable — source stays transparent", err);
    }

    const tex = new VideoTexture(el);
    tex.colorSpace = SRGBColorSpace;
    const mirror = ctx.uniformOf(opts.mirror ?? 1);

    const l = localSpace(ctx, opts.transform)(uv());
    const wuv0 = vec2(l.x.div(aspect), l.y.negate()).add(0.5);
    const wuv = vec2(mix(wuv0.x, wuv0.x.oneMinus(), step(0.5, mirror)), wuv0.y);
    const d = abs(wuv0.sub(0.5));
    const inside = step(d.x, 0.5).mul(step(d.y, 0.5));
    const col = texture(tex, wuv);

    const pass: Pass = {
      render() {}, // no per-frame work — the pass owns the stream's lifetime
      dispose() {
        try {
          (el.srcObject as MediaStream | null)?.getTracks().forEach((t) => t.stop());
          el.srcObject = null;
        } catch {
          // tearing down a test DOM's stub element
        }
        tex.dispose();
      },
    };

    return texNode(vec4(col.rgb.mul(inside), inside), [pass]);
  },
);
