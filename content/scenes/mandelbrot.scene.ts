import { Signal, defineScene } from "@loom/runtime";
import { colorize, PALETTES, PALETTE_SWATCHES } from "../modules/effects/colorize";
import { levels } from "../modules/effects/levels";
import { mandelbrot } from "../modules/sources/mandelbrot";

/** Classic zoom destinations — shallow enough for float32 GPU precision. */
const POINTS = [
  { name: "overview", x: -0.6, y: 0 },
  { name: "seahorse valley", x: -0.74364388703, y: 0.13182590421 },
  { name: "elephant valley", x: 0.2549870375144766, y: 0.0005679790528465 },
  { name: "double spiral", x: -0.745428, y: 0.113009 },
  { name: "misiurewicz branch", x: -0.1011, y: 0.9563 },
];

export default defineScene({
  name: "mandelbrot",
  description:
    "Mandelbrot dive: ping-pong zooms into pickable interesting points while cosine palettes morph and scroll.",
  tags: ["fractal", "zoom", "palette", "generative"],
  build(ctx) {
    // Dotted paths form collapsible Console groups: zoom / color. iter stays flat (quality knob).
    const point = ctx.int("zoom.point", {
      default: 1,
      min: 0,
      max: POINTS.length - 1,
      description: `zoom target: ${POINTS.map((p, i) => `${i}=${p.name}`).join(", ")}`,
    });
    const dive = ctx.float("zoom.dive", { default: 0.35, min: -2, max: 2, description: "zoom speed (octaves/sec, ping-pongs)" });
    const depth = ctx.float("zoom.depth", { default: 14, min: 1, max: 18, description: "max zoom depth in octaves (f32 limit ~18)" });
    const iter = ctx.int("iter", { default: 250, min: 40, max: 500, description: "escape-time iteration cap (detail vs cost)" });
    const palette = ctx.float("color.palette", {
      default: 0,
      min: 0,
      max: PALETTES.length,
      swatches: PALETTE_SWATCHES,
      description: `palette: ${PALETTES.map((p, i) => `${i}=${p.name}`).join(", ")} (fractional blends, wraps)`,
    });
    const drift = ctx.float("color.drift", { default: 0.02, min: -0.3, max: 0.3, description: "auto palette morph speed (palettes/sec)" });
    const cycle = ctx.float("color.cycle", { default: 0.05, min: -0.5, max: 0.5, description: "color scroll speed along the gradient" });
    const bands = ctx.float("color.bands", { default: 2.5, min: 0.25, max: 8, description: "palette cycles across the brightness range" });

    const pointSig = point.signal();
    const diveSig = dive.signal();
    const depthSig = depth.signal();
    const paletteSig = palette.signal();
    const driftSig = drift.signal();
    const cycleSig = cycle.signal();

    // Palette index drifts on its own; phase scrolls the colors continuously.
    let palAcc = 0;
    const paletteIndex = new Signal((f) => {
      palAcc += driftSig.get(f) * f.dt;
      return paletteSig.get(f) + palAcc;
    });
    let phaseAcc = 0;
    const shift = new Signal((f) => {
      phaseAcc += cycleSig.get(f) * f.dt;
      return phaseAcc;
    });

    const fractal = mandelbrot(ctx, {
      cx: new Signal((f) => POINTS[Math.round(pointSig.get(f))]!.x),
      cy: new Signal((f) => POINTS[Math.round(pointSig.get(f))]!.y),
      glide: 1.2,
      dive: diveSig,
      depth: depthSig,
      iterations: iter.signal(),
    });
    const colored = colorize(ctx, {
      input: fractal,
      palette: paletteIndex,
      shift,
      bands: bands.signal(),
    });
    return levels(ctx, { input: colored, gain: 1.05, gamma: 1.05 });
  },
});
