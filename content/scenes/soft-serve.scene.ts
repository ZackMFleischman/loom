import { Signal, defineScene } from "@loom/runtime";
import { parseHex } from "../modules/_shared";
import { lfo } from "../modules/control/lfo";
import { bloom } from "../modules/effects/bloom";
import { over } from "../modules/effects/over";
import { vignette } from "../modules/effects/vignette";
import { levels } from "../modules/effects/levels";
import { gradient } from "../modules/sources/gradient";
import { softServe } from "../modules/sources/softServe";
import { sprinkles } from "../modules/sources/sprinkles";
import { wafffleCone } from "../modules/sources/wafffleCone";

// Shared layout: the cone mouth, swirl base and tip all line up so the pieces
// stack into one ice cream. Passed to every module that draws on the swirl.
const BASE_Y = 0.34; // swirl base / cone mouth
const TIP_Y = 0.82; // swirl tip
const CONE_POINT = 0.03; // bottom of the cone
const SWAY = 0.03; // swirl axis sway — shared so sprinkles land on the cream

/**
 * A vanilla soft-serve cone that's constantly getting more cream added: the
 * swirl's coil bands climb forever while a dispenser ribbon pours onto the
 * hooked peak, sitting in a golden waffle cone. Candy sprinkles get tossed in
 * from every angle on kick bursts and a beat cadence, landing on the cream and
 * sticking as it spirals up. The cream color is a live color-chooser param.
 */
