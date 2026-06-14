import { defineScene, lagSignal, Signal, texNode } from "@loom/runtime";
import { vec4 } from "three/tsl";
import { pickPalette } from "../palettes";
import { lfo } from "../modules/control/lfo";
import { bloom } from "../modules/effects/bloom";
import { vignette } from "../modules/effects/vignette";
import { reactionDiffusion } from "../modules/sources/reactionDiffusion";

/**
 * A living Gray-Scott reaction-diffusion organism: coral grows, mitoses and
 * folds into labyrinths as a slow LFO drifts the kill rate between regimes,
 * the bass swells the feed (denser growth on the build), and every kick
 * sprays fresh reactant from orbiting points so new colonies bloom on the
 * beat. The reactant is ramped through the palette with an accent rim picked
 * out along the growth fronts, then bloomed and vignetted.
 */
export default defineScene({
  name: "coral-bloom",
  description: "A living reaction-diffusion organism: coral grows and mitoses, kicks spray new blooms, kill-rate drifts the regime.",
  tags: ["reaction-diffusion", "gray-scott", "organic", "generative", "audio-reactive", "showcase"],
  build(ctx) {
    const feed = ctx.float("grow.feed", { default: 0.0545, min: 0.02, max: 0.09, step: 0.001, description: "feed rate — colony density" });
    const feedSwell = ctx.float("grow.swell", { default: 0.006, min: 0, max: 0.02, step: 0.001, description: "bass push on the feed rate" });
    const kill = ctx.float("grow.kill", { default: 0.062, min: 0.045, max: 0.07, step: 0.001, description: "kill rate — pattern regime" });
    const drift = ctx.float("grow.drift", { default: 0.004, min: 0, max: 0.012, step: 0.001, description: "slow wander of the regime (coral↔mitosis)" });
    const evolve = ctx.int("grow.evolve", { default: 12, min: 4, max: 22, step: 1, description: "solver iterations per frame — evolution speed" });
    const chunk = ctx.float("grow.chunk", { default: 0.5, min: 0.3, max: 0.6, step: 0.01, description: "reactant diffusion — blob chunkiness" });
    const bloomScatter = ctx.float("bloom.spray", { default: 0.9, min: 0, max: 1.5, step: 0.05, description: "kick spray of fresh growth" });
    const spread = ctx.float("color.spread", { default: 2.4, min: 1, max: 4, step: 0.05, description: "palette spread across reactant density" });
    const rim = ctx.float("color.rim", { default: 0.7, min: 0, max: 1.6, step: 0.05, description: "accent glow along growth fronts" });
    const bloomLevel = ctx.float("finish.bloom", { default: 0.55, min: 0, max: 1, step: 0.01, description: "bloom threshold" });
    const bloomInt = ctx.float("finish.glow", { default: 0.7, min: 0, max: 2, step: 0.05, description: "bloom intensity" });
    const vig = ctx.float("finish.vignette", { default: 0.6, min: 0, max: 1, step: 0.01, description: "corner darkening" });

    // Palette is a CHOICE (palette.pick): the two global palettes — primary &
    // secondary, retinting live with the globals rack — plus scene presets.
    // Roles: 0 bg · 1 edge · 2/3 core · 4 accent.
    const pal = pickPalette(ctx, [
      { name: "Coral", stops: ["#04060d", "#0e3a52", "#1fb6a6", "#ff5d73", "#ffe08a"] },
      { name: "Ember", stops: ["#0a0306", "#3a0d12", "#a51d27", "#ff6f3c", "#ffd166"] },
      { name: "Abyss", stops: ["#01040a", "#04243b", "#0a6b6b", "#23c4c4", "#bdfff6"] },
      { name: "Acid", stops: ["#06000a", "#2a0a3a", "#7b2cbf", "#3df27e", "#f6ff6b"] },
    ]);

    const kick = ctx.input("kick");
    const bass = lagSignal(ctx.audio.band("bass"), 0.1);

    // Feed swells with the bass; kill slowly wanders the whole regime.
    const feedBase = feed.signal();
    const swellAmt = feedSwell.signal();
    const feedSig = new Signal((f) => feedBase.get(f) + bass.get(f) * swellAmt.get(f));

    const killBase = kill.signal();
    const driftAmt = drift.signal();
    const killLfo = lfo(ctx, { shape: "sine", periodBeats: 48 });
    const killSig = new Signal((f) => killBase.get(f) + (killLfo.get(f) - 0.5) * 2 * driftAmt.get(f));

    const scatterAmt = bloomScatter.signal();
    const injectSig = new Signal((f) => kick.get(f) * scatterAmt.get(f));

    const field = reactionDiffusion(ctx, {
      feed: feedSig,
      kill: killSig,
      diffuseB: chunk.signal(),
      iterations: evolve.signal(),
      inject: injectSig,
    });

    // Colorize: ramp the reactant density through the palette, add an accent rim
    // along the growth fronts (the module's edge channel).
    const spreadU = ctx.uniformOf(spread.signal());
    const rimU = ctx.uniformOf(rim.signal());
    const density = field.color.x.mul(spreadU).clamp(0, 1);
    const rgb = pal.ramp(density).rgb.add(pal.color(4).mul(field.color.y).mul(rimU));
    const src = texNode(vec4(rgb, 1), field.passes);

    const glow = bloom(ctx, { input: src, level: bloomLevel.signal(), intensity: bloomInt.signal() });
    return vignette(ctx, { input: glow, amount: vig.signal() });
  },
});
