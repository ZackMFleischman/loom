import { defineScene, Signal } from "@loom/runtime";
import { kaleido } from "../modules/effects/kaleido";
import { levels } from "../modules/effects/levels";
import { over } from "../modules/effects/over";
import { mediaUrl, video } from "../modules/sources/video";

// External clips served through the loom:media middleware — these paths must
// live under a root in content/state/media-roots.json. Missing files degrade
// gracefully: the layer just stays transparent.
const CITY = mediaUrl("C:\\Users\\zFlei\\Dropbox\\VJ\\Assets\\Videos\\BEEPLE_MANIFEST_GOLDEN_CITY-A.mp4");
const TUNNEL = mediaUrl("C:\\Users\\zFlei\\Dropbox\\VJ\\Assets\\Videos\\transcoded\\tunnal.mp4");

export default defineScene({
  name: "beeple-wall",
  description:
    "Beeple's golden city under a kaleidoscope-folded tunnel loop — two live video decks with speed/scrub on faders and the kick punching the levels.",
  tags: ["video", "media", "beeple", "kaleidoscope", "audio-reactive"],
  build(ctx) {
    // Dotted paths form Console groups: city / tunnel (the two decks).
    const citySpeed = ctx.float("city.speed", { default: 1, min: 0, max: 4, step: 0.05, description: "city deck playback rate (0 = freeze frame)" });
    const cityScrubbing = ctx.bool("city.scrubbing", { default: false, description: "hold playback and chase the scrub head" });
    const cityScrub = ctx.float("city.scrub", { default: 0, min: 0, max: 1, step: 0.001, description: "scrub head (fraction of the clip)" });
    const tunSpeed = ctx.float("tunnel.speed", { default: 1, min: 0, max: 4, step: 0.05, description: "tunnel deck playback rate" });
    const tunAmt = ctx.float("tunnel.opacity", { default: 0.55, min: 0, max: 1, description: "tunnel layer blend over the city" });
    const tunSegments = ctx.int("tunnel.segments", { default: 6, min: 2, max: 16, description: "kaleidoscope wedge count on the tunnel" });
    const punch = ctx.float("punch", { default: 0.35, min: 0, max: 1.5, description: "kick-driven brightness punch" });

    const kick = ctx.input("kick");
    const scrubbingSig = cityScrubbing.signal();

    const city = ctx.layer(
      "city",
      video(ctx, {
        url: CITY,
        speed: citySpeed.signal(),
        scrubbing: new Signal((f) => (scrubbingSig.get(f) ? 1 : 0)),
        scrub: cityScrub.signal(),
      }),
    );
    const tunnel = ctx.layer(
      "tunnel",
      kaleido(ctx, {
        input: video(ctx, { url: TUNNEL, speed: tunSpeed.signal() }),
        segments: tunSegments.signal(),
      }),
    );
    const punchSig = punch.signal();
    const stacked = over(ctx, { input: city, overlay: tunnel, opacity: tunAmt.signal() });
    return levels(ctx, {
      input: stacked,
      gain: new Signal((f) => 1 + kick.get(f) * punchSig.get(f)),
      gamma: 1.02,
    });
  },
});
