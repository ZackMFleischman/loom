import { defineScene, Signal, texNode } from "@loom/runtime";
import { vec4 } from "three/tsl";
import { pickPalette } from "../palettes";
import { bloom } from "../modules/effects/bloom";
import { vignette } from "../modules/effects/vignette";
import { waveField } from "../modules/sources/waveField";

/**
 * A still pool seen from above, rippled by a real 2D wave simulation: every
 * kick drops a splash from orbiting points and the wavefronts ring out, cross
 * and interfere. Height is ramped through the palette (deep → surface) with a
 * foam highlight picked out along the steep crests, then bloomed and vignetted.
 */
export default defineScene({
  name: "ripple-pool",
  description: "A wave-simulation pool: kicks drop splashes whose wavefronts ring out and interfere, ramped through the palette.",
  tags: ["wave", "ripples", "water", "simulation", "audio-reactive", "showcase"],
  build(ctx) {
    const speed = ctx.float("wave.speed", { default: 0.32, min: 0.05, max: 0.49, step: 0.01, description: "wave travel speed (CFL-stable)" });
    const damping = ctx.float("wave.calm", { default: 0.996, min: 0.985, max: 0.999, step: 0.001, description: "how fast the pool settles" });
    const splash = ctx.float("wave.splash", { default: 0.85, min: 0, max: 1.5, step: 0.05, description: "kick splash strength" });
    const flow = ctx.int("wave.flow", { default: 2, min: 1, max: 6, step: 1, description: "solver iterations/frame — propagation speed" });
    const depth = ctx.float("color.depth", { default: 1.1, min: 0.6, max: 1.8, step: 0.05, description: "height contrast into the palette" });
    const foam = ctx.float("color.foam", { default: 0.95, min: 0, max: 2, step: 0.05, description: "foam highlight along the crests" });
    const bloomLevel = ctx.float("finish.bloom", { default: 0.45, min: 0, max: 1, step: 0.01, description: "bloom threshold" });
    const bloomInt = ctx.float("finish.glow", { default: 0.55, min: 0, max: 2, step: 0.05, description: "bloom intensity" });
    const vig = ctx.float("finish.vignette", { default: 0.55, min: 0, max: 1, step: 0.01, description: "corner darkening" });

    // Palette is a CHOICE: the two global palettes (live) + pool presets.
    // Roles: 0 deep · 1 mid · 2/3 surface · 4 foam/highlight.
    const pal = pickPalette(ctx, [
      { name: "Pool", stops: ["#020912", "#063a52", "#0e8ca6", "#5fd6e0", "#eafcff"] },
      { name: "Sunset", stops: ["#0a0410", "#3a0d3a", "#9b2d6b", "#ff6f61", "#ffd98a"] },
      { name: "Ink", stops: ["#000000", "#10131a", "#2a3340", "#6b7a8f", "#dfe8f0"] },
      { name: "Acid", stops: ["#04000a", "#1a0a3a", "#5b2cbf", "#2ee6a0", "#eaff6b"] },
    ]);

    const kick = ctx.input("kick");
    const splashAmt = splash.signal();
    const impactSig = new Signal((f) => kick.get(f) * splashAmt.get(f));

    const field = waveField(ctx, {
      speed: speed.signal(),
      damping: damping.signal(),
      impact: impactSig,
      iterations: flow.signal(),
    });

    const depthU = ctx.uniformOf(depth.signal());
    const foamU = ctx.uniformOf(foam.signal());
    const height = field.color.x.sub(0.5).mul(depthU).add(0.5).clamp(0, 1);
    const rgb = pal.ramp(height).rgb.add(pal.color(4).mul(field.color.y).mul(foamU));
    const src = texNode(vec4(rgb, 1), field.passes);

    const glow = bloom(ctx, { input: src, level: bloomLevel.signal(), intensity: bloomInt.signal() });
    return vignette(ctx, { input: glow, amount: vig.signal() });
  },
});
