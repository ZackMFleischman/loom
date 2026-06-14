import { BuildCtx, defineModule, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import { abs, max, mix, vec3, vec4 } from "three/tsl";

export interface MixerOpts {
  /** Deck A (mix = 0). */
  input: TexNode;
  /** Deck B (mix = 1). */
  b: TexNode;
  /** Blend operator (compile-time). */
  mode?: "crossfade" | "add" | "multiply" | "screen" | "difference";
  /** 0 = all A · 1 = all B (or full operator strength). */
  mix?: SignalLike;
}

/**
 * Two-input blend (the TD Cross/Composite TOPs): crossfade/add/multiply/
 * screen/difference with the mix on a fader — the A/B deck mixer. A scene-
 * composition module (chains have one input; this needs two), passes from
 * both decks preserved in order.
 */
export const mixer = defineModule(
  {
    name: "mixer",
    kind: "effect",
    description: "Blends two TexNodes: crossfade/add/multiply/screen/difference on a fader.",
    tags: ["mix", "blend", "crossfade", "composite", "deck"],
    example: 'mixer(ctx, { input: deckA, b: deckB, mode: "crossfade", mix: fader.signal() })',
  },
  (ctx: BuildCtx, opts: MixerOpts): TexNode => {
    const m = ctx.uniformOf(opts.mix ?? 0.5).clamp(0, 1);
    const a = opts.input.color;
    const b = opts.b.color;
    const mode = opts.mode ?? "crossfade";

    let rgb;
    let alpha;
    if (mode === "add") {
      rgb = a.rgb.add(b.rgb.mul(m));
      alpha = max(a.a, b.a.mul(m));
    } else if (mode === "multiply") {
      rgb = a.rgb.mul(mix(vec3(1, 1, 1), b.rgb, m));
      alpha = a.a;
    } else if (mode === "screen") {
      const one = vec3(1, 1, 1);
      rgb = one.sub(one.sub(a.rgb).mul(one.sub(b.rgb.mul(m))));
      alpha = max(a.a, b.a.mul(m));
    } else if (mode === "difference") {
      rgb = abs(a.rgb.sub(b.rgb.mul(m)));
      alpha = max(a.a, b.a.mul(m));
    } else {
      rgb = mix(a.rgb, b.rgb, m);
      alpha = mix(a.a, b.a, m);
    }
    return texNode(vec4(rgb, alpha), [...opts.input.passes, ...opts.b.passes]);
  },
);
