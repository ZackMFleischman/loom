import { defineScene, Signal } from "@loom/runtime";
import { displace } from "../modules/effects/displace";
import { echo } from "../modules/effects/echo";
import { glitch } from "../modules/effects/glitch";
import { invert } from "../modules/effects/invert";
import { posterize } from "../modules/effects/posterize";
import { rgbSplit } from "../modules/effects/rgbSplit";
import { osc } from "../modules/sources/osc";
import { voronoi } from "../modules/sources/voronoi";

export default defineScene({
  name: "static-haunt",
  description:
    "Broken-broadcast haunting: oscillator bars torn by voronoi, crushed to poster steps and shredded by kick-blasted glitch tears with negative strobes — hats jitter the chroma split while frame echoes ghost behind.",
  tags: ["glitch", "strobe", "echo", "retro", "audio-reactive"],
  build(ctx) {
    const tear = ctx.float("tear.amount", { default: 0.05, min: 0, max: 0.25, step: 0.005, description: "baseline voronoi tear warp" });
    const surge = ctx.float("tear.surge", { default: 0.12, min: 0, max: 0.3, step: 0.005, description: "extra tear per kick" });
    const bars = ctx.float("bars.freq", { default: 9, min: 1, max: 30, description: "broadcast bar count" });
    const crush = ctx.int("crush.steps", { default: 4, min: 2, max: 12, description: "posterize color steps" });
    const wreck = ctx.float("wreck.amount", { default: 0.45, min: 0, max: 1, step: 0.01, description: "baseline glitch shredding" });
    const burst = ctx.float("wreck.burst", { default: 1.4, min: 0, max: 2, step: 0.05, description: "kick-driven tear burst" });
    const jitter = ctx.float("jitter.split", { default: 0.02, min: 0, max: 0.05, step: 0.001, description: "hats chroma-jitter reach" });
    const ghostAmt = ctx.float("ghost.amount", { default: 0.5, min: 0, max: 1, step: 0.01, description: "echo ghost blend" });
    const ghostDelay = ctx.int("ghost.delay", { default: 12, min: 0, max: 23, description: "ghost distance (frames back)" });
    const strobe = ctx.float("strobe.flash", { default: 0.8, min: 0, max: 1, step: 0.01, description: "negative flash per kick" });

    const kick = ctx.input("kick"); // rack channel: bass onsets → envelope
    const hats = ctx.input("hats"); // rack channel: hi-hat transients
    const tearSig = tear.signal();
    const surgeSig = surge.signal();
    const burstSig = burst.signal();
    const jitterSig = jitter.signal();
    const strobeSig = strobe.signal();

    // Torn-broadcast bed: RGB-fringed bars warped by hat-agitated voronoi cells.
    const bed = osc(ctx, { freq: bars.signal(), sync: 0.4, offset: 0.18 });
    const map = voronoi(ctx, { scale: 7, speed: hats.map((h) => 0.4 + h * 4) });
    const torn = ctx.layer(
      "torn",
      displace(ctx, {
        input: bed,
        map,
        amount: new Signal((f) => tearSig.get(f) + kick.get(f) * surgeSig.get(f)),
      }),
    );

    // Wreckage: poster crush → kick-burst glitch tears → hats jittering the chroma split.
    const crushed = posterize(ctx, { input: torn, steps: crush.signal() });
    const shredded = glitch(ctx, {
      input: crushed,
      amount: wreck.signal(),
      burst: new Signal((f) => kick.get(f) * burstSig.get(f)),
      split: 0.6,
    });
    const fringed = rgbSplit(ctx, {
      input: shredded,
      amount: new Signal((f) => 0.003 + hats.get(f) * jitterSig.get(f)),
    });

    // Haunt: frame-echo ghosts, then the kick strobes the negative. The kick is
    // SQUARED so a decaying hit snaps back to normal instead of sitting at a
    // washed-out half-inversion.
    const haunted = ctx.layer("haunt", echo(ctx, { input: fringed, delay: ghostDelay.signal(), amount: ghostAmt.signal() }));
    return invert(ctx, {
      input: haunted,
      amount: new Signal((f) => {
        const k = kick.get(f);
        return Math.min(1, k * k * strobeSig.get(f));
      }),
    });
  },
});
