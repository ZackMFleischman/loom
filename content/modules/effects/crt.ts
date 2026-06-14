import { BuildCtx, defineModule, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import { abs, length, sin, smoothstep, step, texture, uv, vec2, vec3, vec4 } from "three/tsl";
import { bufferPass } from "../_shared";

export interface CrtOpts {
  input: TexNode;
  /** Scanline darkness 0..1. */
  scan?: SignalLike;
  /** Barrel distortion strength (0 = flat glass). */
  curve?: SignalLike;
  /** Edge color fringing. */
  aberration?: SignalLike;
}

/**
 * CRT finish (the retro bundle): barrel distortion, scanlines, and corner
 * fringing in one step — flatters anything pixelated, posterized or archival.
 */
export const crt = defineModule(
  {
    name: "crt",
    kind: "effect",
    description: "CRT look: barrel curvature, scanlines, edge fringing in one step.",
    tags: ["crt", "retro", "scanlines", "finish", "stateful"],
    example: 'crt(ctx, { input: src, scan: 0.35, curve: 0.15 })',
    chainParams: [
      { name: "scan", default: 0.3, min: 0, max: 1, step: 0.01, description: "scanline darkness" },
      { name: "curve", default: 0.12, min: 0, max: 0.5, step: 0.01, description: "barrel distortion" },
      { name: "aberration", default: 0.4, min: 0, max: 1, step: 0.01, description: "edge color fringing" },
    ],
  },
  (ctx: BuildCtx, opts: CrtOpts): TexNode => {
    const scan = ctx.uniformOf(opts.scan ?? 0.3).clamp(0, 1);
    const curve = ctx.uniformOf(opts.curve ?? 0.12);
    const aberration = ctx.uniformOf(opts.aberration ?? 0.4);
    const { rt, pass } = bufferPass(opts.input);

    // Barrel: push UVs outward by radial distance squared.
    const q = uv().sub(0.5);
    const r2 = length(q).pow(2);
    const buv = q.mul(r2.mul(curve).add(1)).add(0.5);
    const inside = step(abs(buv.x.sub(0.5)), 0.5).mul(step(abs(buv.y.sub(0.5)), 0.5));

    // Edge fringing scales with distance from center.
    const fringe = r2.mul(aberration).mul(0.012);
    const rC = texture(rt.texture, buv.add(vec2(fringe, 0))).r;
    const gC = texture(rt.texture, buv);
    const bC = texture(rt.texture, buv.sub(vec2(fringe, 0))).b;

    // Scanlines ride the curved space so they bend with the glass.
    const lines = sin(buv.y.mul(720 * Math.PI)).mul(0.5).add(0.5);
    const dim = lines.mul(scan).oneMinus();
    // Soft tube-corner falloff.
    const corner = smoothstep(0.62, 0.45, length(q));

    const shade = dim.mul(inside).mul(corner.mul(0.6).add(0.4));
    return texNode(vec4(vec3(rC, gC.g, bC).mul(shade), gC.a), [...opts.input.passes, pass]);
  },
);
