import { BuildCtx, defineModule, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import { abs, cos, sin, texture, uv, vec2, vec4 } from "three/tsl";
import { bufferPass } from "../_shared";

export interface MirrorOpts {
  input: TexNode;
  /** Fold-line angle in radians (0 = vertical line, mirrors left↔right). */
  angle?: SignalLike;
  /** Fold-line offset from center (−0.5..0.5). */
  offset?: SignalLike;
}

/**
 * Single-axis reflection (the TD Mirror TOP): folds the frame across a line
 * through (near) the center — instant symmetry, far cheaper than `kaleido`.
 * Buffers the input once and resamples through the fold.
 */
export const mirror = defineModule(
  {
    name: "mirror",
    kind: "effect",
    description: "Folds the frame across an angled line — one-axis symmetry.",
    tags: ["mirror", "symmetry", "fold", "stateful"],
    example: 'mirror(ctx, { input: src, angle: 0, offset: 0 })',
    chainParams: [
      { name: "angle", default: 0, min: -3.1416, max: 3.1416, step: 0.01, description: "fold-line angle (radians)" },
      { name: "offset", default: 0, min: -0.5, max: 0.5, step: 0.005, description: "fold-line offset from center" },
    ],
  },
  (ctx: BuildCtx, opts: MirrorOpts): TexNode => {
    const angle = ctx.uniformOf(opts.angle ?? 0);
    const offset = ctx.uniformOf(opts.offset ?? 0);
    const { rt, pass } = bufferPass(opts.input);

    // Rotate into fold space, reflect onto the line's left side, rotate back:
    // x' = offset − |x − offset| always reads left-of-line content.
    const c = cos(angle);
    const s = sin(angle);
    const q = uv().sub(0.5);
    const local = vec2(c.mul(q.x).add(s.mul(q.y)), c.mul(q.y).sub(s.mul(q.x)));
    const folded = vec2(offset.sub(abs(local.x.sub(offset))), local.y);
    const back = vec2(c.mul(folded.x).sub(s.mul(folded.y)), s.mul(folded.x).add(c.mul(folded.y))).add(0.5);
    const sam = texture(rt.texture, back);
    return texNode(vec4(sam.rgb, sam.a), [...opts.input.passes, pass]);
  },
);
