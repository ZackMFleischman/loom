import { defineScene, Signal } from "@loom/runtime";
import { lfo } from "../modules/control/lfo";
import { bloom } from "../modules/effects/bloom";
import { vignette } from "../modules/effects/vignette";
import { lsystem } from "../modules/geo/lsystem";
import { orbitCam } from "../modules/geo/orbitCam";
import { render3d } from "../modules/sources/render3d";

/**
 * An L-system botanical unfurling under an orbit: an axiom is rewritten into a
 * fractal plant and a turtle draws it as glowing ribbon strokes, the path
 * revealed as a growing fraction so the plant GROWS on screen, looping. A slow
 * LFO breathes the branch angle so the form sways, the bass nudges the angle
 * wider (the plant opens on the build) and the kick flares the bloom. Swap the
 * `preset` param for koch / dragon / sierpinski / bush. Deterministic — same
 * seed, same garden.
 */
export default defineScene({
  name: "grammar-garden",
  description: "An L-system plant unfurling as glowing ribbon strokes; the angle breathes and opens on the bass, the kick flares the glow.",
  tags: ["3d", "lsystem", "l-system", "fractal", "plant", "generative", "audio-reactive", "showcase"],
  build(ctx) {
    const presetIdx = ctx.int("plant.preset", {
      default: 0, min: 0, max: 4, step: 1,
      labels: ["plant", "bush", "koch", "dragon", "sierpinski"],
      description: "which grammar to grow (rebuilds)",
    });
    const iterations = ctx.int("plant.iterations", { default: 5, min: 1, max: 11, step: 1, description: "rewrite generations — clamps to each preset's ceiling (plant 5 / koch·bush 4 / sierpinski 5 / dragon 11); rebuilds" });
    const angle = ctx.float("plant.angle", { default: 25, min: 5, max: 120, step: 0.5, description: "branch turn angle (deg)" });
    const sway = ctx.float("plant.sway", { default: 6, min: 0, max: 30, step: 0.5, description: "angle breathing amplitude (deg)" });
    const open = ctx.float("plant.open", { default: 10, min: 0, max: 40, step: 0.5, description: "bass widening of the angle (deg)" });
    const unfurlBeats = ctx.float("plant.unfurlBeats", { default: 20, min: 4, max: 128, step: 1, description: "beats for one full unfurl loop" });
    const camSpeed = ctx.float("cam.speed", { default: 0.1, min: -1, max: 1, step: 0.01, description: "orbit speed" });
    const camRadius = ctx.float("cam.radius", { default: 1.6, min: 1, max: 5, step: 0.05, description: "orbit radius" });
    const camHeight = ctx.float("cam.height", { default: 0.05, min: -2, max: 2, step: 0.05, description: "camera height" });
    const width = ctx.float("stroke.width", { default: 0.006, min: 0.002, max: 0.02, step: 0.001, description: "stroke half-thickness" });
    const bloomLevel = ctx.float("finish.bloom", { default: 0.3, min: 0, max: 1, step: 0.01, description: "bloom threshold" });
    const glowBase = ctx.float("finish.glow", { default: 0.8, min: 0, max: 2, step: 0.05, description: "base bloom intensity" });
    const punch = ctx.float("glow.punch", { default: 0.9, min: 0, max: 2, step: 0.05, description: "kick punch on the bloom" });
    const vig = ctx.float("finish.vignette", { default: 0.55, min: 0, max: 1, step: 0.01, description: "corner darkening" });

    const presets = ["plant", "bush", "koch", "dragon", "sierpinski"] as const;
    const preset = presets[presetIdx.value] ?? "plant";

    const kick = ctx.input("kick");
    const bass = ctx.input("bass");

    // Angle = base + breathing LFO + bass opening.
    const angleBase = angle.signal();
    const swayAmt = sway.signal();
    const openAmt = open.signal();
    const angleLfo = lfo(ctx, { shape: "sine", periodBeats: 24 });
    const angleSig = new Signal((f) => angleBase.get(f) + (angleLfo.get(f) - 0.5) * 2 * swayAmt.get(f) + bass.get(f) * openAmt.get(f));

    // Unfurl: a saw 0→1 over `unfurlBeats`, so the plant draws itself, then loops.
    const beats = ctx.time.beats;
    const unfurlSig = new Signal((f) => {
      const period = Math.max(1, unfurlBeats.value);
      return (beats.get(f) / period) % 1;
    });

    const plant = lsystem(ctx, {
      preset,
      iterations: iterations.value,
      angle: angleSig,
      reveal: unfurlSig,
      width: width.signal(),
      color: "#86f7a0",
      glow: 1.5,
    });

    const world = render3d(ctx, {
      world: [plant],
      cam: orbitCam(ctx, { radius: camRadius.signal(), height: camHeight.signal(), speed: camSpeed.signal() }),
    });

    const glowBaseS = glowBase.signal();
    const punchS = punch.signal();
    const glowSig = new Signal((f) => glowBaseS.get(f) + kick.get(f) * punchS.get(f));
    const glow = bloom(ctx, { input: world, level: bloomLevel.signal(), intensity: glowSig });
    return vignette(ctx, { input: glow, amount: vig.signal() });
  },
});
