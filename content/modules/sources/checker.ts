import { BuildCtx, defineModule, integrateSignal, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import { abs, add, floor, fract, min, mix, step, uv, vec2, vec3, vec4 } from "three/tsl";
import { surfaceAspect, parseHex } from "../_shared";

export interface CheckerOpts {
  /** Cells across the width. */
  count?: SignalLike;
  /** Grid-line width as a fraction of a cell — 0 = pure checkerboard. */
  line?: SignalLike;
  /** Scroll speed in cells/sec (positive drifts right-down). */
  scroll?: SignalLike;
  /** Dark cell / line color "#rrggbb". */
  colorA?: string;
  /** Light cell color "#rrggbb". */
  colorB?: string;
}


/**
 * Checkerboard / grid field (the TD Checkerboard + Grid TOPs in one):
 * `line` > 0 draws grid lines over the cells — projection sanity, retro
 * floors, displacer fodder.
 */
export const checker = defineModule(
  {
    name: "checker",
    kind: "source",
    description: "Checkerboard/grid cells with optional grid lines and scroll.",
    tags: ["checker", "grid", "pattern", "base"],
    example: 'checker(ctx, { count: 8, line: 0.06, scroll: 0.5 })',
  },
  (ctx: BuildCtx, opts: CheckerOpts = {}): TexNode => {
    const count = ctx.uniformOf(opts.count ?? 8);
    const line = ctx.uniformOf(opts.line ?? 0);
    // Frame-clock scroll (never TSL time); the pattern repeats every 2 cells,
    // so wrapping there keeps the phase float-precise forever.
    const phase = ctx.uniformOf(integrateSignal(opts.scroll ?? 0, { wrap: 2 }));

    const cells = uv().mul(vec2(surfaceAspect(), 1)).mul(count.max(1)).add(phase);
    const id = floor(cells);
    const odd = fract(add(id.x, id.y).mul(0.5)).mul(2); // 0 or 1 per cell
    const inCell = fract(cells);
    const toEdge = min(min(inCell.x, inCell.y), min(abs(inCell.x.oneMinus()), abs(inCell.y.oneMinus())));
    const isLine = step(toEdge, line.mul(0.5));

    const a = vec3(...parseHex(opts.colorA ?? "#10131c"));
    const b = vec3(...parseHex(opts.colorB ?? "#e8ecf4"));
    const cell = mix(a, b, odd);
    return texNode(vec4(mix(cell, a, isLine), 1));
  },
);
