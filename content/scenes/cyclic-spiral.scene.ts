import { defineScene, Signal, texNode } from "@loom/runtime";
import { vec4 } from "three/tsl";
import { pickPalette } from "../palettes";
import { bloom } from "../modules/effects/bloom";
import { vignette } from "../modules/effects/vignette";
import { automata } from "../modules/sources/automata";

/**
 * A cyclic cellular automaton left to self-organise into endlessly rotating
 * spiral waves: each cell cycles through the palette as it advances, the
 * moving fronts are picked out as bright accents, and the kick punches the
 * bloom so the spirals flare on the beat. An always-alive generative
 * palette-cleanser.
 */
export default defineScene({
  name: "cyclic-spiral",
  description: "A cyclic cellular automaton spiraling forever through the palette; the kick flares the bloom.",
  tags: ["cellular-automata", "cyclic", "spirals", "generative", "audio-reactive", "showcase"],
  build(ctx) {
    const states = ctx.int("ca.states", { default: 14, min: 4, max: 24, step: 1, description: "colour-wheel states — finer/slower cycling" });
    const threshold = ctx.int("ca.threshold", { default: 1, min: 1, max: 4, step: 1, description: "neighbours needed to advance (1 = spirals)" });
    const speed = ctx.int("ca.speed", { default: 1, min: 1, max: 3, step: 1, description: "steps per frame — march speed" });
    const front = ctx.float("color.front", { default: 0.8, min: 0, max: 2, step: 0.05, description: "accent glow along the advancing fronts" });
    const bloomLevel = ctx.float("finish.bloom", { default: 0.45, min: 0, max: 1, step: 0.01, description: "bloom threshold" });
    const glowBase = ctx.float("finish.glow", { default: 0.6, min: 0, max: 2, step: 0.05, description: "base bloom intensity" });
    const punch = ctx.float("glow.punch", { default: 0.9, min: 0, max: 2, step: 0.05, description: "kick punch on the bloom" });
    const vig = ctx.float("finish.vignette", { default: 0.5, min: 0, max: 1, step: 0.01, description: "corner darkening" });

    // Palette is a CHOICE: the two global palettes (live) + spectrum presets.
    const pal = pickPalette(ctx, [
      { name: "Spectrum", stops: ["#1b0030", "#0040ff", "#00e0a0", "#ffd000", "#ff2e63"] },
      { name: "Magma", stops: ["#03010a", "#3a0ca3", "#c1121f", "#ff7b00", "#ffe066"] },
      { name: "Ocean", stops: ["#01121f", "#053b50", "#0e8ca6", "#5fd6e0", "#eafcff"] },
      { name: "Mono", stops: ["#000000", "#33363d", "#6b7280", "#aeb6c2", "#ffffff"] },
    ]);

    const field = automata(ctx, {
      states: states.signal(),
      threshold: threshold.signal(),
      iterations: speed.signal(),
    });

    const frontU = ctx.uniformOf(front.signal());
    const rgb = pal.ramp(field.color.x).rgb.add(pal.color(4).mul(field.color.y).mul(frontU));
    const src = texNode(vec4(rgb, 1), field.passes);

    // Kick punches the bloom intensity.
    const kick = ctx.input("kick");
    const glowBaseS = glowBase.signal();
    const punchS = punch.signal();
    const glowSig = new Signal((f) => glowBaseS.get(f) + kick.get(f) * punchS.get(f));

    const glow = bloom(ctx, { input: src, level: bloomLevel.signal(), intensity: glowSig });
    return vignette(ctx, { input: glow, amount: vig.signal() });
  },
});
