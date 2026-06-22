import { Signal, defineScene, integrateSignal } from "@loom/runtime";
import { feedback } from "../modules/effects/feedback";
import { bloom } from "../modules/effects/bloom";
import { over } from "../modules/effects/over";
import { transform } from "../modules/effects/transform";
import { vignette } from "../modules/effects/vignette";
import { poiHeads } from "../modules/sources/poiHeads";
import { MANEUVERS, poiSequencer } from "../modules/poi/maneuvers";
import { poiMotion } from "../modules/poi/motion";

/**
 * Glow poi: two glowing orbs on strings flowing through 44 poi maneuvers —
 * weaves into windmills into flowers into stalls into comets — with light-trail
 * after-images. Transitions are smooth by construction (the motion engine
 * integrates phase and eases every target; see content/modules/poi/).
 *
 * `flow.auto` walks the transition graph on the beat; turn it off and ride
 * `flow.maneuver` to pick a move by hand. `look.mode` morphs glow → fire →
 * sparkler. Stage 3/4 of the build: every feel control is a param here.
 */
export default defineScene({
  name: "glow-poi",
  description:
    "Two glowing tethered orbs flow through 44 poi maneuvers (weaves, flowers, windmills, stalls, comets) with light trails — auto-sequenced through a transition graph or hand-picked; glow/fire/sparkler looks.",
  tags: ["poi", "flow", "trails", "generative", "audio-reactive", "showcase"],
  build(ctx) {
    // ── Palette: bg · edge/string · core A · core B · accent ──
    ctx.palette.own(["#05030e", "#1b4dff", "#2ee6ff", "#ff3ca6", "#ffd36b"]);

    // ── Flow / sequencing ──
    const maneuver = ctx.int("flow.maneuver", { default: 0, min: 0, max: MANEUVERS.length - 1, description: "maneuver (when auto is off)" });
    const auto = ctx.bool("flow.auto", { default: true, description: "walk the transition graph automatically" });
    const hold = ctx.float("flow.hold", { default: 8, min: 1, max: 32, description: "beats per maneuver in auto" });
    const morph = ctx.float("flow.morph", { default: 0.55, min: 0.05, max: 2, description: "transition smoothness (seconds)" });
    const speed = ctx.float("flow.speed", { default: 0.32, min: 0.02, max: 1.2, description: "spin speed (rev/sec)" });
    const scale = ctx.float("flow.scale", { default: 0.85, min: 0.3, max: 1.4, description: "pattern size" });

    // ── Look ──
    const headSize = ctx.float("head.size", { default: 0.05, min: 0.012, max: 0.14, description: "orb radius" });
    const tether = ctx.float("head.tether", { default: 0.011, min: 0, max: 0.05, description: "string thickness (0 = none)" });
    const glow = ctx.float("look.glow", { default: 1.1, min: 0, max: 3, description: "overall brightness" });
    const mode = ctx.int("look.mode", { default: 0, min: 0, max: 2, description: "0 glow · 1 fire · 2 sparkler" });
    const spark = ctx.float("look.spark", { default: 1, min: 0, max: 3, description: "sparkler crackle density" });
    const spinner = ctx.float("look.spinner", { default: 0.15, min: 0, max: 1, description: "faint spinner-body glow at the pivot" });

    // ── Trails ──
    const trail = ctx.float("trail.amount", { default: 0.9, min: 0, max: 0.985, description: "light-trail persistence (0 = off)" });
    const drift = ctx.float("trail.drift", { default: 1.0, min: 0.985, max: 1.03, description: "trail zoom drift" });

    // ── Camera ──
    const camZoom = ctx.float("cam.zoom", { default: 1, min: 0.5, max: 1.8, description: "camera zoom" });
    const camSpin = ctx.float("cam.spin", { default: 0, min: -0.3, max: 0.3, description: "camera roll (rev/sec)" });
    const camTilt = ctx.float("cam.tilt", { default: 1, min: 0.2, max: 1, description: "lean toward the wheel plane (squash)" });

    // ── Finish ──
    const bloomLevel = ctx.float("finish.bloom", { default: 0.25, min: 0, max: 1, description: "glow threshold" });
    const bloomInt = ctx.float("finish.glow", { default: 1.1, min: 0, max: 3, description: "glow intensity" });
    const vig = ctx.float("finish.vignette", { default: 0.6, min: 0, max: 1, description: "corner darkening" });
    const punch = ctx.float("punch", { default: 0.8, min: 0, max: 3, description: "kick flare strength" });

    // ── World ──
    const kick = ctx.input("kick");
    const bass = ctx.input("bass");

    const idx = poiSequencer({
      beats: ctx.time.beats,
      auto: auto.signal().map((b) => (b ? 1 : 0)),
      manual: maneuver.signal(),
      holdBeats: hold.signal(),
    });

    const scaleSig = scale.signal();
    const bassSwell = new Signal((f) => scaleSig.get(f) * (1 + bass.get(f) * 0.12));

    const motion = poiMotion({
      index: idx,
      beats: ctx.time.beats,
      speed: speed.signal(),
      scale: bassSwell,
      morph: morph.signal(),
      tiltBias: camTilt.signal(),
    });

    // Kick flares the orbs.
    const glowSig = glow.signal();
    const punchSig = punch.signal();
    const headGlow = new Signal((f) => glowSig.get(f) * (1 + kick.get(f) * punchSig.get(f)));

    // Only the ORBS leave light-trails — drawn alone and run through feedback.
    const orbs = poiHeads(ctx, {
      heads: motion.heads,
      size: headSize.signal(),
      glow: headGlow,
      mode: mode.signal(),
      spark: spark.signal(),
      colorStops: [2, 3],
      parts: "heads",
    });

    // Light trails: maneuver trail-bias nudges the persistence, kick lengthens it a touch.
    const trailSig = trail.signal();
    const trailAmt = new Signal((f) =>
      Math.min(0.985, Math.max(0, trailSig.get(f) + (motion.trailBias.get(f) - 0.5) * 0.12 + kick.get(f) * 0.02)),
    );
    const trails = ctx.layer("flow", feedback(ctx, { input: orbs, amount: trailAmt, zoom: drift.signal() }));

    // The strings + pivot are drawn FRESH each frame (no trail) over the trailed orbs.
    const rig = poiHeads(ctx, {
      heads: motion.heads,
      hands: motion.hands,
      pivot: motion.pivot,
      size: headSize.signal(),
      tether: tether.signal(),
      glow: headGlow,
      mode: mode.signal(),
      spinner: spinner.signal(),
      colorStops: [2, 3],
      parts: "rig",
    });
    const composed = over(ctx, { input: trails, overlay: rig });

    // Camera + finish.
    const camSpinSig = camSpin.signal();
    const camAngle = integrateSignal(new Signal((f) => camSpinSig.get(f) * Math.PI * 2));
    const framed = transform(ctx, { input: composed, scale: camZoom.signal(), rotate: camAngle });
    const bloomIntSig = bloomInt.signal();
    const bloomSig = new Signal((f) => bloomIntSig.get(f) * (1 + kick.get(f) * punchSig.get(f) * 0.5));
    const lit = bloom(ctx, { input: framed, level: bloomLevel.signal(), intensity: bloomSig, radius: 1.1 });
    return vignette(ctx, { input: lit, amount: vig.signal() });
  },
});
