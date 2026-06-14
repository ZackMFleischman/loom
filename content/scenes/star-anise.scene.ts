import { Signal, defineScene } from "@loom/runtime";
import { bloom } from "../modules/effects/bloom";
import { levels } from "../modules/effects/levels";
import { mixer } from "../modules/effects/mixer";
import { over } from "../modules/effects/over";
import { paletteMap } from "../modules/effects/paletteMap";
import { vignette } from "../modules/effects/vignette";
import { fireflies } from "../modules/sources/fireflies";
import { noise } from "../modules/sources/noise";
import { starAnise } from "../modules/sources/starAnise";

export default defineScene({
  name: "star-anise",
  description:
    "A slow, dark spice galaxy: star-anise pods tumble and drift through a cinnamon-dust haze while clove specks twinkle — bass swells the haze, the kick flares the pods. An ambient palette-cleanser.",
  tags: ["star-anise", "spice", "pho", "ambient", "organic", "audio-reactive"],
  build(ctx) {
    const pal = ctx.palette;
    // bg charcoal · dark carpel · cinnamon · warm amber · creamy seed
    pal.own(["#0b0704", "#3a1d0e", "#7e4220", "#c8772e", "#f3dca2"]);

    const hazeAmt = ctx.float("haze.brightness", { default: 0.55, min: 0, max: 1.5, description: "cinnamon-dust haze brightness" });
    const hazeScale = ctx.float("haze.scale", { default: 1.8, min: 0.5, max: 8, description: "haze texture scale" });
    const hazeSpeed = ctx.float("haze.speed", { default: 0.05, min: 0, max: 0.6, description: "haze evolution speed" });
    const hazeSwell = ctx.float("haze.swell", { default: 0.5, min: 0, max: 2, description: "bass-driven haze swell" });
    const podSize = ctx.float("pods.size", { default: 0.13, min: 0.04, max: 0.3, description: "pod radius" });
    const podSpin = ctx.float("pods.spin", { default: 0.12, min: -0.6, max: 0.6, description: "pod tumble speed" });
    const podDrift = ctx.float("pods.drift", { default: 0.045, min: 0, max: 0.15, description: "how far pods wander" });
    const podFlare = ctx.float("pods.flare", { default: 0.9, min: 0, max: 3, description: "kick-driven pod flare" });
    const speckCount = ctx.float("specks.count", { default: 26, min: 0, max: 60, description: "clove/coriander twinkle count" });
    const speckSize = ctx.float("specks.size", { default: 0.02, min: 0.005, max: 0.06, description: "speck glow size" });
    const speckGlow = ctx.float("specks.glow", { default: 0.7, min: 0, max: 2, description: "speck brightness" });
    const bloomLevel = ctx.float("bloom.level", { default: 0.6, min: 0, max: 1, description: "glow threshold" });
    const bloomAmt = ctx.float("bloom.intensity", { default: 0.45, min: 0, max: 4, description: "halo strength" });
    const bloomRad = ctx.float("bloom.radius", { default: 12, min: 0, max: 48, description: "halo spread (px)" });
    const vig = ctx.float("vignette", { default: 0.55, min: 0, max: 1, description: "corner darkening" });

    const kick = ctx.input("kick");
    const bass = ctx.input("bass");
    const energy = ctx.input("energy");

    // Cinnamon-dust haze: dim fbm recolored through the spice palette, breathing with the bass.
    const hazeSwellSig = hazeSwell.signal();
    const hazeAmtSig = hazeAmt.signal();
    const haze = ctx.layer(
      "haze",
      levels(ctx, {
        // Recolor fbm through the scene's own spice palette (bg→cream), kept dim
        // and dark-biased so it reads as a smoky nebula, not a wall.
        input: paletteMap(ctx, { input: noise(ctx, { scale: hazeScale.signal(), speed: hazeSpeed.signal(), octaves: 4 }) }),
        gain: new Signal((f) => hazeAmtSig.get(f) * (1 + bass.get(f) * hazeSwellSig.get(f))),
        gamma: 0.62,
      }),
    );

    // Clove/coriander specks twinkling in the dark, warm and sparse.
    const speckGlowSig = speckGlow.signal();
    const specks = fireflies(ctx, {
      maxCount: 60,
      count: speckCount.signal(),
      size: speckSize.signal(),
      speed: 0.25,
      twinkle: 0.7,
      sharpness: 3,
      hue: 0.0,
      hueSpread: 0.08,
      brightness: new Signal((f) => speckGlowSig.get(f) * (1 + energy.get(f) * 0.6)),
    });

    // Star-anise pods — the hero spice, flaring on the kick.
    const flareSig = podFlare.signal();
    const pods = ctx.layer(
      "anise",
      starAnise(ctx, {
        count: 7,
        size: podSize.signal(),
        spin: podSpin.signal(),
        drift: podDrift.signal(),
        energy: new Signal((f) => kick.get(f) * flareSig.get(f) + bass.get(f) * 0.2),
      }),
    );

    // Specks are opaque (alpha=1), so add them over the haze rather than `over`
    // (which would erase the haze with the fireflies' black backdrop). Pods are
    // premultiplied, so they composite normally on top.
    const withSpecks = mixer(ctx, { input: haze, b: specks, mode: "add", mix: 1 });
    const composed = over(ctx, { input: withSpecks, overlay: pods });

    const lit = bloom(ctx, { input: composed, level: bloomLevel.signal(), intensity: bloomAmt.signal(), radius: bloomRad.signal() });
    return vignette(ctx, { input: lit, amount: vig.signal(), radius: 0.85, softness: 0.7 });
  },
});
