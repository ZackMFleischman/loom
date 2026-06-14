import { defineScene, Signal } from "@loom/runtime";
import { echo } from "../modules/effects/echo";
import { hsv } from "../modules/effects/hsv";
import { mixer } from "../modules/effects/mixer";
import { rgbSplit } from "../modules/effects/rgbSplit";
import { mediaUrl, video } from "../modules/sources/video";

// Two decks off the VJ drive (loom:media roots) — missing files stay black.
const DECK_A = mediaUrl("C:\\Users\\zFlei\\Dropbox\\VJ\\Assets\\Videos\\BEEPLE_MANIFEST_GOLDEN_CITY-C.mp4");
const DECK_B = mediaUrl("C:\\Users\\zFlei\\Dropbox\\VJ\\Assets\\Videos\\transcoded\\scream.mp4");

export default defineScene({
  name: "deck-mixer",
  description:
    "A two-deck video mixer: crossfader between clips, hue on a slow ride, kick-driven RGB split and frame echo for the drop.",
  tags: ["video", "mixer", "deck", "vj", "audio-reactive", "showcase"],
  build(ctx) {
    const fader = ctx.float("mix.fader", { default: 0.5, min: 0, max: 1, description: "deck A ↔ deck B crossfade" });
    const speedA = ctx.float("deckA.speed", { default: 1, min: 0, max: 4, step: 0.05, description: "deck A playback rate" });
    const speedB = ctx.float("deckB.speed", { default: 1, min: 0, max: 4, step: 0.05, description: "deck B playback rate" });
    const hue = ctx.float("color.hue", { default: 0, min: -1, max: 1, step: 0.001, description: "hue rotation (turns)" });
    const sat = ctx.float("color.saturation", { default: 1.1, min: 0, max: 2, description: "saturation" });
    const split = ctx.float("drop.split", { default: 0.5, min: 0, max: 1, description: "kick-driven RGB split strength" });
    const ghost = ctx.float("drop.echo", { default: 0.35, min: 0, max: 1, description: "frame-echo blend" });
    const ghostDelay = ctx.int("drop.delay", { default: 9, min: 0, max: 23, description: "echo distance (frames)" });

    const kick = ctx.input("kick");
    const splitSig = split.signal();

    const a = ctx.layer("deckA", video(ctx, { url: DECK_A, speed: speedA.signal() }));
    const b = ctx.layer("deckB", video(ctx, { url: DECK_B, speed: speedB.signal() }));
    const blended = mixer(ctx, { input: a, b, mode: "crossfade", mix: fader.signal() });
    const graded = hsv(ctx, { input: blended, hue: hue.signal(), saturation: sat.signal() });
    const torn = rgbSplit(ctx, {
      input: graded,
      amount: new Signal((f) => kick.get(f) * splitSig.get(f) * 0.025),
    });
    return echo(ctx, { input: torn, delay: ghostDelay.signal(), amount: ghost.signal() });
  },
});
