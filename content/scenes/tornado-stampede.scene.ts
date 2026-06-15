import { defineScene, Signal } from "@loom/runtime";
import { bloom } from "../modules/effects/bloom";
import { over } from "../modules/effects/over";
import { vignette } from "../modules/effects/vignette";
import { gradient } from "../modules/sources/gradient";
import { render3d } from "../modules/sources/render3d";
import { hippoVortex } from "../modules/geo/hippoVortex";
import { mediaFsUrl } from "../modules/geo/model";
import { orbitCam } from "../modules/geo/orbitCam";
import { tornado } from "../modules/geo/tornado";

// One 3D hippo model (cloned across the 3D slots) plus the five flat hippo
// sprites billboarded across the 2D slots — a mixed herd caught in the funnel.
const HIPPO_FBX = mediaFsUrl(0, "3DModels/Hippo3D/Hippopotamus 3D Model.fbx");
const HIPPO_SPRITES = [1, 2, 3, 4, 5].map(
  (i) => new URL(`../assets/hippos/hippo${i}.png`, import.meta.url).href,
);

const MAX_HIPPOS = 96; // the hippos.count slider ceiling (baked pool size)

/**
 * A literal tornado of particles — a debris-storm funnel of dust, sparks and
 * tumbling chunks spinning up a vortex — with a herd of hippos swirling around
 * it: instanced 3D hippo clones AND billboarded 2D hippo sprites, all spiralling
 * and climbing through the column. Kick punches the key light and surges the
 * storm; bass swells the spin. Slide hippos.count up to fill the sky with hippos.
 */
export default defineScene({
  name: "tornado-stampede",
  description:
    "A literal debris-storm tornado of particles with a swirling herd of hippos (instanced 3D clones + 2D billboard sprites) climbing the vortex; kick surges the storm.",
  tags: ["3d", "tornado", "vortex", "particles", "hippo", "storm", "audio-reactive", "showcase"],
  build(ctx) {
    // --- Funnel ---
    const height = ctx.float("funnel.height", { default: 2.6, min: 0.5, max: 6, description: "funnel height (world units)" });
    const topR = ctx.float("funnel.topRadius", { default: 1.1, min: 0.1, max: 3, description: "radius at the wide mouth" });
    const baseR = ctx.float("funnel.baseRadius", { default: 0.12, min: 0, max: 1.5, description: "radius at the narrow base" });
    const spinSpeed = ctx.float("spin.speed", { default: 0.7, min: -3, max: 3, description: "vortex spin speed — the debris AND the hippos rotate together" });
    const rise = ctx.float("funnel.rise", { default: 0.2, min: 0, max: 1, description: "how fast particles climb + recycle" });
    const surge = ctx.float("funnel.surge", { default: 1.4, min: 0, max: 4, description: "how hard the kick flares the storm" });

    // --- Particle species sizes ---
    const dustSize = ctx.float("dust.size", { default: 0.018, min: 0.004, max: 0.08, description: "dust-mote size" });
    const sparkSize = ctx.float("spark.size", { default: 0.03, min: 0.006, max: 0.1, description: "spark-fleck size" });
    const debrisSize = ctx.float("debris.size", { default: 0.05, min: 0.01, max: 0.16, description: "debris-chunk size" });

    // --- Hippos ---
    const hippoCount = ctx.float("hippos.count", { default: 18, min: 0, max: MAX_HIPPOS, step: 1, description: "how many hippos swirl in the storm" });
    const hippoSize = ctx.float("hippos.size", { default: 0.6, min: 0.1, max: 2, description: "hippo size" });
    const orbitRadius = ctx.float("orbit.radius", { default: 1.4, min: 0.2, max: 4, description: "herd orbit radius" });
    const orbitRise = ctx.float("orbit.rise", { default: 0.13, min: 0, max: 1, description: "how fast hippos climb + recycle" });

    // --- Camera + finish ---
    const camSpeed = ctx.float("cam.speed", { default: 0.18, min: -2, max: 2, description: "orbit speed (rad/s)" });
    const camRadius = ctx.float("cam.radius", { default: 4, min: 1.5, max: 9, description: "camera distance" });
    const camHeight = ctx.float("cam.height", { default: 0.5, min: -2, max: 3, description: "camera height" });
    const punch = ctx.float("punch", { default: 1, min: 0, max: 3, description: "kick-driven key-light punch" });
    const bloomAmt = ctx.float("finish.bloom", { default: 0.85, min: 0, max: 2.5, description: "glow strength" });
    const bloomRadius = ctx.float("finish.glow", { default: 22, min: 1, max: 60, description: "glow spread (px)" });
    const vig = ctx.float("finish.vignette", { default: 0.55, min: 0, max: 1, description: "corner darkening" });

    // Stormy sky → dust palette (bg · edge · core · core · accent).
    ctx.palette.own(["#0a0712", "#241a2e", "#5b4a63", "#b89a7a", "#ffe6a8"]);

    const kick = ctx.input("kick");
    const bass = ctx.input("bass");
    const surgeS = surge.signal();
    const punchS = punch.signal();
    // One spin law for the whole storm: the debris and the hippos read off this
    // exact signal (bass swells it), so the herd stays locked to the funnel.
    const spinS = spinSpeed.signal();
    const vortexSpin = new Signal((f) => spinS.get(f) * (1 + bass.get(f) * 0.6));

    // The vortex of debris.
    const funnel = tornado(ctx, {
      height: height.signal(),
      topRadius: topR.signal(),
      baseRadius: baseR.signal(),
      swirl: vortexSpin,
      rise: rise.signal(),
      surge: new Signal((f) => kick.get(f) * surgeS.get(f)),
      dustSize: dustSize.signal(),
      sparkSize: sparkSize.signal(),
      debrisSize: debrisSize.signal(),
    });

    // The herd caught in it.
    const herd = hippoVortex(ctx, {
      url: HIPPO_FBX,
      spriteUrls: HIPPO_SPRITES,
      maxCount: MAX_HIPPOS,
      count: hippoCount.signal(),
      modelRatio: 0.4,
      radius: orbitRadius.signal(),
      height: height.signal(),
      swirl: vortexSpin,
      rise: orbitRise.signal(),
      size: hippoSize.signal(),
    });

    const stage = ctx.layer(
      "storm3d",
      render3d(ctx, {
        world: [funnel, herd],
        cam: orbitCam(ctx, { radius: camRadius.signal(), height: camHeight.signal(), speed: camSpeed.signal() }),
        ambient: 0.8,
        key: new Signal((f) => 1.6 + kick.get(f) * punchS.get(f)),
      }),
    );

    // Stormy radial backdrop behind the transparent 3D render.
    const sky = ctx.layer("sky", gradient(ctx, { mode: "radial", repeat: 1.2, scroll: 0.01 }));
    const comp = over(ctx, { input: sky, overlay: stage });

    const glow = bloom(ctx, { input: comp, level: 0.55, intensity: bloomAmt.signal(), radius: bloomRadius.signal() });
    return vignette(ctx, { input: glow, amount: vig.signal(), radius: 0.7, softness: 0.6 });
  },
});
