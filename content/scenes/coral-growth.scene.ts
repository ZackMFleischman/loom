import { defineScene, lagSignal, Signal } from "@loom/runtime";
import { bloom } from "../modules/effects/bloom";
import { vignette } from "../modules/effects/vignette";
import { differentialGrowth } from "../modules/geo/differentialGrowth";
import { orbitCam } from "../modules/geo/orbitCam";
import { render3d } from "../modules/sources/render3d";

/**
 * Differential growth as living coral: a seed ring's nodes repel locally,
 * spring toward the chain and split where edges stretch, so the line lengthens
 * and crumples into a space-filling brain-coral meander under a slow orbit. The
 * bass swells the repulsion (fuller, crumplier folds on the build) and the kick
 * spurts fresh node-splitting so the coral surges on the beat — then the whole
 * stroke flares through the bloom. Seeded + frame-clocked: it resets and regrows
 * identically on rebuild.
 */
export default defineScene({
  name: "coral-growth",
  description: "Differential-growth coral: a line repels, attracts and splits into organic meanders; bass swells the folds, kicks spurt growth.",
  tags: ["3d", "growth", "differential-growth", "coral", "organic", "generative", "audio-reactive", "showcase"],
  build(ctx) {
    const camSpeed = ctx.float("cam.speed", { default: 0.12, min: -1, max: 1, step: 0.01, description: "orbit speed" });
    const camRadius = ctx.float("cam.radius", { default: 2.0, min: 0.8, max: 4, step: 0.05, description: "orbit radius" });
    const camHeight = ctx.float("cam.height", { default: 0.15, min: -2, max: 2, step: 0.05, description: "camera height" });
    const repel = ctx.float("grow.repel", { default: 0.9, min: 0, max: 3, step: 0.05, description: "local repulsion strength" });
    const swell = ctx.float("grow.swell", { default: 0.7, min: 0, max: 2, step: 0.05, description: "bass push on repulsion" });
    const radius = ctx.float("grow.radius", { default: 0.13, min: 0.03, max: 0.25, step: 0.005, description: "repulsion radius" });
    const attract = ctx.float("grow.attract", { default: 0.5, min: 0, max: 1.5, step: 0.05, description: "chain spring strength" });
    const splitLen = ctx.float("grow.splitLen", { default: 0.07, min: 0.02, max: 0.14, step: 0.005, description: "edge length before a node splits" });
    const spurt = ctx.float("grow.spurt", { default: 0.8, min: 0, max: 3, step: 0.05, description: "kick spurt on the split rate" });
    const width = ctx.float("stroke.width", { default: 0.009, min: 0.003, max: 0.03, step: 0.001, description: "stroke half-thickness" });
    const bloomLevel = ctx.float("finish.bloom", { default: 0.3, min: 0, max: 1, step: 0.01, description: "bloom threshold" });
    const glowBase = ctx.float("finish.glow", { default: 0.8, min: 0, max: 2, step: 0.05, description: "base bloom intensity" });
    const punch = ctx.float("glow.punch", { default: 0.9, min: 0, max: 2, step: 0.05, description: "kick punch on the bloom" });
    const vig = ctx.float("finish.vignette", { default: 0.55, min: 0, max: 1, step: 0.01, description: "corner darkening" });

    const kick = ctx.input("kick");
    const bass = lagSignal(ctx.audio.band("bass"), 0.12);

    // Repulsion swells with the bass; split rate spurts on the kick.
    const repelBase = repel.signal();
    const swellAmt = swell.signal();
    const repelSig = new Signal((f) => repelBase.get(f) + bass.get(f) * swellAmt.get(f));
    const spurtAmt = spurt.signal();
    const growthSig = new Signal((f) => 0.18 + kick.get(f) * spurtAmt.get(f));

    const coral = differentialGrowth(ctx, {
      startNodes: 28,
      maxNodes: 1600, // compile-time node cap (perf guard)
      repel: repelSig,
      repelRadius: radius.signal(),
      attract: attract.signal(),
      splitLength: splitLen.signal(),
      growth: growthSig,
      width: width.signal(),
      color: "#ff5d9e",
      glow: 1.5,
      seed: 0xc02a1,
    });

    const world = render3d(ctx, {
      world: [coral],
      cam: orbitCam(ctx, { radius: camRadius.signal(), height: camHeight.signal(), speed: camSpeed.signal() }),
    });

    const glowBaseS = glowBase.signal();
    const punchS = punch.signal();
    const glowSig = new Signal((f) => glowBaseS.get(f) + kick.get(f) * punchS.get(f));
    const glow = bloom(ctx, { input: world, level: bloomLevel.signal(), intensity: glowSig });
    return vignette(ctx, { input: glow, amount: vig.signal() });
  },
});