export default defineScene({
  name: "soft-serve",
  description:
    "A vanilla soft-serve swirl forever spiraling up in a waffle cone, sprinkles tossed in from all angles that land and stick, over an ice-cream backdrop.",
  tags: ["ice-cream", "vanilla", "swirl", "particles", "audio-reactive"],
  build(ctx) {
    // Params — grouped cream / cone / sprinkles / bg / finish.
    const colP = ctx.manifest.color("cream.color", { default: "#f6e7a8", description: "soft-serve cream color (the chooser) — vanilla by default" });
    const thickness = ctx.float("cream.thickness", { default: 0.3, min: 0.16, max: 0.44, description: "swirl width (fatter = thicker soft serve)" });
    const coils = ctx.float("cream.coils", { default: 4, min: 2, max: 9, description: "coil wraps up the pile (fewer = chunkier)" });
    const flow = ctx.float("cream.flow", { default: 0.4, min: -1.5, max: 1.5, description: "coil climb speed — cream perpetually spiraling up (negative reverses)" });
    const hook = ctx.float("cream.hook", { default: 0.1, min: -0.25, max: 0.25, description: "tip lean — the floppy soft-serve peak" });
    const ridge = ctx.float("cream.ridge", { default: 0.5, min: 0, max: 1, description: "coil bulge depth (0 = smooth)" });
    const gloss = ctx.float("cream.gloss", { default: 0.7, min: 0, max: 2, description: "sheen on each coil crest" });
    const stream = ctx.float("cream.stream", { default: 0.6, min: 0, max: 1, description: "dispenser ribbon pouring onto the tip" });
    const wobble = ctx.float("cream.wobble", { default: 0.5, min: 0, max: 2, description: "how hard the bass shivers the cream" });
    const coneW = ctx.float("cone.width", { default: 0.26, min: 0.12, max: 0.38, description: "cone mouth width" });
    const waffle = ctx.float("cone.waffle", { default: 0.6, min: 0, max: 1, description: "waffle cross-hatch strength" });
    const amount = ctx.float("sprinkles.amount", { default: 22, min: 0, max: 44, description: "baseline sprinkles stuck on the cream" });
    const burstP = ctx.float("sprinkles.burst", { default: 14, min: 0, max: 30, description: "extra sprinkles flung per kick" });
    const sprSize = ctx.float("sprinkles.size", { default: 0.018, min: 0.006, max: 0.05, description: "sprinkle rod length" });
    const cadence = ctx.float("sprinkles.cadence", { default: 0.4, min: 0.05, max: 1.5, description: "toss/re-throw cadence (per sec)" });
    const bgTone = ctx.float("bg.tone", { default: 0.6, min: 0, max: 1, description: "backdrop brightness" });
    const glow = ctx.float("finish.bloom", { default: 0.45, min: 0, max: 2, description: "glow on sprinkles and sheen" });
    const vig = ctx.float("finish.vignette", { default: 0.6, min: 0, max: 1, description: "corner darkening (makes the cone pop)" });

    // Parlor palette: cocoa bg · waffle edge · cream cores · vanilla accent.
    ctx.palette.own(["#2a1c14", "#7a4a26", "#f6e7c0", "#f4d79a", "#fff3d6"]);

    // Input rack channels.
    const kick = ctx.input("kick"); // bass onsets → punchy envelope
    const bass = ctx.input("bass"); // sustained low-end weight

    // Cream color chooser → three channel signals (parsed once per change).
    let hex = "";
    let rgb: [number, number, number] = [1, 1, 1];
    const chan = (i: 0 | 1 | 2) =>
      new Signal(() => {
        if (colP.value !== hex) {
          hex = colP.value;
          rgb = parseHex(hex);
        }
        return rgb[i];
      });
    const tint = [chan(0), chan(1), chan(2)] as const;

    // Backdrop: a soft radial cream wash, dimmed so the cone reads.
    const bg = levels(ctx, {
      input: gradient(ctx, { mode: "radial", scroll: 0.012, repeat: 1.3 }),
      gain: bgTone.signal(),
    });

    // The cone.
    const cone = ctx.layer("cone", wafffleCone(ctx, {
      topY: BASE_Y,
      pointY: CONE_POINT,
      width: coneW.signal(),
      waffle: waffle.signal(),
    }));

    // The swirl — bass shivers it, kick gives a small jolt.
    const wobSig = wobble.signal();
    const shiver = new Signal((f) => bass.get(f) * wobSig.get(f) + kick.get(f) * 0.3);
    const widthSig = thickness.signal();
    const flowSig = flow.signal();
    const hookSig = hook.signal();
    const swirl = ctx.layer("cream", softServe(ctx, {
      tint,
      baseY: BASE_Y,
      tipY: TIP_Y,
      width: widthSig,
      coils: coils.signal(),
      flow: flowSig,
      sway: SWAY,
      hook: hookSig,
      ridge: ridge.signal(),
      gloss: gloss.signal(),
      stream: stream.signal(),
      energy: shiver,
    }));

    // Sprinkles: kick bursts + a slow beat cadence wave set how many fly; they
    // land on the SAME swirl surface (matching geometry) and stick.
    const amountSig = amount.signal();
    const burstSig = burstP.signal();
    const wave = lfo(ctx, { shape: "sine", periodBeats: 4 });
    const flying = new Signal(
      (f) => amountSig.get(f) * (0.5 + 0.5 * wave.get(f)) + kick.get(f) * burstSig.get(f),
    );
    const storm = ctx.layer("toppings", sprinkles(ctx, {
      count: flying,
      size: sprSize.signal(),
      cadence: cadence.signal(),
      burst: kick,
      baseY: BASE_Y,
      tipY: TIP_Y,
      width: widthSig,
      sway: SWAY,
      hook: hookSig,
      flow: flowSig,
    }));

    // Stack: backdrop → cone → swirl → sprinkles, then finish.
    const onCone = over(ctx, { input: bg, overlay: cone });
    const piled = over(ctx, { input: onCone, overlay: swirl });
    const topped = over(ctx, { input: piled, overlay: storm });
    const lit = bloom(ctx, { input: topped, level: 0.7, intensity: glow.signal(), radius: 16 });
    return vignette(ctx, { input: lit, amount: vig.signal(), radius: 0.8 });
  },
});
