import { defineScene, Signal, texNode } from "@loom/runtime";
import { mix, vec4 } from "three/tsl";
import { pickPalette } from "../palettes";
import { bloom } from "../modules/effects/bloom";
import { vignette } from "../modules/effects/vignette";
import { fluid2d } from "../modules/sources/fluid2d";

/**
 * Stam stable-fluids smoke: two orbiting jets billow coloured ink through a
 * genuine incompressible-flow simulation. The kick punches a force impulse +
 * a puff of dye so the smoke blooms on the beat, bass eases the dissipation
 * for longer, lazier plumes, and the whole field is ramped through the palette
 * with the flow speed picked out as a bright accent. Smoky, fluid, audio-driven.
 */
export default defineScene({
  name: "smoke-signals",
  description: "Stam stable-fluids smoke: orbiting ink jets billow on the kick, bass breathes the dissipation.",
  tags: ["fluid", "smoke", "ink", "stable-fluids", "simulation", "audio-reactive", "showcase"],
  build(ctx) {
    const dyeAmt = ctx.float("fluid.dye", { default: 0.85, min: 0, max: 1, step: 0.01, description: "dye sprayed per impulse" });
    const dissip = ctx.float("fluid.dissipation", { default: 0.993, min: 0.95, max: 1, step: 0.001, description: "velocity dissipation per step" });
    const fade = ctx.float("fluid.fade", { default: 0.982, min: 0.96, max: 1, step: 0.001, description: "dye fade per step" });
    const pIters = ctx.int("fluid.pressureIters", { default: 30, min: 16, max: 48, step: 1, description: "Jacobi pressure iterations" });
    const steps = ctx.int("fluid.steps", { default: 1, min: 1, max: 3, step: 1, description: "integration steps per frame" });
    const punch = ctx.float("kick.punch", { default: 0.9, min: 0, max: 2, step: 0.05, description: "kick force/dye impulse strength" });
    const breathe = ctx.float("bass.breathe", { default: 0.004, min: 0, max: 0.02, step: 0.001, description: "bass easing of dissipation (longer smoke)" });
    const accent = ctx.float("color.accent", { default: 0.25, min: 0, max: 2, step: 0.05, description: "flow-speed accent glow" });
    const bloomLevel = ctx.float("finish.bloom", { default: 0.6, min: 0, max: 1, step: 0.01, description: "bloom threshold" });
    const glowBase = ctx.float("finish.glow", { default: 0.3, min: 0, max: 2, step: 0.05, description: "base bloom intensity" });
    const vig = ctx.float("finish.vignette", { default: 0.45, min: 0, max: 1, step: 0.01, description: "corner darkening" });

    const pal = pickPalette(ctx, [
      { name: "Inkblue", stops: ["#02030a", "#0a2a55", "#1f7ab0", "#7fe0ff", "#ffe9b0"] },
      { name: "Ember", stops: ["#0a0202", "#3a0a12", "#b8341f", "#ff8a2b", "#ffe49a"] },
      { name: "Aurora", stops: ["#01060a", "#063b3a", "#1aa17a", "#8af0c0", "#f0fff0"] },
      { name: "Magma", stops: ["#03010a", "#3a0ca3", "#c1121f", "#ff7b00", "#ffe066"] },
    ]);

    const kick = ctx.input("kick");
    const bass = ctx.input("bass");

    // Kick drives the injection impulse; bass eases dissipation toward 1 (longer smoke).
    const punchS = punch.signal();
    const injectSig = new Signal((f) => kick.get(f) * punchS.get(f));
    const dissipS = dissip.signal();
    const breatheS = breathe.signal();
    const dissipSig = new Signal((f) => Math.min(1, dissipS.get(f) + bass.get(f) * breatheS.get(f)));

    const field = fluid2d(ctx, {
      inject: injectSig,
      dye: dyeAmt.signal(),
      dissipation: dissipSig,
      fade: fade.signal(),
      pressureIters: pIters.signal(),
      iterations: steps.signal(),
    });

    // Ramp dye density through the palette; a gamma curve keeps the smoke body in
    // the cooler mid stops and reserves the bright accent for the dense cores.
    const accentU = ctx.uniformOf(accent.signal());
    const t = field.color.x.mul(2.1).clamp(0, 1);
    const base = pal.ramp(t).rgb;
    const rgb = mix(base, pal.color(4), field.color.y.mul(accentU).clamp(0, 1));
    const src = texNode(vec4(rgb, 1), field.passes);

    const glowBaseS = glowBase.signal();
    const glowSig = new Signal((f) => glowBaseS.get(f) + kick.get(f) * 0.6);
    const glow = bloom(ctx, { input: src, level: bloomLevel.signal(), intensity: glowSig });
    return vignette(ctx, { input: glow, amount: vig.signal() });
  },
});
