import { asSignal, BuildCtx, defineModule, texNode, type Pass, type SignalLike, type TexNode } from "@loom/runtime";
import { abs, step, texture, uniform, uv, vec2, vec4 } from "three/tsl";
import { SRGBColorSpace, VideoTexture } from "three/webgpu";
import { localSpace, type Transform } from "../effects/transform";

/** URL for a file OUTSIDE the repo, served by the loom:media middleware (must
 * live under a root registered in content/state/media-roots.json). */
export function mediaUrl(absolutePath: string): string {
  return `/loom/media?p=${encodeURIComponent(absolutePath)}`;
}

export interface VideoOpts {
  /** Clip URL — a repo asset (`new URL("../assets/x.mp4", import.meta.url).href`) or `mediaUrl(<abs path>)`. */
  url: string;
  /** Optional live placement (position/rotation/3D tilt/scale/mirror); omit to center. */
  transform?: Transform;
  /** Playback rate 0..4 — ≤0.01 pauses and holds the frame (default 1). */
  speed?: SignalLike;
  /** >0.5 = scrub mode: playback holds and the head chases `scrub` (default off). */
  scrubbing?: SignalLike;
  /** Scrub position as a 0..1 fraction of the clip (only while scrubbing). */
  scrub?: SignalLike;
  /** >0.5 loops the clip (default on). */
  loop?: SignalLike;
}

/**
 * Video clip source: plays an H.264/VP9 file as a texture, drawn aspect-correct
 * (contain-by-height, like `image`) with audio muted. Speed, scrub and loop are
 * Signals — wire them to scene params to retime/scrub live with no rebuild.
 * Loads async — transparent until the first frame arrives; a missing/broken
 * file just stays transparent (never throws the build).
 */
export const video = defineModule(
  {
    name: "video",
    kind: "source",
    description: "A video clip drawn aspect-correct like image, with live speed/scrub/loop control (muted).",
    tags: ["video", "clip", "media", "texture", "base"],
    example: 'video(ctx, { url: mediaUrl("C:/VJ/clip.mp4"), speed: speedParam.signal() })',
  },
  (ctx: BuildCtx, opts: VideoOpts): TexNode => {
    const speed = asSignal(opts.speed ?? 1);
    const scrubbing = asSignal(opts.scrubbing ?? 0);
    const scrub = asSignal(opts.scrub ?? 0);
    const loop = asSignal(opts.loop ?? 1);

    const el = document.createElement("video");
    el.muted = true; // mute-by-default: autoplay-safe, the instrument owns audio
    el.playsInline = true;
    el.loop = true;
    el.preload = "auto";
    el.crossOrigin = "anonymous";
    el.src = opts.url;

    const aspect = uniform(16 / 9); // real w/h known only after metadata loads
    el.addEventListener("loadedmetadata", () => {
      if (el.videoWidth > 0 && el.videoHeight > 0) aspect.value = el.videoWidth / el.videoHeight;
    });

    const tex = new VideoTexture(el);
    tex.colorSpace = SRGBColorSpace;

    // Same placement math as image: contain by height, v flipped (rows top-down).
    const l = localSpace(ctx, opts.transform)(uv());
    const vuv = vec2(l.x.div(aspect), l.y.negate()).add(0.5);
    const d = abs(vuv.sub(0.5));
    const inside = step(d.x, 0.5).mul(step(d.y, 0.5));
    const col = texture(tex, vuv);

    // The element is driven CPU-side once per frame; all media calls are
    // guarded — a half-loaded or unsupported clip must never break the loop.
    const pass: Pass = {
      render(_renderer, f) {
        try {
          const wantScrub = scrubbing.get(f) > 0.5;
          el.loop = loop.get(f) > 0.5;
          if (wantScrub) {
            if (!el.paused) el.pause();
            const dur = el.duration;
            if (Number.isFinite(dur) && dur > 0) {
              const target = Math.min(0.999, Math.max(0, scrub.get(f))) * dur;
              if (Math.abs(el.currentTime - target) > 0.05) el.currentTime = target;
            }
            return;
          }
          const rate = speed.get(f);
          if (rate <= 0.01) {
            if (!el.paused) el.pause();
            return;
          }
          const clamped = Math.min(16, Math.max(0.0625, rate));
          if (el.playbackRate !== clamped) el.playbackRate = clamped;
          if (el.paused) void el.play()?.catch?.(() => {});
        } catch {
          // media element in a weird state (headless test DOM) — hold the frame
        }
      },
      dispose() {
        try {
          el.pause();
          el.removeAttribute("src");
          el.load();
        } catch {
          // tearing down a test DOM's stub element
        }
        tex.dispose();
      },
    };

    // Premultiplied alpha on transparent black outside the frame (video is opaque inside).
    return texNode(vec4(col.rgb.mul(inside), inside), [pass]);
  },
);
