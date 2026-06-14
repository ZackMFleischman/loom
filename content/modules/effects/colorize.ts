import { BuildCtx, defineModule, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import { cos, float, luminance, mix, smoothstep, uniform, vec4 } from "three/tsl";
import { Vector3 } from "three/webgpu";

const TAU = Math.PI * 2;

/** Inigo Quilez cosine palette: color(t) = a + b*cos(TAU*(c*t + d)). */
export interface PalettePreset {
  name: string;
  a: [number, number, number];
  b: [number, number, number];
  c: [number, number, number];
  d: [number, number, number];
}

/** The shared palette library — index into this with colorize's `palette` opt. */
export const PALETTES: PalettePreset[] = [
  { name: "rainbow", a: [0.5, 0.5, 0.5], b: [0.5, 0.5, 0.5], c: [1, 1, 1], d: [0.0, 0.33, 0.67] },
  { name: "sunset", a: [0.5, 0.5, 0.5], b: [0.5, 0.5, 0.5], c: [1, 1, 1], d: [0.0, 0.1, 0.2] },
  { name: "ocean", a: [0.5, 0.5, 0.5], b: [0.5, 0.5, 0.5], c: [1, 1, 0.5], d: [0.8, 0.9, 0.3] },
  { name: "neon", a: [0.5, 0.5, 0.5], b: [0.5, 0.5, 0.5], c: [2, 1, 0], d: [0.5, 0.2, 0.25] },
  { name: "fire", a: [0.7, 0.4, 0.2], b: [0.3, 0.4, 0.2], c: [2, 1, 1], d: [0.0, 0.25, 0.25] },
  { name: "ice", a: [0.5, 0.5, 0.6], b: [0.4, 0.4, 0.5], c: [1, 0.7, 0.4], d: [0.55, 0.6, 0.7] },
];

const hex2 = (v: number) =>
  Math.max(0, Math.min(255, Math.round(v * 255)))
    .toString(16)
    .padStart(2, "0");

/** Sample one cosine preset into `n` ordered "#rrggbb" stops across t in 0..1. */
export function paletteSwatch(preset: PalettePreset, n = 6): string[] {
  const stops: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1);
    const rgb = [0, 1, 2].map((k) => {
      const v = preset.a[k]! + preset.b[k]! * Math.cos(2 * Math.PI * (preset.c[k]! * t + preset.d[k]!));
      return v;
    });
    stops.push(`#${hex2(rgb[0]!)}${hex2(rgb[1]!)}${hex2(rgb[2]!)}`);
  }
  return stops;
}

/**
 * Color previews for the cosine PALETTES, one gradient per preset — feed this
 * to a `ctx.float("…palette", { swatches: PALETTE_SWATCHES })` so the Console
 * draws a visual palette chooser instead of a bare numeric slider (R7.3).
 * Option index lines up with the integer palette index colorize consumes.
 */
export const PALETTE_SWATCHES: string[][] = PALETTES.map((p) => paletteSwatch(p));

export interface ColorizeOpts {
  input: TexNode;
  /** Fractional index into PALETTES — 1.5 is halfway between presets 1 and 2; wraps. */
  palette?: SignalLike;
  /** Phase offset added to t — animate to scroll colors along the gradient. */
  shift?: SignalLike;
  /** How many palette cycles span the 0..1 luminance range (banding density). */
  bands?: SignalLike;
  /** 1 keeps near-black input black (masks the palette); 0 colors everything. */
  preserveBlack?: SignalLike;
}

/**
 * Maps input luminance through an animatable cosine palette (IQ-style).
 * The palette coefficients are lerped on the CPU each frame from the shared
 * PALETTES presets, so a drifting `palette` signal morphs hues smoothly.
 * Stateless — works on the node graph directly, no render target.
 */
export const colorize = defineModule(
  {
    name: "colorize",
    kind: "effect",
    description: "Luminance-to-color mapping through animatable cosine palettes (PALETTES presets).",
    tags: ["color", "palette", "gradient", "grade"],
    example: 'colorize(ctx, { input: src, palette: driftSig, bands: 2, shift: 0.1 })',
    chainParams: [
      { name: "palette", default: 0, min: 0, max: 6, step: 0.01, description: "fractional palette index (wraps)" },
      { name: "shift", default: 0, min: 0, max: 1, step: 0.01, description: "scroll colors along the gradient" },
      { name: "bands", default: 1, min: 0.25, max: 8, step: 0.05, description: "palette cycles across luminance" },
      { name: "preserveBlack", default: 1, min: 0, max: 1, description: "1 keeps near-black input black" },
    ],
  },
  (ctx: BuildCtx, opts: ColorizeOpts): TexNode => {
    const a = uniform(new Vector3());
    const b = uniform(new Vector3());
    const c = uniform(new Vector3());
    const d = uniform(new Vector3());

    const pal = opts.palette ?? 0;
    ctx.updaters.push((f) => {
      const p = typeof pal === "number" ? pal : pal.get(f);
      const n = PALETTES.length;
      const i0 = ((Math.floor(p) % n) + n) % n;
      const i1 = (i0 + 1) % n;
      const fr = p - Math.floor(p);
      const e = fr * fr * (3 - 2 * fr); // ease so integer indices hold steady
      for (const [u, key] of [
        [a, "a"],
        [b, "b"],
        [c, "c"],
        [d, "d"],
      ] as const) {
        const lo = PALETTES[i0]![key];
        const hi = PALETTES[i1]![key];
        u.value.set(
          lo[0] + (hi[0] - lo[0]) * e,
          lo[1] + (hi[1] - lo[1]) * e,
          lo[2] + (hi[2] - lo[2]) * e,
        );
      }
    });

    const shift = ctx.uniformOf(opts.shift ?? 0);
    const bands = ctx.uniformOf(opts.bands ?? 1);
    const preserve = ctx.uniformOf(opts.preserveBlack ?? 1);

    const t = luminance(opts.input.color.rgb);
    const phase = t.mul(bands).add(shift);
    const col = a.add(b.mul(cos(phase.mul(c).add(d).mul(TAU))));
    const mask = mix(float(1), smoothstep(0.0, 0.02, t), preserve);

    return texNode(vec4(col.mul(mask), 1), opts.input.passes);
  },
);
