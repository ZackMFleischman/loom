import { defineScene, lagSignal, Signal } from "@loom/runtime";
import { bloom } from "../modules/effects/bloom";
import { vignette } from "../modules/effects/vignette";
import { flowParticles } from "../modules/geo/flowParticles";
import { orbitCam } from "../modules/geo/orbitCam";
import { render3d } from "../modules/sources/render3d";

const COUNT = 4000;

/**
 * 4000 glowing particles streaming along a divergence-free ABC flow field —
 * silky, never-clumping vortex lines turning under an orbiting camera. The
 * bass drives the flow speed so the streams surge on the build, and the kick
 * flares the bloom.
 */
export default defineScene({
  name: "flow-field",
  description: "Particles riding a divergence-free flow field into silky vortex streams; bass surges the flow.",
  tags: ["3d", "particles", "flow", "curl", "advection", "audio-reactive", "showcase"],
  build(ctx) {
    const camSpeed = ctx.float("cam.speed", { default: 0.16, min: -1, max: 1, step: 0.01, description: "orbit speed" });
    const camRadius = ctx.float("cam.radius", { default: 3.2, min: 1.5, max: 6, step: 0.05, description: "orbit radius" });
    const camHeight = ctx.float("cam.height", { default: 0.5, min: -2, max: 2, step: 0.05, description: "camera height" });
    const speed = ctx.float("flow.speed", { default: 1, min: 0.1, max: 3, step: 0.05, description: "base flow speed" });
    const surge = ctx.float("flow.surge", { default: 1.1, min: 0, max: 3, step: 0.05, description: "bass push on flow speed" });
    const scale = ctx.float("flow.scale", { default: 1.6, min: 0.4, max: 4, step: 0.05, description: "field scale (vortex tightness)" });
    const evolve = ctx.float("flow.evolve", { default: 0.15, min: 0, max: 1, step: 0.01, description: "field drift speed" });
    const size = ctx.float("particle.size", { default: 0.012, min: 0.004, max: 0.03, step: 0.001, description: "particle size" });
    const bloomLevel = ctx.float("finish.bloom", { default: 0.3, min: 0, max: 1, step: 0.01, description: "bloom threshold" });
    const glowBase = ctx.float("finish.glow", { default: 0.7, min: 0, max: 2, step: 0.05, description: "base bloom intensity" });
    const punch = ctx.float("glow.punch", { default: 0.8, min: 0, max: 2, step: 0.05, description: "kick punch on the bloom" });
    const vig = ctx.float("finish.vignette", { default: 0.5, min: 0, max: 1, step: 0.01, description: "corner darkening" });

    const bass = lagSignal(ctx.audio.band("bass"), 0.12);
    const speedBase = speed.signal();
    const surgeAmt = surge.signal();
    const speedSig = new Signal((f) => speedBase.get(f) + bass.get(f) * surgeAmt.get(f));

    const stream = flowParticles(ctx, {
      count: COUNT,
      speed: speedSig,
      scale: scale.signal(),
      evolve: evolve.signal(),
      size: size.signal(),
      color: "#7fd0ff",
    });
    const world = render3d(ctx, {
      world: [stream],
      cam: orbitCam(ctx, { radius: camRadius.signal(), height: camHeight.signal(), speed: camSpeed.signal() }),
    });

    const kick = ctx.input("kick");
    const glowBaseS = glowBase.signal();
    const punchS = punch.signal();
    const glowSig = new Signal((f) => glowBaseS.get(f) + kick.get(f) * punchS.get(f));

    const glow = bloom(ctx, { input: world, level: bloomLevel.signal(), intensity: glowSig });
    return vignette(ctx, { input: glow, amount: vig.signal() });
  },
});
