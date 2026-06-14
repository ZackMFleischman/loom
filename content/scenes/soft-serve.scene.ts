import { Signal, defineScene, texNode } from "@loom/runtime";
import { vec4 } from "three/tsl";
import { parseHex } from "../modules/_shared";
import { lfo } from "../modules/control/lfo";
import { bloom } from "../modules/effects/bloom";
import { over } from "../modules/effects/over";
import { vignette } from "../modules/effects/vignette";
import { softServe } from "../modules/sources/softServe";
import { sprinkles } from "../modules/sources/sprinkles";
import { waffleCone } from "../modules/sources/waffleCone";

// Shared layout: the cone mouth, swirl base and tip all line up so the pieces
// stack into one ice cream. Passed to every module that draws on the swirl.
const BASE_Y = 0.42; // swirl base / cone mouth (screen-mid)
const TIP_Y = 0.86; // swirl tip (near the top)
const CONE_POINT = 0.05; // bottom tip of the cone (near the bottom)
const BASE_DIP = 0.05; // how far the cream's rounded base sinks into the cone mouth
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
    const flow = ctx.float("cream.flow", { default: -0.4, min: -1.5, max: 1.5, description: "coil flow speed — cream spiraling down into the cone (positive reverses, climbs up)" });
    const hook = ctx.float("cream.hook", { default: 0.1, min: -0.25, max: 0.25, description: "tip lean — the floppy soft-serve peak" });
    const ridge = ctx.float("cream.ridge", { default: 0.6, min: 0, max: 1, description: "coil bulge depth (0 = smooth)" });
    const gloss = ctx.float("cream.gloss", { default: 0.8, min: 0, max: 2, description: "sheen on each coil crest" });
    const stream = ctx.float("cream.stream", { default: 0.6, min: 0, max: 1, description: "dispenser ribbon pouring onto the tip" });
    const wobble = ctx.float("cream.wobble", { default: 0.5, min: 0, max: 2, description: "how hard the bass shivers the cream" });
    const coneW = ctx.float("cone.width", { default: 0.26, min: 0.12, max: 0.38, description: "cone mouth width" });
    const waffle = ctx.float("cone.waffle", { default: 0.6, min: 0, max: 1, description: "waffle cross-hatch strength" });
    const mouth = ctx.float("cone.mouth", { default: 0.32, min: 0.08, max: 0.5, description: "mouth foreshortening — how open/round the 3D cone bowl reads" });
    const amount = ctx.float("sprinkles.amount", { default: 22, min: 0, max: 44, description: "baseline sprinkles stuck on the cream" });
    const burstP = ctx.float("sprinkles.burst", { default: 14, min: 0, max: 30, description: "extra sprinkles flung per kick" });
    const sprSize = ctx.float("sprinkles.size", { default: 0.018, min: 0.006, max: 0.05, description: "sprinkle rod length" });
    const cadence = ctx.float("sprinkles.cadence", { default: 0.4, min: 0.05, max: 1.5, description: "toss/re-throw cadence (per sec)" });
    const bgTone = ctx.float("bg.tone", { default: 0.35, min: 0, max: 1, description: "backdrop brightness (flat dark wash)" });
    const glow = ctx.float("finish.bloom", { default: 0.3, min: 0, max: 2, description: "glow on sprinkles and sheen" });
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

    // Backdrop: a flat dark cocoa wash (palette bg stop) so the cone pops — no
    // distracting radial circle.
    const bgU = ctx.uniformOf(bgTone.signal());
    const bg = texNode(vec4(ctx.palette.color(0).mul(bgU), 1));

    // The cone.
    const cone = ctx.layer("cone", waffleCone(ctx, {
      topY: BASE_Y,
      pointY: CONE_POINT,
      width: coneW.signal(),
      waffle: waffle.signal(),
      mouth: mouth.signal(),
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
      baseDip: BASE_DIP,
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

    // Stack: backdrop → cone → swirl → sprinkles. The solid cone sits behind the
    // cream; the cream's rounded base sinks into the mouth and its skirt overhangs
    // the rim, while the cone's bright near lip shows in front below the cream —
    // the swirl reads as sitting DOWN INSIDE the cone.
    const onCone = over(ctx, { input: bg, overlay: cone });
    const piled = over(ctx, { input: onCone, overlay: swirl });
    const topped = over(ctx, { input: piled, overlay: storm });
    const lit = bloom(ctx, { input: topped, level: 0.7, intensity: glow.signal(), radius: 16 });
    return vignette(ctx, { input: lit, amount: vig.signal(), radius: 0.8 });
  },
});
