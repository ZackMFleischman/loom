import { defineScene, Signal, texNode } from "@loom/runtime";
import { mix, smoothstep, vec4 } from "three/tsl";
import { blobs } from "../modules/sources/blobs";
import { mandelbrot } from "../modules/sources/mandelbrot";
import { noise } from "../modules/sources/noise";
import { feedback } from "../modules/effects/feedback";
import { glitch } from "../modules/effects/glitch";
import { levels } from "../modules/effects/levels";
import { paletteMap } from "../modules/effects/paletteMap";

/**
 * A Mandelbrot set whose exterior filaments flow through the global palette
 * ramp while its black interior hosts a living "garden" — warped noise + drifting
 * blobs tinted with discrete palette stops, blooming on the kick. A bright accent
 * rim separates interior from exterior. Flip palette.source (own / primary /
 * secondary) to retint the entire frame live, no rebuild.
 *
 * Palette roles: 0 bg (dark interior base) · 1 edge · 2/3 garden core ·
 * 4 accent (rim + kick bloom). own() boots the authored look.
 */
export default defineScene({
  name: "mandelbloom",
  description:
    "Mandelbrot with a palette-ramped exterior and a kick-blooming garden inside the black interior; flip palette.source to retint everything.",
  tags: ["fractal", "palette", "audio-reactive", "showcase"],
  build(ctx) {
    // Dotted paths form collapsible Console groups: zoom / garden / fx.
    // iter (quality), scroll (the exterior's one knob) and rim stay flat.
    const dive = ctx.float("zoom.dive", { default: 0.05, min: -0.5, max: 0.5, description: "zoom speed (octaves/sec, ping-pongs)" });
    const depth = ctx.float("zoom.depth", { default: 3, min: 0.5, max: 10, description: "zoom depth (octaves); low keeps the interior on screen" });
    const iter = ctx.int("iter", { default: 200, min: 40, max: 500, description: "escape-time iteration cap (detail vs cost)" });
    const scroll = ctx.float("scroll", { default: 0.05, min: -0.5, max: 0.5, description: "exterior ramp scroll speed" });
    const warp = ctx.float("garden.warp", { default: 3, min: 0.5, max: 8, description: "interior texture scale (garden busyness)" });
    const garden = ctx.float("garden.amount", { default: 1, min: 0, max: 2, description: "interior element intensity" });
    const bloom = ctx.float("garden.bloom", { default: 1, min: 0, max: 3, description: "kick accent bloom strength" });
    const rim = ctx.float("rim", { default: 0.05, min: 0.005, max: 0.2, description: "set-boundary rim width" });
    const trail = ctx.float("fx.trail", { default: 0.6, min: 0, max: 0.93, description: "feedback trail persistence" });
    const glitchAmt = ctx.float("fx.glitch", { default: 0.12, min: 0, max: 1, description: "kick glitch burst amount" });

    // Authored default stops (roles above). own() boots this look; flipping
    // palette.source to primary/secondary retints filaments, garden and rim together.
    const pal = ctx.palette;
    pal.own(["#070a1e", "#1b3a6b", "#34d1c9", "#b15be0", "#ffd166"]);

    // Kick envelope drives interior bloom, glitch burst and a small zoom punch.
    // The rack owns kick detection (R6.4) — ride the named channel's envelope.
    const kickEnv = ctx.input("kick");
    const kickU = ctx.uniformOf(kickEnv);

    // Base fractal (grayscale; brightness b = 0 inside the set). Shallow, slow
    // dive keeps a chunky interior on screen for the garden to live in.
    const fractal = mandelbrot(ctx, {
      cx: -0.6,
      cy: 0,
      dive: dive.signal(),
      depth: depth.signal(),
      iterations: iter.signal(),
    });
    const b = fractal.color.r;
    const rimW = ctx.uniformOf(rim.signal());
    const inSet = smoothstep(0, rimW, b).oneMinus(); // 1 inside the set, 0 outside
    const rimMask = inSet.mul(inSet.oneMinus()).mul(4); // parabola peaking at the boundary

    // Exterior: filaments mapped through the palette ramp, slowly scrolling.
    const scrollS = scroll.signal();
    let phase = 0;
    const scrollSig = new Signal((f) => (phase = (phase + f.dt * scrollS.get(f)) % 1));
    const exterior = paletteMap(ctx, { input: fractal, shift: scrollSig });

    // Interior garden: warped-noise hue mix of the two core stops, masked by
    // drifting blobs, on a dimmed bg stop; accent stop blooms on the kick.
    const warpN = noise(ctx, { scale: warp.signal(), speed: 0.15 });
    const orbs = blobs(ctx, { count: 6, size: 0.13, speed: 0.4, wobble: 0.06 });
    const orbInk = orbs.color.x;
    const orbCore = orbs.color.y;
    const gardenHue = mix(pal.color(2), pal.color(3), warpN.color.r);
    const gardenS = ctx.uniformOf(garden.signal());
    const bloomS = ctx.uniformOf(bloom.signal());
    const interior = pal
      .color(0)
      .mul(0.25)
      .add(gardenHue.mul(orbInk).mul(gardenS))
      .add(pal.color(4).mul(orbCore).mul(kickU.mul(bloomS).add(0.15)));

    // Composite exterior/interior by the set mask, then add the accent rim.
    const composited = mix(exterior.color.rgb, interior, inSet);
    const withRim = composited.add(pal.color(4).mul(rimMask));
    const src = texNode(vec4(withRim, 1), exterior.passes);

    // Effects: trails (zoom punches on the kick) → kick glitch burst → grade.
    const zoom = kickEnv.map((k) => 1.001 + k * 0.01);
    const trails = feedback(ctx, { input: src, amount: trail.signal(), zoom });
    const glitched = glitch(ctx, {
      input: trails,
      amount: glitchAmt.signal(),
      burst: kickEnv,
      split: 0.4,
    });
    return levels(ctx, { input: glitched, gain: 1.06, gamma: 1.05 });
  },
});
