import { defineScene, Signal } from "@loom/runtime";
import { envelope } from "../modules/control/envelope";
import { lfo } from "../modules/control/lfo";
import { bloom } from "../modules/effects/bloom";
import { displace } from "../modules/effects/displace";
import { mixer } from "../modules/effects/mixer";
import { paletteMap } from "../modules/effects/paletteMap";
import { blobs } from "../modules/sources/blobs";
import { fireflies } from "../modules/sources/fireflies";
import { voronoi } from "../modules/sources/voronoi";

export default defineScene({
  name: "biolume",
  description:
    "Deep-sea bioluminescence: breathing cellular water lit by drifting plankton blobs and glow-points — bass swells the breathing, the kick blooms the light.",
  tags: ["organic", "bioluminescent", "deep-sea", "audio-reactive", "ambient"],
  build(ctx) {
    const cellScale = ctx.float("cells.scale", { default: 5, min: 1, max: 12, description: "cell density (bigger = busier)" });
    const breathe = ctx.float("cells.breathe", { default: 0.5, min: 0, max: 1.5, description: "bass-driven swell depth (the breathing)" });
    const churn = ctx.float("cells.drift", { default: 0.22, min: 0, max: 1.5, description: "cell wander speed" });
    const warpAmt = ctx.float("warp.amount", { default: 0.05, min: 0, max: 0.2, description: "soft current warp strength" });
    const surge = ctx.float("warp.surge", { default: 0.06, min: 0, max: 0.2, description: "extra warp per bass swell" });
    const plankton = ctx.float("plankton.size", { default: 0.12, min: 0.03, max: 0.3, description: "glow-blob base size" });
    const mist = ctx.float("plankton.glow", { default: 0.7, min: 0, max: 1, description: "how much the blobs light the water" });
    const flyCount = ctx.int("flies.count", { default: 22, min: 0, max: 60, description: "drifting glow-point count" });
    const flySize = ctx.float("flies.size", { default: 0.03, min: 0.01, max: 0.1, description: "glow-point radius" });
    const drift = ctx.float("color.drift", { default: 0.3, min: 0, max: 1, description: "slow palette drift over 64 beats" });
    const bloomAmt = ctx.float("glow.bloom", { default: 1.3, min: 0, max: 3, description: "kick-driven light bloom strength" });
    const release = ctx.float("glow.release", { default: 0.6, min: 0.1, max: 2, description: "bloom fall time after a kick (s)" });

    ctx.palette.own(["#020714", "#07303f", "#0e7d78", "#35d4ae", "#bdfbef"]); // abyss · water · cell · biolume · flash

    const bass = ctx.input("bass"); // sustained low end -> breathing swell
    const kick = ctx.input("kick"); // onsets -> light blooms
    const kickEnv = envelope(ctx, { input: kick, attack: 0.006, release: release.signal() });

    // Breathing cells: bass divides the cell count down so the texture swells open.
    const scaleSig = cellScale.signal();
    const breatheSig = breathe.signal();
    const cells = voronoi(ctx, {
      scale: new Signal((f) => scaleSig.get(f) / (1 + bass.get(f) * breatheSig.get(f))),
      speed: churn.signal(),
    });

    // Glowing plankton blobs swell gently with the same breath.
    const sizeSig = plankton.signal();
    const blobSize = new Signal((f) => sizeSig.get(f) * (1 + bass.get(f) * 0.4 * breatheSig.get(f)));
    const ink = blobs(ctx, { count: 7, size: blobSize, speed: 0.18, softness: 0.45, wobble: 0.08 });
    const lum = mixer(ctx, { input: cells, b: ink, mode: "screen", mix: mist.signal() });

    // Color through the palette (very slow drift), then warp like moving water.
    const driftSig = drift.signal();
    const hueLfo = lfo(ctx, { shape: "sine", periodBeats: 64 });
    const shift = new Signal((f) => hueLfo.get(f) * driftSig.get(f) * 0.25);
    const sea = paletteMap(ctx, { input: lum, gain: 0.8, shift });
    const warpSig = warpAmt.signal();
    const surgeSig = surge.signal();
    const warpDrive = new Signal((f) => warpSig.get(f) + bass.get(f) * surgeSig.get(f));
    const water = ctx.layer("water", displace(ctx, { input: sea, amount: warpDrive, scale: 2.2, speed: 0.15 }));

    // Drifting deep-sea glow-points; the kick flares the whole swarm.
    const swarm = fireflies(ctx, {
      maxCount: 60, count: flyCount.signal(), size: flySize.signal(), speed: 0.22,
      twinkle: 0.7, sharpness: 2.5, hue: 0.45, hueSpread: 0.12,
      brightness: new Signal((f) => 0.8 + kickEnv.get(f) * 1.6),
    });
    const flies = ctx.layer("flies", swarm);
    const staged = mixer(ctx, { input: water, b: flies, mode: "add", mix: 1 });

    // The kick blooms the light.
    const bloomSig = bloomAmt.signal();
    const intensity = new Signal((f) => 0.5 + kickEnv.get(f) * bloomSig.get(f));
    return bloom(ctx, { input: staged, level: 0.45, radius: 26, intensity });
  },
});
