import { defineScene, Signal } from "@loom/runtime";
import { noiseSignal } from "../modules/control/noiseSignal";
import { colorize } from "../modules/effects/colorize";
import { displace } from "../modules/effects/displace";
import { kaleido } from "../modules/effects/kaleido";
import { gradient } from "../modules/sources/gradient";
import { noiseField } from "../modules/sources/noiseField";

/**
 * Noise-as-modulator (the CHOP/SOP role): the noise never shows itself. A grey
 * cellular `noiseField` is the hidden displacement map that warps a clean
 * palette gradient, and a `noiseSignal` wanders the kaleidoscope's rotation —
 * so the same noise engine that paints noise-flow here only pushes pixels and
 * a knob. The bass drives the warp deeper.
 */
export default defineScene({
  name: "noise-warp",
  description:
    "A clean palette gradient warped by a hidden cellular noise field and folded through a noise-driven kaleidoscope — noise as pure modulator.",
  tags: ["noise", "displace", "kaleidoscope", "modulation", "audio-reactive"],
  build(ctx) {
    const cells = ctx.float("warp.scale", { default: 4, min: 0.5, max: 12, step: 0.1, description: "displacer cell density" });
    const amount = ctx.float("warp.amount", { default: 0.14, min: 0, max: 0.4, step: 0.005, description: "warp strength (uv units)" });
    const surge = ctx.float("warp.surge", { default: 0.12, min: 0, max: 0.3, step: 0.005, description: "extra warp per bass" });
    const rough = ctx.float("warp.roughness", { default: 0.6, min: 0.2, max: 0.85, step: 0.01, description: "displacer roughness" });
    const churn = ctx.float("warp.churn", { default: 0.3, min: 0, max: 1.5, step: 0.01, description: "displacer evolution speed" });
    const segments = ctx.int("fold.segments", { default: 6, min: 2, max: 12, description: "kaleidoscope wedges" });
    const swirl = ctx.float("fold.swirl", { default: 0.4, min: 0, max: 2, step: 0.01, description: "noise rotation speed" });

    const bass = ctx.input("bass");
    const amountSig = amount.signal();
    const surgeSig = surge.signal();

    const bed = colorize(ctx, { input: gradient(ctx, { mode: "angular", scroll: 0.04 }), palette: 2, bands: 1.5 });
    const map = noiseField(ctx, {
      type: "worley",
      octaves: 4,
      scale: cells.signal(),
      gain: rough.signal(),
      lacunarity: 2.1,
      evolve: churn.signal(),
      flowX: 0.05,
    });
    const warped = ctx.layer(
      "warped",
      displace(ctx, {
        input: bed,
        map,
        amount: new Signal((f) => amountSig.get(f) + bass.get(f) * surgeSig.get(f)),
      }),
    );
    // The Noise CHOP: a wandering value-noise driving the fold's rotation.
    const spin = noiseSignal(ctx, { rate: swirl.signal(), lo: -3.1416, hi: 3.1416, octaves: 3, seed: 7 });
    return kaleido(ctx, { input: warped, segments: segments.signal(), rotate: spin, amount: 0.95 });
  },
});
