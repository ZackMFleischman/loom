import { BuildCtx, defineModule, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import {
  abs,
  cos,
  cross,
  dot,
  float,
  sign,
  sin,
  step,
  texture,
  uv,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import type { Node } from "three/webgpu";
import { bufferPass, surfaceAspect } from "../_shared";

/** A live 2D/3D placement: every field is a signal, so transforms animate for free. */
export interface Transform {
  /** Center x in uv space (0..1, 0.5 = screen center). */
  x?: SignalLike;
  /** Center y in uv space (0..1, 0.5 = screen center). */
  y?: SignalLike;
  /** In-plane spin in radians, counter-clockwise (rotation about the z axis). */
  rotate?: SignalLike;
  /** 3D tilt about the horizontal axis in radians — the top leans away when positive. */
  rotateX?: SignalLike;
  /** 3D tilt about the vertical axis in radians — the card-flip axis. */
  rotateY?: SignalLike;
  /** Uniform scale — 1 spans the surface height. */
  scale?: SignalLike;
  /** Mirrors horizontally when negative — feed a heading signal. */
  mirrorX?: SignalLike;
  /** Perspective focal length in surface-height units (smaller = more dramatic). */
  perspective?: SignalLike;
}

/**
 * The shared transform concept: maps a screen-uv point into the transform's
 * LOCAL plane space — centered, aspect-corrected, y-up, scale 1 spanning the
 * surface height. The plane lives in a tiny per-layer camera (perspective
 * anchored at the layer's center, CSS-style): with no tilt the math reduces
 * to the old affine 2D path exactly; with rotateX/rotateY it solves the
 * ray-plane intersection (a homography — closed form, so sources still
 * sample through it with no render target). Behind-camera intersections at
 * extreme tilt resolve far outside the unit frame, never wrapping into view.
 */
export function localSpace(ctx: BuildCtx, t: Transform = {}): (p: Node<"vec2">) => Node<"vec2"> {
  const x = ctx.uniformOf(t.x ?? 0.5);
  const y = ctx.uniformOf(t.y ?? 0.5);
  const rz = ctx.uniformOf(t.rotate ?? 0);
  const rx = ctx.uniformOf(t.rotateX ?? 0);
  const ry = ctx.uniformOf(t.rotateY ?? 0);
  const scale = ctx.uniformOf(t.scale ?? 1);
  const mirror = ctx.uniformOf(t.mirrorX ?? 1);
  const perspective = ctx.uniformOf(t.perspective ?? 1.5);

  return (p) => {
    const q = p.sub(vec2(x, y)).mul(vec2(surfaceAspect(), 1)); // anchor frame
    const f = perspective.max(0.05);
    const s = scale.max(0.001);

    // Plane basis under R = Rx(rx)·Ry(ry)·Rz(rz), scaled.
    const cz = cos(rz);
    const sz = sin(rz);
    const cy = cos(ry);
    const sy = sin(ry);
    const cx = cos(rx);
    const sx = sin(rx);
    const a = vec3(
      cz.mul(cy),
      sz.mul(cx).add(cz.mul(sy).mul(sx)),
      sz.mul(sx).sub(cz.mul(sy).mul(cx)),
    ).mul(s);
    const b = vec3(
      sz.negate().mul(cy),
      cz.mul(cx).sub(sz.mul(sy).mul(sx)),
      cz.mul(sx).add(sz.mul(sy).mul(cx)),
    ).mul(s);

    // Pinhole ray (through q at depth f) vs the plane at depth f:
    // u·a + v·b − t·d = −C, solved by Cramer (portable — no mat inverse).
    const d = vec3(q, f);
    const c2 = d.negate();
    const r = vec3(0, 0, f.negate());
    const det = dot(a, cross(b, c2));
    const u = dot(cross(b, c2), r).div(det);
    const v = dot(cross(c2, a), r).div(det);
    const hit = dot(cross(a, b), r).div(det);

    const local = vec2(u.mul(sign(mirror)), v);
    // Behind-camera intersections (extreme tilt) get pushed well outside the
    // unit frame. Keep the push SMALL and the args node-first: a huge
    // sentinel (or a number-first step/mix) poisons the uv derivative chain
    // and texture sampling collapses to the lowest mip everywhere.
    const behind = float(1).sub(step(float(0), hit));
    return local.add(behind.mul(10));
  };
}

export interface TransformOpts extends Transform {
  input: TexNode;
}

/**
 * Attach a Transform to ANY chain: the input renders to a buffer, then is
 * re-sampled through the inverse transform — moved, spun, tilted in 3D,
 * scaled, mirrored — with transparent black outside its frame. Stateful —
 * owns one render target so it can move arbitrary upstream content.
 */
export const transform = defineModule(
  {
    name: "transform",
    kind: "effect",
    description: "Moves/spins/3D-tilts/scales/mirrors any input as a layer (live Transform).",
    tags: ["transform", "3d", "layout", "layer", "stateful"],
    example: 'transform(ctx, { input: src, x: 0.3, scale: 0.5, rotateY: flipSig })',
    chainParams: [
      { name: "x", default: 0.5, min: 0, max: 1, step: 0.01, description: "center x (uv)" },
      { name: "y", default: 0.5, min: 0, max: 1, step: 0.01, description: "center y (uv)" },
      { name: "rotate", default: 0, min: -3.1416, max: 3.1416, step: 0.01, description: "in-plane spin (radians)" },
      { name: "rotateX", default: 0, min: -1.5, max: 1.5, step: 0.01, description: "3D tilt about horizontal" },
      { name: "rotateY", default: 0, min: -1.5, max: 1.5, step: 0.01, description: "3D tilt about vertical" },
      { name: "scale", default: 1, min: 0.1, max: 3, step: 0.01, description: "uniform scale" },
      { name: "perspective", default: 1.5, min: 0.3, max: 5, step: 0.01, description: "focal length (smaller = more dramatic)" },
    ],
  },
  (ctx: BuildCtx, opts: TransformOpts): TexNode => {
    const { rt, pass } = bufferPass(opts.input);

    const l = localSpace(ctx, opts)(uv());
    const suv = l.div(vec2(surfaceAspect(), 1)).add(0.5);
    const d = abs(suv.sub(0.5));
    const inside = step(d.x, 0.5).mul(step(d.y, 0.5));
    const s = texture(rt.texture, suv);

    return texNode(vec4(s.rgb.mul(inside), s.a.mul(inside)), [...opts.input.passes, pass]);
  },
);
