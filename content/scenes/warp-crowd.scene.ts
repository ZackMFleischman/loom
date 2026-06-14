import { defineScene, integrateSignal, Signal, type FrameCtx } from "@loom/runtime";
import { bloom } from "../modules/effects/bloom";
import { mixer } from "../modules/effects/mixer";
import { vignette } from "../modules/effects/vignette";
import { bullets } from "../modules/sources/bullets";
import { warpField } from "../modules/sources/warpField";
import { warpGrid } from "../modules/sources/warpGrid";

const TAU = Math.PI * 2;
const COUNT = 30; // crowd size (compile-time)

/** Deterministic per-particle pseudo-random in [0,1). */
const rand = (i: number, k: number) => {
  const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/**
 * The reusable warp-field hook, shown end to end: a crowd of drifting particles
 * is fed — position, velocity AND curl — into a `warpField`, whose displacement
 * texture is handed to `warpGrid({ field })`. The grid bows toward each particle
 * and the lattice trails their motion, all from arbitrary scene data. Swap the
 * crowd for sprinkles, a flock, a fluid sim — anything with positions — and the
 * grid reacts the same way.
 */
export default defineScene({
  name: "warp-crowd",
  description:
    "A drifting particle crowd bends a neon grid through a warpField displacement texture — the reusable hook for feeding any visualization's position/velocity/curl into warpGrid.",
  tags: ["grid", "warp", "field", "particles", "geometry-wars", "neon", "showcase"],
  build(ctx) {
    const cells = ctx.float("grid.cells", { default: 16, min: 4, max: 40, description: "grid density (cells tall)" });
    const fieldAmount = ctx.float("field.amount", { default: 0.16, min: 0, max: 0.5, description: "how far the crowd bends the grid" });
    const fieldGain = ctx.float("field.gain", { default: 3.5, min: 0.5, max: 8, description: "warpField vector gain (dent depth)" });
    const drift = ctx.float("crowd.drift", { default: 1, min: 0, max: 3, description: "crowd drift speed" });
    const velPull = ctx.float("crowd.velPull", { default: 0.12, min: 0, max: 0.6, description: "how much velocity drags the lattice" });
    const dotSize = ctx.float("crowd.dots", { default: 0.014, min: 0, max: 0.05, description: "particle dot size" });
    const bloomAmt = ctx.float("finish.bloom", { default: 0.8, min: 0, max: 2.5, description: "glow strength" });
    const bloomRadius = ctx.float("finish.glow", { default: 22, min: 1, max: 60, description: "glow spread (px)" });
    const vig = ctx.float("finish.vignette", { default: 0.5, min: 0, max: 1, description: "corner darkening" });

    ctx.palette.own(["#05030f", "#1f6dff", "#19f0c8", "#ff2bd6", "#ffe45e"]);

    // Frame-clocked seconds, read once per frame (guarded — integrateSignal
    // accumulates on every pull, so we must not call it from each particle).
    const driftS = drift.signal();
    const clockRaw = integrateSignal(driftS);
    let cFrame = -1;
    let cVal = 0;
    const clock = (f: FrameCtx) => {
      if (f.frame !== cFrame) {
        cFrame = f.frame;
        cVal = clockRaw.get(f);
      }
      return cVal;
    };
    const velPullS = velPull.signal();

    // The crowd: each particle a Lissajous path, so its VELOCITY is the exact
    // analytic derivative — real velocity data fed straight into the field.
    const emitters = Array.from({ length: COUNT }, (_, i) => {
      const ampx = 0.18 + rand(i, 1) * 0.24;
      const ampy = 0.16 + rand(i, 2) * 0.22;
      const wx = 0.3 + rand(i, 3) * 0.7;
      const wy = 0.25 + rand(i, 4) * 0.65;
      const phx = rand(i, 5) * TAU;
      const phy = rand(i, 6) * TAU;
      return {
        x: new Signal((f) => 0.5 + ampx * Math.sin(clock(f) * wx + phx)),
        y: new Signal((f) => 0.5 + ampy * Math.sin(clock(f) * wy + phy)),
        mass: 0.7 + rand(i, 7) * 0.6,
        vx: new Signal((f) => ampx * wx * Math.cos(clock(f) * wx + phx) * velPullS.get(f)),
        vy: new Signal((f) => ampy * wy * Math.cos(clock(f) * wy + phy) * velPullS.get(f)),
        swirl: (rand(i, 8) - 0.5) * 1.4,
        radius: 0.15 + rand(i, 9) * 0.1,
      };
    });

    // The crowd → a displacement field (buffered once via the layer) → the grid.
    const field = ctx.layer("warpfield", warpField(ctx, { emitters, gain: fieldGain.signal() }));
    const grid = ctx.layer(
      "grid",
      warpGrid(ctx, {
        cells: cells.signal(),
        wells: 0, // no autonomous wells — the crowd is the only force
        warp: 1, // the field carries its own scale via fieldAmount
        glow: 0.6,
        energy: 0.9,
        field,
        fieldAmount: fieldAmount.signal(),
      }),
    );

    // Show the particles themselves as glowing dots so you see crowd → dent.
    const dotShots = emitters.map((e) => ({ x: e.x, y: e.y, life: 1 }));
    const dots = ctx.layer(
      "crowd",
      bullets(ctx, { shots: dotShots, length: 0.002, width: dotSize.signal(), colorStop: 2, brightness: 0.85 }),
    );

    const lit = mixer(ctx, { input: grid, b: dots, mode: "screen", mix: 1 });
    const glow = bloom(ctx, { input: lit, level: 0.45, intensity: bloomAmt.signal(), radius: bloomRadius.signal() });
    return vignette(ctx, { input: glow, amount: vig.signal(), radius: 0.66, softness: 0.6 });
  },
});
