import { defineScene, Signal } from "@loom/runtime";
import { bloom } from "../modules/effects/bloom";
import { feedback } from "../modules/effects/feedback";
import { noiseField } from "../modules/sources/noiseField";

/**
 * Noise-as-image (the TOP role): a palette-ramped fractal noise field flowing
 * across the frame, smeared into clouds by video feedback and lit by a kick
 * bloom. The bass swells the field's scale so the whole texture breathes.
 */
export default defineScene({
  name: "noise-flow",
  description:
    "A palette-ramped fractal noise field flowing into feedback clouds — bass breathes the scale, the kick blooms it.",
  tags: ["noise", "fractal", "palette", "feedback", "audio-reactive"],
  build(ctx) {
    const scale = ctx.float("field.scale", { default: 2.5, min: 0.5, max: 10, step: 0.1, description: "noise feature density" });
    const swell = ctx.float("field.swell", { default: 2, min: 0, max: 6, step: 0.1, description: "extra density per bass" });
    const gain = ctx.float("field.roughness", { default: 0.55, min: 0.2, max: 0.85, step: 0.01, description: "per-octave roughness" });
    const contrast = ctx.float("field.contrast", { default: 1.3, min: 0.4, max: 3, step: 0.05, description: "exponent contrast" });
    const flow = ctx.float("field.flow", { default: 0.18, min: 0, max: 1, step: 0.01, description: "horizontal drift speed" });
    const evolve = ctx.float("field.evolve", { default: 0.25, min: 0, max: 1.5, step: 0.01, description: "in-place churn speed" });
    const trail = ctx.float("trail.amount", { default: 0.84, min: 0, max: 0.96, step: 0.01, description: "feedback persistence" });
    const zoom = ctx.float("trail.zoom", { default: 1.012, min: 0.98, max: 1.06, step: 0.001, description: "feedback zoom drift" });
    const glow = ctx.float("glow.bloom", { default: 0.5, min: 0, max: 1, step: 0.01, description: "bloom threshold" });

    const bass = ctx.input("bass");
    const kick = ctx.input("kick");
    const scaleSig = scale.signal();
    const swellSig = swell.signal();

    const field = ctx.layer(
      "flow",
      noiseField(ctx, {
        type: "perlin",
        palette: true,
        octaves: 5,
        scale: new Signal((f) => scaleSig.get(f) + bass.get(f) * swellSig.get(f)),
        gain: gain.signal(),
        lacunarity: 2,
        exponent: contrast.signal(),
        flowX: flow.signal(),
        evolve: evolve.signal(),
      }),
    );
    const trails = feedback(ctx, { input: field, amount: trail.signal(), zoom: zoom.signal() });
    return bloom(ctx, { input: trails, level: glow.signal(), intensity: kick.map((k) => 0.4 + k) });
  },
});
