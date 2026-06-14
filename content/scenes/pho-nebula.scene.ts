import { Signal, defineScene, integrateSignal } from "@loom/runtime";
import { lfo } from "../modules/control/lfo";
import { colorize, PALETTE_SWATCHES } from "../modules/effects/colorize";
import { feedback } from "../modules/effects/feedback";
import { kaleido } from "../modules/effects/kaleido";
import { levels } from "../modules/effects/levels";
import { over } from "../modules/effects/over";
import { image } from "../modules/sources/image";
import { noise } from "../modules/sources/noise";
import { noodles } from "../modules/sources/noodles";
import { spriteSwarm } from "../modules/sources/spriteSwarm";

// 3x2 atlas of chili/lime/scallion/anise/basil/chopsticks — one texture, so
// the swarm can go deep without hitting WebGL2's sampler cap.
const ATLAS_URL = new URL("../assets/pho/garnish-atlas.png", import.meta.url).href;
const BADGE_URL = new URL("../assets/pho/pho-badge.png", import.meta.url).href;

export default defineScene({
  name: "pho-nebula",
  description:
    "An infinite bowl of cosmic phở: simmering golden broth folded through a slow mandala, steam blooming on the kick, garnish drifting by under a PHỞ marquee.",
  tags: ["audio-reactive", "kaleidoscope", "feedback", "pho", "ambient"],
  build(ctx) {
    // Dotted paths form collapsible Console groups: broth / swirl / steam / garnish / badge.
    const simmer = ctx.float("broth.simmer", { default: 0.22, min: 0, max: 1.5, description: "broth churn speed (noise evolution)" });
    const chunk = ctx.float("broth.chunk", { default: 2.4, min: 0.5, max: 8, description: "broth texture scale (bigger = busier)" });
    const heat = ctx.float("broth.heat", { default: 0.9, min: 0, max: 3, description: "kick-driven broth flare strength" });
    const palette = ctx.float("broth.palette", { default: 4, min: 0, max: 5, swatches: PALETTE_SWATCHES, description: "cosine palette index (4 = fire/golden broth; fractional blends)" });
    const drift = ctx.float("broth.drift", { default: 0.35, min: 0, max: 1, description: "how far the palette hue wanders over 64 beats" });
    const segments = ctx.int("swirl.segments", { default: 8, min: 2, max: 16, description: "mandala wedge count (the bowl from above)" });
    const spin = ctx.float("swirl.spin", { default: 0.06, min: -0.6, max: 0.6, description: "mandala stir speed (rad/sec, negative = counter-stir)" });
    const fold = ctx.float("swirl.fold", { default: 0.85, min: 0, max: 1, description: "mandala strength (0 = raw broth, 1 = full fold)" });
    const swell = ctx.float("swirl.swell", { default: 0.3, min: 0, max: 1, description: "bass-driven zoom breathe into the bowl" });
    const trail = ctx.float("steam.trail", { default: 0.86, min: 0, max: 0.97, description: "steam persistence (feedback trail length)" });
    const bloom = ctx.float("steam.bloom", { default: 0.012, min: 0, max: 0.05, description: "steam outward drift per frame (rising vapor)" });
    const noodleAmt = ctx.float("noodles.amount", { default: 0.75, min: 0, max: 1, description: "noodle strand opacity in the broth" });
    const noodleWiggle = ctx.float("noodles.wiggle", { default: 0.05, min: 0, max: 0.2, description: "how far strands wander from their lane" });
    const noodleWaves = ctx.float("noodles.curl", { default: 2.2, min: 0.3, max: 8, description: "wave count along a strand (higher = curlier)" });
    const noodleWidth = ctx.float("noodles.width", { default: 0.012, min: 0.002, max: 0.05, description: "strand thickness" });
    const noodleFlow = ctx.float("noodles.flow", { default: 0.5, min: 0, max: 3, description: "strand undulation speed" });
    const slurp = ctx.float("noodles.slurp", { default: 0.8, min: 0, max: 3, description: "kick-driven wiggle surge through the strands" });
    const garnish = ctx.float("garnish.opacity", { default: 1, min: 0, max: 1, description: "floating garnish opacity" });
    const garnishCount = ctx.int("garnish.count", { default: 6, min: 0, max: 18, description: "how many garnish sprites are afloat" });
    const garnishSize = ctx.float("garnish.size", { default: 0.13, min: 0, max: 0.5, description: "floating garnish size" });
    const garnishSpeed = ctx.float("garnish.speed", { default: 0.4, min: 0, max: 3, description: "garnish drift speed" });
    const badge = ctx.float("badge.opacity", { default: 1, min: 0, max: 1, description: "PHỞ marquee opacity" });
    const badgeSize = ctx.float("badge.size", { default: 0.42, min: 0, max: 2, description: "PHỞ marquee scale" });
    const bump = ctx.float("badge.bump", { default: 0.18, min: 0, max: 1, description: "PHỞ marquee kick bounce" });

    const kick = ctx.input("kick"); // bass onsets -> punchy envelope
    const bass = ctx.input("bass"); // sustained low-end weight

    // The broth: slow fbm churn, colored golden by the fire palette with a
    // very slow hue wander so the bowl never sits still.
    const hueLfo = lfo(ctx, { shape: "sine", periodBeats: 64 });
    const driftSig = drift.signal();
    const shift = new Signal((f) => hueLfo.get(f) * driftSig.get(f));
    const broth = noise(ctx, { scale: chunk.signal(), speed: simmer.signal(), octaves: 4 });
    const soup = colorize(ctx, { input: broth, palette: palette.signal(), shift, bands: 1.5, preserveBlack: 0 });

    // Noodles swim in the broth before the fold, so the mandala swirls them
    // into radial strands; the kick sends a slurp-wiggle down every strand.
    const slurpSig = slurp.signal();
    const strands = noodles(ctx, {
      count: 9,
      wiggle: noodleWiggle.signal(),
      waves: noodleWaves.signal(),
      width: noodleWidth.signal(),
      flow: noodleFlow.signal(),
      energy: new Signal((f) => kick.get(f) * slurpSig.get(f)),
    });
    const soupNoodled = over(ctx, { input: soup, overlay: strands, opacity: noodleAmt.signal() });

    // The bowl: fold the broth into a slowly stirring mandala; bass breathes
    // the zoom so the whole bowl swells with the low end.
    const spinSig = spin.signal();
    const stir = integrateSignal(new Signal((f) => spinSig.get(f)));
    const swellSig = swell.signal();
    const zoom = new Signal((f) => 1 + bass.get(f) * swellSig.get(f));
    const bowl = kaleido(ctx, {
      input: soupNoodled,
      segments: segments.signal(),
      rotate: stir,
      zoom,
      amount: fold.signal(),
    });

    // Steam: outward-drifting feedback trails — every kick flare blooms and
    // rises off the surface like vapor off the broth.
    const bloomSig = bloom.signal();
    const steam = feedback(ctx, {
      input: bowl,
      amount: trail.signal(),
      zoom: new Signal((f) => 1 + bloomSig.get(f)),
    });
    const heatSig = heat.signal();
    // Layer nodes: the obvious grabbables, each with a free transform/opacity
    // rig (<node>.layer.*) and chainable FX (set_chain { node }).
    const served = ctx.layer(
      "bowl",
      levels(ctx, {
        input: steam,
        gain: new Signal((f) => 1 + kick.get(f) * heatSig.get(f) * 0.35),
        gamma: 1.05,
      }),
    );

    // Garnish drifts over the bowl, outside the steam chain so it stays crisp.
    // One atlas texture serves the whole swarm (sampler-cap safe up to 18).
    const swarm = spriteSwarm(ctx, {
      url: ATLAS_URL,
      cols: 3,
      rows: 2,
      maxCount: 18,
      count: garnishCount.signal(),
      size: garnishSize.signal(),
      speed: garnishSpeed.signal(),
    });
    const garnished = over(ctx, {
      input: served,
      overlay: ctx.layer("garnish", swarm),
      opacity: garnish.signal(),
    });

    // The PHỞ marquee bounces on the kick.
    const badgeSizeSig = badgeSize.signal();
    const bumpSig = bump.signal();
    const marquee = image(ctx, {
      url: BADGE_URL,
      transform: {
        scale: new Signal((f) => badgeSizeSig.get(f) * (1 + kick.get(f) * bumpSig.get(f))),
      },
    });
    return over(ctx, { input: garnished, overlay: ctx.layer("badge", marquee), opacity: badge.signal() });
  },
});
