import { defineScene, Signal, texNode } from "@loom/runtime";
import { smoothstep, uv, vec4 } from "three/tsl";
import { flowerField } from "../modules/geo/flowerField";
import { orbitCam } from "../modules/geo/orbitCam";
import { render3d } from "../modules/sources/render3d";
import { over } from "../modules/effects/over";
import { bloom } from "../modules/effects/bloom";
import { vignette } from "../modules/effects/vignette";

/**
 * A grid of L-system flowers endlessly growing, blooming and fading away over a
 * nature backdrop. Each cell rewrites a slightly different upright grammar into a
 * turtle-drawn plant — glowing stems, sprouting leaves, and petal-fan flower
 * heads with a bright centre — and runs its own staggered grow→bloom→fade
 * lifecycle (the flower shrinks back into the ground, then regrows). The bass
 * leans the wind that sways the tops; the kick flares the bloom. The background
 * is a vertical sky→earth gradient through the global palette (palette.source to
 * retint). A gentle orbit gives the field a little parallax.
 *
 * Palette roles (own() boots a daytime garden; flip palette.source to retint):
 * 0 earth · 1 grass · 2 horizon haze · 3 sky · 4 sky-top.
 */
export default defineScene({
  name: "flower-field",
  description:
    "A grid of L-system flowers (stems/leaves/petal heads) constantly growing, blooming and fading over a palette sky→earth backdrop; bass sways the wind, kick flares the bloom.",
  tags: ["3d", "lsystem", "l-system", "plant", "flower", "garden", "generative", "organic", "audio-reactive", "showcase"],
  build(ctx) {
    const cols = ctx.int("grid.cols", { default: 30, min: 1, max: 200, step: 1, description: "flower columns across the ground (rebuilds)" });
    const rows = ctx.int("grid.rows", { default: 30, min: 1, max: 200, step: 1, description: "flower rows receding into depth (rebuilds)" });
    const seed = ctx.int("grid.seed", { default: 1, min: 1, max: 999, step: 1, description: "re-roll templates & assignment (rebuilds)" });
    const spacing = ctx.float("grid.spacing", { default: 0.34, min: 0.12, max: 0.8, step: 0.01, description: "world gap between plants (rebuilds)" });
    const plantScale = ctx.float("grid.plantScale", { default: 0.5, min: 0.1, max: 1.2, step: 0.01, description: "base plant height (rebuilds)" });
    const budget = ctx.int("grid.budget", { default: 48000, min: 4000, max: 200000, step: 1000, description: "max strokes/frame — nearest plants win (rebuilds)" });
    const rate = ctx.float("life.rate", { default: 0.11, min: 0.01, max: 0.5, step: 0.01, description: "grow→fade lifecycles per second" });
    const wind = ctx.float("life.wind", { default: 0.05, min: 0, max: 0.2, step: 0.005, description: "wind sway at the plant tops" });
    const windOpen = ctx.float("life.windBass", { default: 0.06, min: 0, max: 0.3, step: 0.005, description: "extra bass-driven sway" });
    const width = ctx.float("stroke.width", { default: 0.005, min: 0.002, max: 0.016, step: 0.001, description: "stroke half-thickness" });
    const glowBase = ctx.float("stroke.glow", { default: 1.5, min: 0, max: 4, step: 0.05, description: "stroke emissive base" });
    const punch = ctx.float("glow.punch", { default: 1, min: 0, max: 3, step: 0.05, description: "kick flare on the glow" });
    const camSpeed = ctx.float("cam.speed", { default: 0.015, min: -0.5, max: 0.5, step: 0.01, description: "orbit speed" });
    const camRadius = ctx.float("cam.radius", { default: 2.6, min: 0.5, max: 12, step: 0.05, description: "camera distance behind the near edge (live)" });
    const camHeight = ctx.float("cam.height", { default: 2.4, min: 0.2, max: 8, step: 0.05, description: "camera height above the ground (live)" });
    const camDepth = ctx.float("cam.depth", { default: 6, min: 0, max: 16, step: 0.1, description: "how far down the field the camera aims (rebuilds)" });
    const skyGlow = ctx.float("bg.skyGlow", { default: 0.3, min: 0, max: 1, step: 0.01, description: "soft brightening of the upper sky" });
    const bloomLevel = ctx.float("finish.bloom", { default: 0.45, min: 0, max: 1, step: 0.01, description: "bloom threshold" });
    const bloomGlow = ctx.float("finish.glow", { default: 0.7, min: 0, max: 2, step: 0.05, description: "bloom intensity" });
    const vig = ctx.float("finish.vignette", { default: 0.5, min: 0, max: 1, step: 0.01, description: "corner darkening" });

    // Sky→earth backdrop through the global palette (stops bottom→top).
    ctx.palette.own(["#1d3a22", "#3e7d3a", "#caa978", "#5b86b3", "#bcd9f0"]);
    const skyGlowU = ctx.uniformOf(skyGlow.signal());
    const yy = uv().y.oneMinus(); // uv.y is 1 at screen bottom here — flip so earth sits low, sky high
    const ramp = ctx.palette.ramp(yy);
    const lift = smoothstep(0.55, 1.0, yy).mul(skyGlowU);
    const background = texNode(vec4(ramp.rgb.add(ramp.rgb.mul(lift)), 1));

    const kick = ctx.input("kick");
    const bass = ctx.input("bass");

    // Wind = base sway + bass opening; glow flares on the kick.
    const windBase = wind.signal();
    const windOpenS = windOpen.signal();
    const windSig = new Signal((f) => windBase.get(f) + bass.get(f) * windOpenS.get(f));
    const glowBaseS = glowBase.signal();
    const punchS = punch.signal();
    const glowSig = new Signal((f) => glowBaseS.get(f) + kick.get(f) * punchS.get(f));

    const flowers = flowerField(ctx, {
      cols: cols.value,
      rows: rows.value,
      seed: seed.value,
      spacing: spacing.value,
      plantScale: plantScale.value,
      maxSegments: budget.value,
      rate: rate.signal(),
      wind: windSig,
      width: width.signal(),
      glow: glowSig,
    });

    // Low, forward-looking camera so the grid recedes as a perspective ground.
    const field = render3d(ctx, {
      world: [flowers],
      cam: orbitCam(ctx, {
        radius: camRadius.signal(),
        height: camHeight.signal(),
        speed: camSpeed.signal(),
        target: [0, 0.0, -camDepth.value], // aim DOWN at the ground so the field sweeps the lower frame
        fov: 64,
      }),
    });

    // Composite the glowing flowers over the nature backdrop, then finish.
    const composited = over(ctx, { input: background, overlay: ctx.layer("garden", field) });
    const glow = bloom(ctx, { input: composited, level: bloomLevel.signal(), intensity: bloomGlow.signal() });
    return vignette(ctx, { input: glow, amount: vig.signal() });
  },
});
