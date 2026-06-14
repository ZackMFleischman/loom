import { defineScene, lagSignal, Signal } from "@loom/runtime";
import { marbleWarp } from "../modules/effects/marbleWarp";
import { vignette } from "../modules/effects/vignette";
import { osc } from "../modules/sources/osc";

/**
 * Bold RGB oscillator stripes smeared through the `marbleWarp` effect into
 * liquid-marble swirls — the warp field folds the stripes into paint-marbling.
 * The bass drives the warp amount so the stripes churn on the build.
 */
export default defineScene({
  name: "marble-warp",
  description: "RGB stripes smeared through an iterated domain-warp field into liquid marble; bass churns the warp.",
  tags: ["marble", "domain-warp", "displace", "stripes", "audio-reactive"],
  build(ctx) {
    const freq = ctx.float("stripes.freq", { default: 11, min: 2, max: 30, step: 0.5, description: "stripe frequency" });
    const offset = ctx.float("stripes.rgb", { default: 0.12, min: 0, max: 0.4, step: 0.01, description: "RGB phase split" });
    const amount = ctx.float("warp.amount", { default: 0.22, min: 0, max: 0.5, step: 0.01, description: "smear strength" });
    const surge = ctx.float("warp.surge", { default: 0.15, min: 0, max: 0.4, step: 0.01, description: "bass push on the smear" });
    const scale = ctx.float("warp.scale", { default: 2.5, min: 0.5, max: 8, step: 0.1, description: "warp field scale" });
    const warp = ctx.float("warp.fold", { default: 5, min: 0, max: 8, step: 0.1, description: "domain-warp folding" });
    const evolve = ctx.float("warp.drift", { default: 0.12, min: 0, max: 0.5, step: 0.01, description: "warp drift speed" });
    const vig = ctx.float("finish.vignette", { default: 0.45, min: 0, max: 1, step: 0.01, description: "corner darkening" });

    const stripes = osc(ctx, { freq: freq.signal(), sync: 0.25, offset: offset.signal() });

    const bass = lagSignal(ctx.audio.band("bass"), 0.12);
    const amtBase = amount.signal();
    const surgeAmt = surge.signal();
    const amtSig = new Signal((f) => amtBase.get(f) + bass.get(f) * surgeAmt.get(f));

    const warped = marbleWarp(ctx, {
      input: stripes,
      amount: amtSig,
      scale: scale.signal(),
      warp: warp.signal(),
      evolve: evolve.signal(),
    });
    return vignette(ctx, { input: warped, amount: vig.signal() });
  },
});
