import { defineScene, Signal } from "@loom/runtime";
import { bloom } from "../modules/effects/bloom";
import { vignette } from "../modules/effects/vignette";
import { orbitCam } from "../modules/geo/orbitCam";
import { pointCloudWave } from "../modules/geo/pointCloudWave";
import { strangeAttractor } from "../modules/geo/strangeAttractor";
import { render3d } from "../modules/sources/render3d";

const POINTS = 18000;

/**
 * The Aizawa strange attractor traced as 18k glowing points, turning slowly
 * under an orbiting camera so its filamentary shell reveals itself in depth.
 * Spherical ripples propagate outward through the cloud — the whole structure
 * breathes and pulses. The kick punches both the bloom and the wave amplitude
 * so the filaments flare and shudder on the beat.
 */
export default defineScene({
  name: "attractor-cloud",
  description: "A strange attractor (Aizawa) as a glowing point cloud with radial wave pulses; the kick flares the bloom and drives the wave.",
  tags: ["3d", "attractor", "chaos", "points", "wave", "generative", "audio-reactive", "showcase"],
  build(ctx) {
    const camSpeed = ctx.float("cam.speed", { default: 0.25, min: -1, max: 1, step: 0.01, description: "orbit speed" });
    const camRadius = ctx.float("cam.radius", { default: 2.6, min: 1.2, max: 5, step: 0.05, description: "orbit radius" });
    const camHeight = ctx.float("cam.height", { default: 0.6, min: -2, max: 2, step: 0.05, description: "camera height" });
    const spin = ctx.float("cloud.spin", { default: 0.15, min: -1.5, max: 1.5, step: 0.01, description: "attractor self-spin" });
    const size = ctx.float("cloud.size", { default: 0.01, min: 0.003, max: 0.03, step: 0.001, description: "point size" });

    const waveAmp = ctx.float("wave.amplitude", { default: 0.12, min: 0, max: 0.5, step: 0.005, description: "radial wave displacement" });
    const waveSpeed = ctx.float("wave.speed", { default: 0.8, min: 0, max: 4, step: 0.05, description: "wave propagation speed" });
    const waveFreq = ctx.float("wave.freq", { default: 2.5, min: 0.5, max: 8, step: 0.1, description: "wave cycles per world unit" });
    const waveKick = ctx.float("wave.kick", { default: 0.3, min: 0, max: 1, step: 0.01, description: "kick punch on wave amplitude" });

    const bloomLevel = ctx.float("finish.bloom", { default: 0.3, min: 0, max: 1, step: 0.01, description: "bloom threshold" });
    const glowBase = ctx.float("finish.glow", { default: 0.7, min: 0, max: 2, step: 0.05, description: "base bloom intensity" });
    const punch = ctx.float("glow.punch", { default: 0.8, min: 0, max: 2, step: 0.05, description: "kick punch on the bloom" });
    const vig = ctx.float("finish.vignette", { default: 0.5, min: 0, max: 1, step: 0.01, description: "corner darkening" });

    const kick = ctx.input("kick");

    const waveAmpS = waveAmp.signal();
    const waveKickS = waveKick.signal();
    const waveAmpSig = new Signal((f) => waveAmpS.get(f) + kick.get(f) * waveKickS.get(f));

    const attractor = strangeAttractor(ctx, { kind: "aizawa", points: POINTS, spin: spin.signal() });
    const points = pointCloudWave(ctx, {
      source: attractor,
      size: size.signal(),
      color: "#7fd0ff",
      maxPoints: POINTS,
      waveAmplitude: waveAmpSig,
      waveSpeed: waveSpeed.signal(),
      waveFreq: waveFreq.signal(),
    });
    const world = render3d(ctx, {
      world: [points],
      cam: orbitCam(ctx, { radius: camRadius.signal(), height: camHeight.signal(), speed: camSpeed.signal() }),
    });

    const glowBaseS = glowBase.signal();
    const punchS = punch.signal();
    const glowSig = new Signal((f) => glowBaseS.get(f) + kick.get(f) * punchS.get(f));

    const glow = bloom(ctx, { input: world, level: bloomLevel.signal(), intensity: glowSig });
    return vignette(ctx, { input: glow, amount: vig.signal() });
  },
});
