import { defineScene } from "@loom/runtime";
import { crt } from "../modules/effects/crt";
import { mixer } from "../modules/effects/mixer";
import { tile } from "../modules/effects/tile";
import { vignette } from "../modules/effects/vignette";
import { checker } from "../modules/sources/checker";
import { plasma } from "../modules/sources/plasma";

export default defineScene({
  name: "plasma-wall",
  description:
    "A grid-etched palette plasma tiled into an arcade wall, finished behind curved CRT glass — pure retro warmth.",
  tags: ["plasma", "retro", "crt", "wall", "showcase"],
  build(ctx) {
    const heat = ctx.float("plasma.scale", { default: 2.6, min: 0.5, max: 8, description: "plasma interference scale" });
    const churn = ctx.float("plasma.speed", { default: 0.6, min: 0, max: 3, description: "plasma evolution speed" });
    const etch = ctx.float("grid.etch", { default: 0.35, min: 0, max: 1, description: "grid-line etching over the plasma" });
    const wall = ctx.int("wall.count", { default: 2, min: 1, max: 8, description: "wall tiles per axis" });
    const scan = ctx.float("tube.scan", { default: 0.3, min: 0, max: 1, description: "scanline darkness" });
    const curveAmt = ctx.float("tube.curve", { default: 0.16, min: 0, max: 0.5, description: "glass curvature" });
    const corner = ctx.float("tube.vignette", { default: 0.55, min: 0, max: 1, description: "corner falloff" });

    const field = plasma(ctx, { scale: heat.signal(), speed: churn.signal() });
    const grid = checker(ctx, { count: 12, line: 0.08, colorA: "#000000", colorB: "#000000", scroll: 0.2 });
    const etched = ctx.layer(
      "wallface",
      mixer(ctx, { input: field, b: grid, mode: "multiply", mix: etch.signal() }),
    );
    const tiled = tile(ctx, { input: etched, countX: wall.signal(), countY: wall.signal(), mirrorTiles: 1 });
    const glass = crt(ctx, { input: tiled, scan: scan.signal(), curve: curveAmt.signal() });
    return vignette(ctx, { input: glass, amount: corner.signal() });
  },
});
