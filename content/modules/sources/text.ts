import { BuildCtx, defineModule, texNode, type Pass, type TexNode } from "@loom/runtime";
import { abs, step, texture, uniform, uv, vec2, vec4 } from "three/tsl";
import { CanvasTexture, SRGBColorSpace } from "three/webgpu";
import { localSpace, type Transform } from "../effects/transform";

export interface TextOpts {
  /** The string to draw (build-time — edit + hot-reload to change). */
  text: string;
  /** CSS font family. */
  font?: string;
  /** CSS font weight. */
  weight?: number | string;
  /** Fill "#rrggbb". */
  color?: string;
  /** Letter spacing in em (0 = normal). */
  tracking?: number;
  /** Optional live placement (position/rotation/scale); omit to center. */
  transform?: Transform;
}

/**
 * Text as a texture (the TD Text TOP): the string renders once to a 2D canvas
 * (crisp at 1080p-height scale) and places like `image` — titles, lyrics, big
 * numbers. Premultiplied alpha; transparent in DOMs without 2D canvas (tests).
 */
export const text = defineModule(
  {
    name: "text",
    kind: "source",
    description: "A text string drawn to a texture, placed like image (titles, lyrics, numbers).",
    tags: ["text", "type", "title", "overlay", "base"],
    example: 'text(ctx, { text: "DROP", weight: 900, transform: { scale: 0.4 } })',
  },
  (ctx: BuildCtx, opts: TextOpts): TexNode => {
    const PAD = 0.25; // em of padding around the glyphs
    const H = 256; // glyph raster height in px — crisp enough for full-frame
    const aspect = uniform(4);

    const canvas = document.createElement("canvas");
    let tex: CanvasTexture | null = null;
    try {
      const cx2d = canvas.getContext("2d");
      if (cx2d) {
        const fontPx = Math.round(H * (1 - PAD * 2));
        const font = `${opts.weight ?? 800} ${fontPx}px ${opts.font ?? "system-ui, sans-serif"}`;
        cx2d.font = font;
        if (opts.tracking) (cx2d as { letterSpacing?: string }).letterSpacing = `${opts.tracking}em`;
        const w = Math.max(2, Math.ceil(cx2d.measureText(opts.text).width) + fontPx * PAD * 2);
        canvas.width = w;
        canvas.height = H;
        // Canvas state resets on resize — set everything again.
        cx2d.font = font;
        if (opts.tracking) (cx2d as { letterSpacing?: string }).letterSpacing = `${opts.tracking}em`;
        cx2d.textBaseline = "middle";
        cx2d.textAlign = "center";
        cx2d.fillStyle = opts.color ?? "#ffffff";
        cx2d.fillText(opts.text, w / 2, H / 2);
        aspect.value = w / H;
        tex = new CanvasTexture(canvas);
        tex.colorSpace = SRGBColorSpace;
      }
    } catch {
      // headless test DOM without 2D canvas — stay transparent
    }

    const pass: Pass = {
      render() {},
      dispose() {
        tex?.dispose();
      },
    };
    if (tex == null) return texNode(vec4(0, 0, 0, 0), [pass]);

    const l = localSpace(ctx, opts.transform)(uv());
    const tuv = vec2(l.x.div(aspect), l.y.negate()).add(0.5);
    const d = abs(tuv.sub(0.5));
    const inside = step(d.x, 0.5).mul(step(d.y, 0.5));
    const col = texture(tex, tuv);
    return texNode(vec4(col.rgb.mul(col.a).mul(inside), col.a.mul(inside)), [pass]);
  },
);
