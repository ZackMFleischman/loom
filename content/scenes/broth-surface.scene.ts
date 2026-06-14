import { Signal, defineScene } from "@loom/runtime";
import { bloom } from "../modules/effects/bloom";
import { displace } from "../modules/effects/displace";
import { levels } from "../modules/effects/levels";
import { mixer } from "../modules/effects/mixer";
import { over } from "../modules/effects/over";
import { paletteMap } from "../modules/effects/paletteMap";
import { vignette } from "../modules/effects/vignette";
import { blobs } from "../modules/sources/blobs";
import { fireflies } from "../modules/sources/fireflies";
import { noise } from "../modules/sources/noise";
import { ripples } from "../modules/sources/ripples";

export default defineScene({
  name: "broth-surface",
  description:
    "Looking straight down into the bowl: golden broth simmering under floating fat globules and green herb flecks, heat-shimmering, with concentric ripples spreading from every drop — the kick splashes the surface, the bass swells the simmer.",
  tags: ["pho", "broth", "liquid", "ripples", "organic", "audio-reactive"],
  build(ctx) {
    const pal = ctx.palette;
    // deep broth · broth · golden · amber · cream sheen
    pal.own(["#160a03", "#5a2e10", "#b1681b", "#e09a35", "#fff0c8"]);

    const brothScale = ctx.float("broth.scale", { default: 2.6, min: 0.5, max: 8, description: "broth texture scale (bigger = busier)" });
    const brothSpeed = ctx.float("broth.speed", { default: 0.12, min: 0, max: 1, description: "broth simmer/churn speed" });
    const brothHeat = ctx.float("broth.heat", { default: 0.5, min: 0, max: 2, description: "kick-driven broth flare" });
    const brothSwell = ctx.float("broth.swell", { default: 0.35, min: 0, max: 1.5, description: "bass-driven simmer swell" });
    const oilAmt = ctx.float("oil.amount", { default: 0.72, min: 0, max: 1, description: "floating fat-globule sheen" });
    const oilSize = ctx.float("oil.size", { default: 0.07, min: 0.03, max: 0.3, description: "fat globule size" });
    const oilSpeed = ctx.float("oil.speed", { default: 0.25, min: 0, max: 1.5, description: "globule drift speed" });
    const shimmer = ctx.float("shimmer.amount", { default: 0.04, min: 0, max: 0.2, description: "heat-haze refraction strength" });
    const rippleReach = ctx.float("ripple.reach", { default: 0.6, min: 0.1, max: 1.2, description: "how far ripples spread" });
    const rippleWidth = ctx.float("ripple.width", { default: 0.018, min: 0.005, max: 0.06, description: "ripple crest thickness" });
    const rippleSpeed = ctx.float("ripple.speed", { default: 1, min: 0.1, max: 3, description: "ripple emission rate" });
    const rippleSplash = ctx.float("ripple.splash", { default: 1.1, min: 0, max: 3, description: "kick-driven splash strength" });
    const herbCount = ctx.float("herbs.count", { default: 18, min: 0, max: 50, description: "green herb/scallion fleck count" });
    const herbSize = ctx.float("herbs.size", { default: 0.022, min: 0.005, max: 0.05, description: "herb fleck size" });
    const herbGlow = ctx.float("herbs.glow", { default: 1.1, min: 0, max: 2, description: "herb fleck brightness" });
    const bloomLevel = ctx.float("bloom.level", { default: 0.65, min: 0, max: 1, description: "sheen glow threshold" });
    const bloomAmt = ctx.float("bloom.intensity", { default: 0.4, min: 0, max: 4, description: "sheen halo strength" });
    const bloomRad = ctx.float("bloom.radius", { default: 12, min: 0, max: 48, description: "halo spread (px)" });
    const vig = ctx.float("vignette", { default: 0.6, min: 0, max: 1, description: "bowl-edge darkening" });

    const kick = ctx.input("kick");
    const bass = ctx.input("bass");

    // The broth: golden fbm simmer, brightened by the bass and flared on the kick.
    const heatSig = brothHeat.signal();
    const swellSig = brothSwell.signal();
    const broth = ctx.layer(
      "broth",
      levels(ctx, {
        // Recolor fbm through the scene's own golden palette (bg→cream) — richer
        // and reliably warm (colorize's fire preset drifts teal in the mids here).
        input: paletteMap(ctx, { input: noise(ctx, { scale: brothScale.signal(), speed: brothSpeed.signal(), octaves: 4 }) }),
        gain: new Signal((f) => 0.7 + bass.get(f) * swellSig.get(f) + kick.get(f) * heatSig.get(f) * 0.25),
        gamma: 0.92,
      }),
    );

    // Floating fat globules: golden metaballs screened over the broth as sheen.
    const oil = paletteMap(ctx, {
      input: blobs(ctx, { count: 6, size: oilSize.signal(), speed: oilSpeed.signal(), wobble: 0.06, softness: 0.3 }),
    });
    const greased = mixer(ctx, { input: broth, b: oil, mode: "screen", mix: oilAmt.signal() });

    // Heat-haze: gentle refraction of the whole surface.
    const shimmered = displace(ctx, { input: greased, amount: shimmer.signal(), scale: 3.5, speed: 0.25 });

    // Concentric ripples spreading from drop points, splashing on the kick.
    const splashSig = rippleSplash.signal();
    const surf = over(ctx, {
      input: shimmered,
      overlay: ctx.layer(
        "ripples",
        ripples(ctx, {
          count: 6,
          reach: rippleReach.signal(),
          width: rippleWidth.signal(),
          speed: rippleSpeed.signal(),
          energy: new Signal((f) => kick.get(f) * splashSig.get(f) + 0.15),
        }),
      ),
    });

    // Green herb / scallion flecks adrift on the surface.
    const herbGlowSig = herbGlow.signal();
    const herbs = fireflies(ctx, {
      maxCount: 50,
      count: herbCount.signal(),
      size: herbSize.signal(),
      speed: 0.2,
      twinkle: 0.5,
      sharpness: 4,
      hue: 0.6, // green
      hueSpread: 0.12,
      brightness: new Signal((f) => herbGlowSig.get(f) * (1 + bass.get(f) * 0.3)),
    });
    const garnished = mixer(ctx, { input: surf, b: herbs, mode: "add", mix: 1 });

    const lit = bloom(ctx, { input: garnished, level: bloomLevel.signal(), intensity: bloomAmt.signal(), radius: bloomRad.signal() });
    return vignette(ctx, { input: lit, amount: vig.signal(), radius: 0.75, softness: 0.6 });
  },
});
