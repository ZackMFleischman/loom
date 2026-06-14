import { defineScene, Signal, texNode } from "@loom/runtime";
import { vec4 } from "three/tsl";
import { pickPalette } from "../palettes";
import { bloom } from "../modules/effects/bloom";
import { vignette } from "../modules/effects/vignette";
import { silk } from "../modules/sources/silk";

/**
 * A million-point silk: a true GPU particle pool rides the curl of fbm-noise
 * (divergence-free → never-clumping streams) and is splatted additively into a
 * float buffer, then tone-mapped into glowing smoke-of-points. The bass surges
 * the flow force so the whole cloth billows; the kick breathes the curl scale so
 * the filigree tightens and opens on the beat and flashes the accent. Switch the
 * field to a de Jong strange attractor for folded filigree sheets. The density is
 * ramped through the palette, then bloomed + vignetted.
 */
export default defineScene({
  name: "silk-flow",
  description: "A million GPU particles ride curl-noise / a strange attractor, drawn additively → glowing silk — bass billows, kick breathes.",
  tags: ["particles", "silk", "flow", "curl", "attractor", "additive", "organic", "audio-reactive", "showcase", "gpu"],
  build(ctx) {
    const count = ctx.int("silk.particles", { default: 250000, min: 4096, max: 1000000, step: 4096, description: "particle count (rebuild)" });
    const fieldI = ctx.int("silk.field", { default: 0, min: 0, max: 1, step: 1, labels: ["curl", "attractor"], description: "force field (rebuild)" });
    const force = ctx.float("flow.force", { default: 1.1, min: 0.1, max: 3, step: 0.02, description: "advection strength per frame" });
    const surge = ctx.float("flow.surge", { default: 0.9, min: 0, max: 2.5, step: 0.05, description: "bass push on the flow force" });
    const scale = ctx.float("field.scale", { default: 2.2, min: 0.5, max: 6, step: 0.05, description: "curl/attractor spatial frequency" });
    const breathe = ctx.float("field.breathe", { default: 1.1, min: 0, max: 4, step: 0.05, description: "kick breathes the field scale" });
    const evolve = ctx.float("field.evolve", { default: 0.08, min: 0, max: 0.4, step: 0.005, description: "slow self-drift of the field" });
    const churn = ctx.float("flow.churn", { default: 0.02, min: 0, max: 0.08, step: 0.001, description: "fraction respawned per frame" });
    const persist = ctx.float("silk.trails", { default: 0.84, min: 0, max: 0.97, step: 0.01, description: "density carried frame-to-frame (trails)" });
    const exposure = ctx.float("silk.exposure", { default: 1.4, min: 0.3, max: 6, step: 0.05, description: "tone-map brightness of the silk" });
    const splat = ctx.float("silk.glow", { default: 0.14, min: 0.02, max: 0.4, step: 0.005, description: "per-splat brightness" });
    const size = ctx.int("silk.dot", { default: 1, min: 1, max: 3, step: 1, description: "point sprite size px (rebuild)" });
    const spread = ctx.float("color.spread", { default: 1.6, min: 0.5, max: 6, step: 0.05, description: "palette spread across density" });
    const accent = ctx.float("color.accent", { default: 0.5, min: 0, max: 1, step: 0.01, description: "kick flash of the accent stop" });
    const bloomLevel = ctx.float("finish.bloom", { default: 0.4, min: 0, max: 1, step: 0.01, description: "bloom threshold" });
    const bloomInt = ctx.float("finish.glow", { default: 0.75, min: 0, max: 2, step: 0.05, description: "bloom intensity" });
    const vig = ctx.float("finish.vignette", { default: 0.5, min: 0, max: 1, step: 0.01, description: "corner darkening" });

    // Palette CHOICE: both global palettes (retint live) + scene presets.
    // Roles: 0 bg · 1 edge · 2/3 core · 4 accent.
    const pal = pickPalette(ctx, [
      { name: "Silk", stops: ["#02030a", "#10204a", "#3c8cff", "#a06bff", "#ffd9a0"] },
      { name: "Smoke", stops: ["#050505", "#1a1a22", "#7a7f8c", "#cfd6e0", "#ffffff"] },
      { name: "Ember", stops: ["#0a0202", "#3a0d08", "#c2461e", "#ff9b3c", "#fff0c0"] },
      { name: "Aurora", stops: ["#01060a", "#063a3a", "#16c2a0", "#5bff9e", "#e6fff0"] },
    ]);

    const kick = ctx.input("kick");
    const bass = ctx.input("bass");

    // Bass surges the flow force; kick breathes the curl/attractor scale.
    const forceBase = force.signal();
    const surgeAmt = surge.signal();
    const forceSig = new Signal((f) => forceBase.get(f) * (1 + bass.get(f) * surgeAmt.get(f)));

    const scaleBase = scale.signal();
    const breatheAmt = breathe.signal();
    const scaleSig = new Signal((f) => scaleBase.get(f) + kick.get(f) * breatheAmt.get(f) * 0.3);

    const field = silk(ctx, {
      count: count.value,
      field: fieldI.value === 1 ? "attractor" : "curl",
      force: forceSig,
      curlScale: scaleSig,
      evolve: evolve.signal(),
      churn: churn.signal(),
      persistence: persist.signal(),
      exposure: exposure.signal(),
      glow: splat.signal(),
      size: size.value,
    });

    // Colorize: ramp the silk density through the palette; flash the accent on kicks.
    const spreadU = ctx.uniformOf(spread.signal());
    const kickU = ctx.uniformOf(kick);
    const accentU = ctx.uniformOf(accent.signal());
    const density = field.color.x.mul(spreadU).clamp(0, 1);
    const rgb = pal.ramp(density).rgb.add(pal.color(4).mul(density).mul(kickU).mul(accentU));
    const src = ctx.layer("silk", texNode(vec4(rgb, 1), field.passes));

    const glow = bloom(ctx, { input: src, level: bloomLevel.signal(), intensity: bloomInt.signal() });
    return vignette(ctx, { input: glow, amount: vig.signal() });
  },
});
