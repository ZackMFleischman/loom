import { Signal, defineScene } from "@loom/runtime";
import { lfo } from "../modules/control/lfo";
import { bloom } from "../modules/effects/bloom";
import { crt } from "../modules/effects/crt";
import { neon } from "../modules/effects/neon";
import { over } from "../modules/effects/over";
import { vignette } from "../modules/effects/vignette";
import { shape } from "../modules/sources/shape";
import { solid } from "../modules/sources/solid";
import { text } from "../modules/sources/text";

// Deterministic 0..1 hash (no Math.random — fixture replays must stay byte-identical).
const hash = (n: number) => {
  const x = Math.sin(n * 78.233) * 43758.5453;
  return x - Math.floor(x);
};

export default defineScene({
  name: "neon-pho",
  description:
    "A night-market neon sign: a glowing PHỞ wordmark over a cyan bowl with amber steam rising, buzzing and dropping out like failing neon, surging on the kick behind warm CRT glass.",
  tags: ["neon", "sign", "text", "bloom", "crt", "pho", "audio-reactive"],
  build(ctx) {
    const pal = ctx.palette;
    // bg · cyan tube · pink core · amber steam · hot-pink accent
    pal.own(["#080510", "#27e3ff", "#ff63b4", "#ffc24a", "#ff2d7e"]);

    const size = ctx.float("sign.size", { default: 0.32, min: 0.1, max: 1, description: "PHỞ wordmark scale" });
    const lift = ctx.float("sign.lift", { default: 0.15, min: -0.45, max: 0.45, description: "wordmark vertical offset (+ up)" });
    const glow = ctx.float("glow.intensity", { default: 0.85, min: 0, max: 3, description: "base neon tube brightness" });
    const surge = ctx.float("glow.surge", { default: 0.6, min: 0, max: 3, description: "kick-driven brightness surge" });
    const flickerAmt = ctx.float("glow.flicker", { default: 0.6, min: 0, max: 1, description: "failing-neon flicker depth (0 = rock steady)" });
    const bowlGlow = ctx.float("bowl.intensity", { default: 1, min: 0, max: 3, description: "bowl ring brightness" });
    const bowlSize = ctx.float("bowl.size", { default: 0.16, min: 0.05, max: 0.4, description: "bowl ring radius" });
    const steamLevel = ctx.float("steam.intensity", { default: 0.85, min: 0, max: 3, description: "rising steam brightness" });
    const steamRise = ctx.float("steam.rise", { default: 0.22, min: 0, max: 0.4, description: "how far steam climbs" });
    const bloomLevel = ctx.float("bloom.level", { default: 0.45, min: 0, max: 1, description: "glow threshold" });
    const bloomAmt = ctx.float("bloom.intensity", { default: 0.7, min: 0, max: 4, description: "halo strength" });
    const bloomRad = ctx.float("bloom.radius", { default: 14, min: 0, max: 48, description: "halo spread (px)" });
    const scan = ctx.float("glass.scan", { default: 0.22, min: 0, max: 1, description: "CRT scanline darkness" });
    const curve = ctx.float("glass.curve", { default: 0.1, min: 0, max: 0.5, description: "CRT barrel curvature" });
    const wallLevel = ctx.float("wall.level", { default: 1, min: 0, max: 2, description: "back-wall brightness" });

    const kick = ctx.input("kick");

    // Electric flicker: a fast hum ripple plus rare full dropouts (failing tube).
    const now = ctx.time.now;
    const flickRaw = new Signal((f) => {
      const t = now.get(f);
      const buzz = 0.9 + 0.1 * Math.sin(t * 46);
      const drop = hash(Math.floor(t * 6.3)) > 0.9 ? 0.15 : 1; // ~10% of windows blink out
      return Math.max(0, buzz * drop);
    });
    const flickAmtSig = flickerAmt.signal();
    // Blend toward steady by flicker depth: 1 = full flicker, 0 = constant on.
    const flicker = new Signal((f) => 1 - flickAmtSig.get(f) * (1 - flickRaw.get(f)));

    const glowSig = glow.signal();
    const surgeSig = surge.signal();
    const intensity = new Signal((f) => glowSig.get(f) * (1 + kick.get(f) * surgeSig.get(f)));

    // Back wall — near-black warm void.
    const wall = solid(ctx, { paletteStop: 0, level: wallLevel.signal() });

    // The PHỞ wordmark, hot-pink tube.
    const word = ctx.layer(
      "logo",
      neon(ctx, {
        input: text(ctx, { text: "PHỞ", weight: 900, tracking: 0.04, transform: { scale: size.signal(), y: lift.signal() } }),
        intensity,
        flicker,
        bodyStop: 4,
      }),
    );

    // The bowl: a cyan rim ring with a thin broth line inside, upper-middle.
    // NOTE: shape() uses y-down (cy from top); text() uses y-up (lift). Steam
    // rises = decreasing shape-y toward the top of the frame.
    const bowlY = 0.06;
    const bowlSizeSig = bowlSize.signal();
    const bowlMask = over(ctx, {
      input: shape(ctx, { kind: "ring", radius: bowlSizeSig, thickness: 0.028, soft: 0.012, x: 0.5, y: 0.5 + bowlY }),
      overlay: shape(ctx, {
        kind: "ring",
        radius: new Signal((f) => bowlSizeSig.get(f) * 0.6),
        thickness: 0.016,
        soft: 0.012,
        x: 0.5,
        y: 0.5 + bowlY,
      }),
    });
    const bowlGlowSig = bowlGlow.signal();
    const bowl = ctx.layer(
      "bowl",
      neon(ctx, { input: bowlMask, intensity: new Signal((f) => intensity.get(f) * bowlGlowSig.get(f)), flicker, bodyStop: 1 }),
    );

    // Three amber steam puffs rising and dissipating above the bowl.
    const steamLevelSig = steamLevel.signal();
    const riseSig = steamRise.signal();
    let frame = over(ctx, { input: over(ctx, { input: wall, overlay: bowl }), overlay: word });
    const STEAM = 5;
    for (let i = 0; i < STEAM; i++) {
      const ph = lfo(ctx, { shape: "saw", periodBeats: 6 + i * 1.6 });
      // Steam wisps climb out of the bowl rim, swaying, and dissipate as they rise.
      const col = (i - (STEAM - 1) / 2) * 0.05;
      const x = new Signal((f) => 0.5 + col + Math.sin(ph.get(f) * Math.PI * 2.5 + i) * 0.03 * ph.get(f));
      const y = new Signal((f) => 0.5 + bowlY - bowlSizeSig.get(f) - 0.02 - ph.get(f) * riseSig.get(f));
      const fade = new Signal((f) => {
        const p = ph.get(f);
        return Math.sin(Math.PI * p) * steamLevelSig.get(f) * intensity.get(f);
      });
      const puff = shape(ctx, { kind: "circle", radius: 0.01, soft: 0.05, x, y });
      frame = over(ctx, { input: frame, overlay: neon(ctx, { input: puff, intensity: fade, flicker, bodyStop: 3 }) });
    }

    // Bloom the whole sign into a storefront halo, then warm CRT glass.
    const glassed = crt(ctx, {
      input: bloom(ctx, { input: frame, level: bloomLevel.signal(), intensity: bloomAmt.signal(), radius: bloomRad.signal() }),
      scan: scan.signal(),
      curve: curve.signal(),
      aberration: 0.3,
    });
    return vignette(ctx, { input: glassed, amount: 0.6, radius: 0.8, softness: 0.6 });
  },
});
