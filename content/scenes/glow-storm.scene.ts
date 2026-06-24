import { Signal, defineScene } from "@loom/runtime";
import { glowSticks } from "../modules/sources/glowSticks";
import { solid } from "../modules/sources/solid";
import { over } from "../modules/effects/over";
import { bloom } from "../modules/effects/bloom";
import { vignette } from "../modules/effects/vignette";

const MAX_STICKS = 36;

/**
 * The drop: the whole crowd hurls glow sticks into the air. Neon capsules
 * erupt from below the frame, arc up under gravity, tumble and glow, then rain
 * back down — over a near-black festival night, bloomed. The kick swells the
 * eruption (more sticks airborne) and flashes the whole field; bass adds a
 * steady undercurrent of throws between drops.
 */
export default defineScene({
  name: "glow-storm",
  description:
    "A bass-festival glow-stick eruption — neon capsules flung up from the crowd arc, tumble and rain down, swelling and flashing on the drop.",
  tags: ["festival", "rave", "glow-stick", "neon", "particles", "audio-reactive", "showcase"],
  build(ctx) {
    const baseThrow = ctx.float("storm.base", { default: 6, min: 0, max: MAX_STICKS, description: "sticks always in the air" });
    const surge = ctx.float("storm.surge", { default: 28, min: 0, max: MAX_STICKS, description: "extra sticks the kick erupts" });
    const cadence = ctx.float("storm.cadence", { default: 0.55, min: 0.1, max: 2, description: "re-throw rate per stick" });
    const arc = ctx.float("throw.arc", { default: 0.95, min: 0.4, max: 1.3, description: "how high sticks fly" });
    const spread = ctx.float("throw.spread", { default: 0.95, min: 0.2, max: 1.3, description: "horizontal launch scatter" });
    const lateral = ctx.float("throw.lateral", { default: 0.28, min: 0, max: 0.8, description: "sideways fan-out" });
    const tumble = ctx.float("stick.tumble", { default: 1, min: 0, max: 4, description: "end-over-end spin rate" });
    const size = ctx.float("stick.size", { default: 0.05, min: 0.02, max: 0.12, description: "stick length" });
    const glow = ctx.float("stick.glow", { default: 3, min: 0.5, max: 8, description: "halo size" });
    const trail = ctx.float("stick.trail", { default: 0.7, min: 0, max: 1.5, description: "light-streak gain" });
    const flash = ctx.float("drop.flash", { default: 1, min: 0, max: 3, description: "kick brightness flash" });
    const bg = ctx.float("night.level", { default: 0.05, min: 0, max: 0.3, description: "backdrop brightness" });
    const bloomLevel = ctx.float("finish.bloom", { default: 0.35, min: 0, max: 1, description: "bloom threshold" });
    const bloomGlow = ctx.float("finish.glow", { default: 1.3, min: 0, max: 3, description: "bloom strength" });
    const vig = ctx.float("finish.vignette", { default: 0.6, min: 0, max: 1, description: "edge darkening" });

    const kick = ctx.input("kick");
    const bass = ctx.input("bass");
    const baseSig = baseThrow.signal();
    const surgeSig = surge.signal();
    // How many sticks are airborne: a baseline + bass undercurrent, erupting on the kick.
    const count = new Signal((f) => {
      const n = baseSig.get(f) + bass.get(f) * 6 + kick.get(f) * surgeSig.get(f);
      return Math.max(0, Math.min(MAX_STICKS, n));
    });
    // The kick drives the brightness flash, scaled by the drop.flash knob.
    const flashSig = flash.signal();
    const dropBurst = new Signal((f) => kick.get(f) * flashSig.get(f));

    const night = solid(ctx, { paletteStop: 0, level: bg.signal() });
    const sticks = glowSticks(ctx, {
      maxCount: MAX_STICKS,
      count,
      cadence: cadence.signal(),
      burst: dropBurst,
      arc: arc.signal(),
      spread: spread.signal(),
      lateral: lateral.signal(),
      tumble: tumble.signal(),
      size: size.signal(),
      glow: glow.signal(),
      trail: trail.signal(),
    });

    const composited = over(ctx, { input: night, overlay: sticks });
    const lit = bloom(ctx, { input: composited, level: bloomLevel.signal(), intensity: bloomGlow.signal() });
    return vignette(ctx, { input: lit, amount: vig.signal() });
  },
});
