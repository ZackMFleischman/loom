import { defineScene, lagSignal, Signal, texNode } from "@loom/runtime";
import { vec4 } from "three/tsl";
import { pickPalette } from "../palettes";
import { bloom } from "../modules/effects/bloom";
import { vignette } from "../modules/effects/vignette";
import { marble } from "../modules/sources/marble";

/**
 * A slab of living marble: fractal noise folded through itself into agate
 * veins, drifting slowly. The bass breathes the warp so the veins churn on the
 * build, and a faint bloom lifts the brightest seams. Pure procedural texture —
 * no simulation state, just iterated domain warping coloured by the palette.
 */
export default defineScene({
  name: "marble-slab",
  description: "Iterated domain-warp marble — agate veins folding and drifting, bass churns the warp.",
  tags: ["marble", "domain-warp", "noise", "organic", "palette", "audio-reactive"],
  build(ctx) {
    const scale = ctx.float("marble.scale", { default: 3, min: 0.5, max: 8, step: 0.1, description: "vein fineness" });
    const warp = ctx.float("marble.warp", { default: 4, min: 0, max: 8, step: 0.1, description: "domain-warp strength (the folding)" });
    const swell = ctx.float("marble.swell", { default: 1.2, min: 0, max: 4, step: 0.1, description: "bass push on the warp" });
    const evolve = ctx.float("marble.drift", { default: 0.08, min: 0, max: 0.5, step: 0.01, description: "drift speed" });
    const contrast = ctx.float("color.contrast", { default: 1.2, min: 0.6, max: 2, step: 0.05, description: "contrast into the palette" });
    const bloomLevel = ctx.float("finish.bloom", { default: 0.6, min: 0, max: 1, step: 0.01, description: "bloom threshold" });
    const bloomInt = ctx.float("finish.glow", { default: 0.4, min: 0, max: 2, step: 0.05, description: "bloom intensity" });
    const vig = ctx.float("finish.vignette", { default: 0.45, min: 0, max: 1, step: 0.01, description: "corner darkening" });

    // Palette is a CHOICE: both global palettes (live) + marble presets.
    const pal = pickPalette(ctx, [
      { name: "Carrara", stops: ["#0d1014", "#3a4048", "#8a93a0", "#d7dde6", "#ffffff"] },
      { name: "Agate", stops: ["#0a0410", "#3a1c5a", "#9b5de5", "#f15bb5", "#ffd6e8"] },
      { name: "Malachite", stops: ["#02110c", "#0a3a2a", "#1f9e6f", "#7fe0a8", "#eafff4"] },
      { name: "Ember", stops: ["#0a0306", "#3a0d12", "#a51d27", "#ff7b00", "#ffd166"] },
    ]);

    const bass = lagSignal(ctx.audio.band("bass"), 0.12);
    const warpBase = warp.signal();
    const swellAmt = swell.signal();
    const warpSig = new Signal((f) => warpBase.get(f) + bass.get(f) * swellAmt.get(f));

    const field = marble(ctx, {
      scale: scale.signal(),
      warp: warpSig,
      evolve: evolve.signal(),
      contrast: contrast.signal(),
    });

    // marble is grayscale — ramp its fold value through the chosen palette.
    const rgb = pal.ramp(field.color.r).rgb;
    const src = texNode(vec4(rgb, 1), field.passes);

    const glow = bloom(ctx, { input: src, level: bloomLevel.signal(), intensity: bloomInt.signal() });
    return vignette(ctx, { input: glow, amount: vig.signal() });
  },
});
