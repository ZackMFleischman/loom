import { Signal, defineScene, integrateSignal, texNode } from "@loom/runtime";
import { vec4 } from "three/tsl";
import { lag } from "../modules/control/lag";
import { flyby } from "../modules/effects/flyby";
import { kaleidoZoom } from "../modules/effects/kaleidoZoom";
import { levels } from "../modules/effects/levels";
import { over } from "../modules/effects/over";
import { pixelate } from "../modules/effects/pixelate";
import { image } from "../modules/sources/image";

const IMG_URL = new URL("../assets/VinylDJHippo.png", import.meta.url).href;
const LOGO_URL = new URL("../assets/DJHippoOverlay.png", import.meta.url).href;
const HIPPO_URLS = [
  new URL("../assets/hippos/hippo1.png", import.meta.url).href,
  new URL("../assets/hippos/hippo2.png", import.meta.url).href,
  new URL("../assets/hippos/hippo3.png", import.meta.url).href,
  new URL("../assets/hippos/hippo4.png", import.meta.url).href,
  new URL("../assets/hippos/hippo5.png", import.meta.url).href,
];
const TAU = Math.PI * 2;

export default defineScene({
  name: "vinyl-zoom",
  description:
    "DJ Hippo vinyl spinning at 33rpm, devoured by an infinite kaleidoscopic dive that lurches deeper on every kick.",
  tags: ["image", "kaleidoscope", "zoom", "audio-reactive", "vinyl"],
  build(ctx) {
    // Dotted paths form collapsible Console groups: vinyl / dive / logo / hippos.
    const rpm = ctx.float("vinyl.rpm", { default: 33.3, min: -78, max: 78, description: "record spin speed (rpm, negative = reverse)" });
    const size = ctx.float("vinyl.size", { default: 1.7, min: 0.2, max: 2, description: "record scale feeding the dive" });
    const pixelVinyl = ctx.float("vinyl.pixelate", { default: 0, min: 0, max: 1, description: "mosaic on the record image, before the kaleidoscope" });
    const punch = ctx.float("dive.punch", { default: 5, min: 0, max: 12, description: "dive thrust per kick (octaves, integrated)" });
    const creep = ctx.float("dive.creep", { default: 0.12, min: -1, max: 1, description: "baseline dive speed between beats (octaves/sec)" });
    const glide = ctx.float("dive.glide", { default: 0.4, min: 0.05, max: 2, description: "kick-thrust smoothing (seconds) — higher = silkier dive" });
    const segments = ctx.int("dive.segments", { default: 6, min: 2, max: 16, description: "kaleidoscope wedge count" });
    const twist = ctx.float("dive.twist", { default: 0.8, min: -3, max: 3, description: "spiral rotation per zoom octave (radians)" });
    const logo = ctx.float("logo.opacity", { default: 1, min: 0, max: 1, description: "DJ Hippo logo overlay opacity" });
    const logoSize = ctx.float("logo.size", { default: 1, min: 0, max: 8, description: "logo overlay scale (0 = gone, ~7 fills the screen)" });
    const logoRpm = ctx.float("logo.rpm", { default: 0, min: -78, max: 78, description: "logo spin speed (rpm, negative = reverse)" });
    const logoTiltX = ctx.float("logo.tiltX", { default: 0, min: -1.5, max: 1.5, description: "logo 3D tilt, top leans away (radians)" });
    const logoTiltY = ctx.float("logo.tiltY", { default: 0, min: -1.5, max: 1.5, description: "logo 3D card-flip tilt (radians)" });
    const pixelLogo = ctx.float("logo.pixelate", { default: 0, min: 0, max: 1, description: "mosaic on the DJ Hippo logo only" });
    const hippos = ctx.float("hippos.opacity", { default: 1, min: 0, max: 1, description: "flying hippo flock opacity" });
    const hippoSize = ctx.float("hippos.size", { default: 0.16, min: 0, max: 0.6, description: "flying hippo size" });
    const hippoSpeed = ctx.float("hippos.speed", { default: 0.6, min: 0, max: 3, description: "flying hippo flight speed" });
    const pixelHippos = ctx.float("hippos.pixelate", { default: 0, min: 0, max: 1, description: "mosaic on the flying hippo flock only" });
    const pixel = ctx.float("pixelate", { default: 0, min: 0, max: 1, description: "mosaic on the whole output (0 = off)" });

    const kick = ctx.input("kick"); // rack channel: bass onsets -> envelope

    const rpmSig = rpm.signal();
    const punchSig = punch.signal();
    const creepSig = creep.signal();

    // Records turn clockwise: negative angle in CCW-positive math.
    const recordAngle = integrateSignal(new Signal((f) => (-rpmSig.get(f) * TAU) / 60));
    // The dive only moves forward: baseline creep plus a thrust on each kick.
    // The thrust is lagged so the zoom VELOCITY stays continuous — same
    // octaves per kick, spread into a smooth surge instead of a lurch.
    const thrust = lag(ctx, { input: kick, seconds: glide.signal() });
    const depth = integrateSignal(new Signal((f) => creepSig.get(f) + thrust.get(f) * punchSig.get(f)));

    const record = image(ctx, { url: IMG_URL, transform: { rotate: recordAngle, scale: size.signal() } });
    // Pixelate the record itself — the kaleidoscope then folds the mosaic.
    const recordPix = pixelate(ctx, { input: record, amount: pixelVinyl.signal() });
    const dive = kaleidoZoom(ctx, {
      input: recordPix,
      zoom: depth,
      segments: segments.signal(),
      twist: twist.signal(),
    });
    // Layer nodes: the obvious grabbables, each with a free transform/opacity
    // rig (<node>.layer.*) and chainable FX (set_chain { node }).
    const graded = ctx.layer(
      "dive",
      levels(ctx, { input: dive, gain: kick.map((k) => 1 + k * 0.2), gamma: 1.05 }),
    );

    // The logo rides on top, outside the zoom chain — static while the dive runs.
    const logoRpmSig = logoRpm.signal();
    const logoAngle = integrateSignal(new Signal((f) => (-logoRpmSig.get(f) * TAU) / 60));
    const badge = image(ctx, {
      url: LOGO_URL,
      transform: {
        scale: logoSize.signal(),
        rotate: logoAngle,
        rotateX: logoTiltX.signal(),
        rotateY: logoTiltY.signal(),
      },
    });
    const badgePix = ctx.layer("logo", pixelate(ctx, { input: badge, amount: pixelLogo.signal() }));
    const branded = over(ctx, { input: graded, overlay: badgePix, opacity: logo.signal() });

    // The flock builds on a transparent base so it can be pixelated as its
    // own layer (premultiplied `over` is associative), then rides on top.
    const flock = flyby(ctx, {
      input: texNode(vec4(0, 0, 0, 0)),
      urls: HIPPO_URLS,
      size: hippoSize.signal(),
      speed: hippoSpeed.signal(),
      opacity: hippos.signal(),
    });
    const flockPix = ctx.layer("hippos", pixelate(ctx, { input: flock, amount: pixelHippos.signal() }));
    const withFlock = over(ctx, { input: branded, overlay: flockPix });

    // Whole-frame mosaic last; every pixelate is free while its slider is 0.
    return pixelate(ctx, { input: withFlock, amount: pixel.signal() });
  },
});
