import { defineScene, Signal } from "@loom/runtime";
import { mandelbulb } from "../modules/sources/mandelbulb";
import { bloom } from "../modules/effects/bloom";
import { vignette } from "../modules/effects/vignette";

/**
 * An infinite 3D Mandelbulb dive: a distance-estimated fractal raymarched per
 * pixel, its copper-and-gold skin tinted by an orbit trap and lit with glossy
 * highlights, tumbling forever under a ping-pong dolly so the zoom never
 * bottoms out. The kick punches the key light and lurches the dive; the bass
 * inflates the bulb's power so the whole form breathes on the low end.
 *
 * Palette roles (own() boots the look; flip palette.source to retint live):
 * 0 bg/haze (deep blue) · 1 deep crevice · 2/3 copper→gold body · 4 highlight.
 */
export default defineScene({
  name: "mandelbulb",
  description:
    "An infinite raymarched 3D Mandelbulb tumbling through a forever-dive — copper-gold orbit-trap skin, glossy light, kick-punched, bass-breathing.",
  tags: ["fractal", "3d", "raymarch", "mandelbulb", "infinite", "audio-reactive", "showcase"],
  build(ctx) {
    // Dotted paths group the Console: form / dive / look. power & detail stay flat.
    const power = ctx.float("power", { default: 8, min: 2, max: 12, description: "bulb exponent — the headline shape knob" });
    const morph = ctx.float("form.morph", { default: 0.13, min: 0, max: 1, description: "power-breathing rate (surface folds)" });
    const tumble = ctx.float("form.tumble", { default: 0.045, min: 0, max: 0.4, description: "internal roll rate (new structure surfaces)" });
    const spin = ctx.float("dive.spin", { default: 0.04, min: -0.3, max: 0.3, description: "camera orbit speed (rev/sec)" });
    const zoom = ctx.float("dive.zoom", { default: 0.07, min: 0, max: 0.5, description: "dive speed — the ping-pong infinite zoom" });
    const camRadius = ctx.float("dive.radius", { default: 3, min: 1.6, max: 4.5, description: "far camera distance (top of the dive)" });
    const camHeight = ctx.float("dive.height", { default: 0.35, min: -1.5, max: 1.5, description: "camera height above the equator" });
    const detail = ctx.float("look.detail", { default: 0.0016, min: 0.0006, max: 0.004, description: "surface sharpness (lower = finer & costlier)" });
    const glow = ctx.float("look.glow", { default: 1, min: 0, max: 3, description: "crevice halo strength" });
    const light = ctx.float("look.light", { default: 1, min: 0.2, max: 2.5, description: "key-light intensity" });
    const fog = ctx.float("look.fog", { default: 1, min: 0.2, max: 3, description: "depth haze / falloff" });
    const punch = ctx.float("punch", { default: 1, min: 0, max: 3, description: "kick → light/glow/dive reactivity" });
    const bloomAmt = ctx.float("look.bloom", { default: 0.45, min: 0, max: 2, description: "highlight bloom intensity" });
    const vig = ctx.float("look.vignette", { default: 0.6, min: 0, max: 1, description: "corner darkening" });

    // Copper-and-gold over deep blue (the reference Mandelbulb render).
    ctx.palette.own(["#0b1838", "#2a120a", "#9c4f24", "#e0913c", "#ffe6b8"]);

    // Audio: the kick punches the light/glow and lurches the dive; the bass
    // inflates the bulb's power so the form swells on the low end. The rack
    // owns kick/bass detection (R6.4) — we ride the named channels here.
    const kick = ctx.input("kick");
    const bass = ctx.input("bass");
    const punchS = punch.signal();

    // Combine param bases with the live channels into the module's Signals.
    const powerSig = new Signal((f) => power.signal().get(f) + bass.get(f) * 1.6);
    const lightSig = new Signal((f) => light.signal().get(f) + kick.get(f) * punchS.get(f));
    const glowSig = new Signal((f) => glow.signal().get(f) + kick.get(f) * punchS.get(f) * 0.7);
    const zoomSig = new Signal((f) => zoom.signal().get(f) + kick.get(f) * punchS.get(f) * 0.12);

    const bulb = mandelbulb(ctx, {
      power: powerSig,
      morph: morph.signal(),
      tumble: tumble.signal(),
      spin: spin.signal(),
      zoom: zoomSig,
      camRadius: camRadius.signal(),
      camHeight: camHeight.signal(),
      detail: detail.signal(),
      glow: glowSig,
      light: lightSig,
      fog: fog.signal(),
    });

    // Wrap the raymarcher as a grabbable node (rig + per-node FX for free).
    const node = ctx.layer("bulb", bulb);

    // Bloom blooms the gold highlights; vignette frames the dive.
    const bloomed = bloom(ctx, {
      input: node,
      level: 0.72,
      intensity: bloomAmt.signal(),
      radius: 0.55,
    });
    return vignette(ctx, { input: bloomed, amount: vig.signal() });
  },
});
