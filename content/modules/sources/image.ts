import { BuildCtx, defineModule, texNode, type Pass, type TexNode } from "@loom/runtime";
import { abs, step, texture, uniform, uv, vec2, vec4 } from "three/tsl";
import { SRGBColorSpace, TextureLoader } from "three/webgpu";
import { localSpace, type Transform } from "../effects/transform";

export interface ImageOpts {
  /** Image URL — from a scene use `new URL("../assets/x.png", import.meta.url).href`. */
  url: string;
  /** Optional live placement (position/rotation/3D tilt/scale/mirror); omit to center. */
  transform?: Transform;
}

/**
 * Base image source: loads a texture by URL and draws it aspect-correct
 * (contain-by-height, upright) with premultiplied alpha on transparent
 * black. Attach a Transform2D to place it; layer with `over`. The image
 * loads async — transparent for the first few frames until it arrives.
 */
export const image = defineModule(
  {
    name: "image",
    kind: "source",
    description: "An image file drawn aspect-correct, placed by an attachable Transform (2D/3D).",
    tags: ["image", "texture", "media", "base"],
    example: 'image(ctx, { url: imgUrl, transform: { rotate: angleSig, scale: 0.5 } })',
  },
  (ctx: BuildCtx, opts: ImageOpts): TexNode => {
    const aspect = uniform(1); // image w/h, known only after the async load
    const tex = new TextureLoader().load(opts.url, (t) => {
      aspect.value = t.image.width / t.image.height;
    });
    tex.colorSpace = SRGBColorSpace;

    // Local space -> image uv: fit by height, flip v (texture rows are
    // top-down while local space is y-up).
    const l = localSpace(ctx, opts.transform)(uv());
    const iuv = vec2(l.x.div(aspect), l.y.negate()).add(0.5);
    const d = abs(iuv.sub(0.5));
    const inside = step(d.x, 0.5).mul(step(d.y, 0.5));
    const col = texture(tex, iuv);

    const pass: Pass = {
      render() {}, // no per-frame work — pass exists to own the texture's lifetime
      dispose() {
        tex.dispose();
      },
    };

    // Premultiplied alpha: rgb scaled by coverage, real alpha rides along
    // so compositors (`over`) can blend it.
    return texNode(vec4(col.rgb.mul(col.a).mul(inside), col.a.mul(inside)), [pass]);
  },
);
