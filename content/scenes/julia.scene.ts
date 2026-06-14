import { Signal, defineScene } from "@loom/runtime";
import { colorize, PALETTES, PALETTE_SWATCHES } from "../modules/effects/colorize";
import { levels } from "../modules/effects/levels";
import { julia } from "../modules/sources/julia";

/** Classic Julia constants — each (x,y) is a different, named fractal. */
const CONSTANTS = [
  { name: "dendrite", x: -0.4, y: 0.6 },
  { name: "spiral", x: -0.8, y: 0.156 },
  { name: "douady rabbit", x: -0.123, y: 0.745 },
  { name: "san marco", x: -0.75, y: 0 },
  { name: "siegel disk", x: -0.391, y: -0.587 },
  { name: "frost fern", x: 0.285, y: 0.01 },
  { name: "lightning", x: -0.70176, y: -0.3842 },
  { name: "galaxy", x: 0.355, y: 0.355 },
];

export default defineScene({
  name: "julia",
  description:
    "Julia morph: pick a classic constant and let c orbit so the whole filigree breathes, while cosine palettes drift and scroll.",
  tags: ["fractal", "morph", "palette", "generative"],
  build(ctx) {
    // Dotted paths form collapsible Console groups: shape / color. iter stays flat (quality knob).
    const point = ctx.int("shape.constant", {
      default: 1,
      min: 0,
      max: CONSTANTS.length - 1,
      description: `Julia constant: ${CONSTANTS.map((p, i) => `${i}=${p.name}`).join(", ")}`,
    });
    const morph = ctx.float("shape.morph", { default: 0.04, min: -0.4, max: 0.4, description: "c orbit speed (revolutions/sec) — the breathing" });
    const radius = ctx.float("shape.radius", { default: 0.04, min: 0, max: 0.2, description: "c orbit radius (tiny = subtle morph; big = wild)" });
    const zoom = ctx.float("shape.zoom", { default: 1.4, min: 0.3, max: 3, description: "view half-extent (smaller = closer in)" });
    const iter = ctx.int("iter", { default: 250, min: 40, max: 500, description: "escape-time iteration cap (detail vs cost)" });
    const palette = ctx.float("color.palette", {
      default: 3,
      min: 0,
      max: PALETTES.length,
      swatches: PALETTE_SWATCHES,
      description: `palette: ${PALETTES.map((p, i) => `${i}=${p.name}`).join(", ")} (fractional blends, wraps)`,
    });
    const drift = ctx.float("color.drift", { default: 0.02, min: -0.3, max: 0.3, description: "auto palette morph speed (palettes/sec)" });
    const cycle = ctx.float("color.cycle", { default: 0.05, min: -0.5, max: 0.5, description: "color scroll speed along the gradient" });
    const bands = ctx.float("color.bands", { default: 2.5, min: 0.25, max: 8, description: "palette cycles across the brightness range" });

    const pointSig = point.signal();
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

    const fractal = julia(ctx, {
      cx: new Signal((f) => CONSTANTS[Math.round(pointSig.get(f))]!.x),
      cy: new Signal((f) => CONSTANTS[Math.round(pointSig.get(f))]!.y),
      glide: 1.2,
      morph: morph.signal(),
      morphRadius: radius.signal(),
      scale: zoom.signal(),
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
