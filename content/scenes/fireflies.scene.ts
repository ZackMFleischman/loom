import { Signal, defineScene } from "@loom/runtime";
import { lfo } from "../modules/control/lfo";
import { feedback } from "../modules/effects/feedback";
import { glitch } from "../modules/effects/glitch";
import { levels } from "../modules/effects/levels";
import { fireflies } from "../modules/sources/fireflies";

/**
 * A night swarm: multicolored fireflies wander and twinkle, leaving faint
 * afterglow streaks; the whole swarm flares on the kick and breathes with
 * overall energy. Palette center drifts slowly over 64 beats.
 */
export default defineScene({
  name: "fireflies",
  description: "Drifting multicolored fireflies that twinkle at their own rates and flare on the kick.",
  tags: ["particles", "sparkle", "audio-reactive", "ambient"],
  build(ctx) {
    // Dotted paths form collapsible Console groups: swarm / blink / fx.
    // glow + flare stay flat — the two knobs you ride live.
    const glow = ctx.float("glow", { default: 1, min: 0, max: 3, description: "overall swarm brightness" });
    const size = ctx.float("swarm.size", { default: 0.035, min: 0.01, max: 0.12, description: "firefly glow radius" });
    const speed = ctx.float("swarm.speed", { default: 0.4, min: 0, max: 2, description: "drift speed" });
    const twinkle = ctx.float("blink.twinkle", { default: 1, min: 0.1, max: 4, description: "blink rate" });
    const sparkle = ctx.float("blink.sparkle", { default: 4, min: 1, max: 10, description: "blink sharpness: breathe → glint" });
    const variety = ctx.float("swarm.variety", { default: 0.4, min: 0, max: 1, description: "per-fly color scatter" });
    const flare = ctx.float("flare", { default: 1.2, min: 0, max: 3, description: "kick flare strength" });
    const glitchAmt = ctx.float("fx.glitch", { default: 0.15, min: 0, max: 1, description: "glitch intensity" });
    const count = ctx.int("swarm.count", { default: 40, min: 1, max: 80, description: "number of active fireflies" });
    const trail = ctx.float("fx.trail", { default: 0.78, min: 0.5, max: 0.96, description: "afterglow persistence" });

    const kickEnv = ctx.input("kick"); // rack channel: bass onsets → envelope
    const energy = ctx.input("energy"); // rack channel: overall level
    const glowSig = glow.signal();
    const flareSig = flare.signal();
    const brightness = new Signal(
      (f) => glowSig.get(f) * (1 + kickEnv.get(f) * flareSig.get(f) + energy.get(f) * 0.4),
    );

    const swarm = fireflies(ctx, {
      maxCount: 80,
      count: count.signal(),
      size: size.signal(),
      speed: speed.signal(),
      twinkle: twinkle.signal(),
      sharpness: sparkle.signal(),
      hue: lfo(ctx, { shape: "sine", periodBeats: 64 }),
      hueSpread: variety.signal(),
      brightness,
    });
    const trails = feedback(ctx, { input: swarm, amount: trail.signal(), zoom: 1.002 });
    const glitched = glitch(ctx, { input: trails, amount: glitchAmt.signal(), burst: kickEnv, split: 0.4 });
    return levels(ctx, { input: glitched, gamma: 1.1 });
  },
});
