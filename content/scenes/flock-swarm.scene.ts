import { defineScene, lagSignal, Signal } from "@loom/runtime";
import { bloom } from "../modules/effects/bloom";
import { vignette } from "../modules/effects/vignette";
import { flock } from "../modules/geo/flock";
import { orbitCam } from "../modules/geo/orbitCam";
import { render3d } from "../modules/sources/render3d";

/**
 * A flock of 240 boids wheeling under an orbiting camera — separation,
 * alignment and cohesion steering, each boid a glowing cone pointed along its
 * heading. The bass pulls the cohesion up so the swarm gathers tight on the
 * build, and the kick punches the bloom. Classic emergent murmuration.
 */
export default defineScene({
  name: "flock-swarm",
  description: "A boids murmuration wheeling in 3D — bass gathers the flock, the kick flares the glow.",
  tags: ["3d", "boids", "flocking", "agents", "audio-reactive", "showcase"],
  build(ctx) {
    const camSpeed = ctx.float("cam.speed", { default: 0.18, min: -1, max: 1, step: 0.01, description: "orbit speed" });
    const camRadius = ctx.float("cam.radius", { default: 3.4, min: 1.5, max: 6, step: 0.05, description: "orbit radius" });
    const camHeight = ctx.float("cam.height", { default: 0.7, min: -2, max: 2, step: 0.05, description: "camera height" });
    const speed = ctx.float("flight.speed", { default: 1.1, min: 0.2, max: 3, step: 0.05, description: "flight speed" });
    const cohesion = ctx.float("flock.cohesion", { default: 0.9, min: 0, max: 3, step: 0.05, description: "pull to the group centre" });
    const gather = ctx.float("flock.gather", { default: 1.0, min: 0, max: 3, step: 0.05, description: "bass push on cohesion" });
    const separation = ctx.float("flock.separation", { default: 1.5, min: 0, max: 4, step: 0.05, description: "push off close neighbours" });
    const alignment = ctx.float("flock.alignment", { default: 1.0, min: 0, max: 3, step: 0.05, description: "match neighbours' heading" });
    const size = ctx.float("boid.size", { default: 0.06, min: 0.02, max: 0.16, step: 0.005, description: "boid size" });
    const bloomLevel = ctx.float("finish.bloom", { default: 0.35, min: 0, max: 1, step: 0.01, description: "bloom threshold" });
    const glowBase = ctx.float("finish.glow", { default: 0.6, min: 0, max: 2, step: 0.05, description: "base bloom intensity" });
    const punch = ctx.float("glow.punch", { default: 0.9, min: 0, max: 2, step: 0.05, description: "kick punch on the bloom" });
    const vig = ctx.float("finish.vignette", { default: 0.5, min: 0, max: 1, step: 0.01, description: "corner darkening" });

    const bass = lagSignal(ctx.audio.band("bass"), 0.12);
    const cohBase = cohesion.signal();
    const gatherAmt = gather.signal();
    const cohSig = new Signal((f) => cohBase.get(f) + bass.get(f) * gatherAmt.get(f));

    const swarm = flock(ctx, {
      count: 240,
      speed: speed.signal(),
      separation: separation.signal(),
      alignment: alignment.signal(),
      cohesion: cohSig,
      size: size.signal(),
      color: "#ffd166",
    });
    const world = render3d(ctx, {
      world: [swarm],
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
