import { defineScene, Signal, type FrameCtx } from "@loom/runtime";
import { bloom } from "../modules/effects/bloom";
import { over } from "../modules/effects/over";
import { vignette } from "../modules/effects/vignette";
import { image } from "../modules/sources/image";
import { warpField } from "../modules/sources/warpField";
import { warpGrid } from "../modules/sources/warpGrid";

const ASP = 16 / 9;
const N = 12; // hippos in the herd (compile-time)
const HIPPOS = [1, 2, 3, 4, 5].map((i) => new URL(`../assets/hippos/hippo${i}.png`, import.meta.url).href);

/** Seeded PRNG (mulberry32) — deterministic init, no Math.random. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A flock of hippos grazing the neon grid: a 2D boids sim (separation /
 * alignment / cohesion) steers a dozen hippo sprites, and the same herd is fed
 * into a `warpField` so the grid bows under them as they wheel about. Bass
 * gathers the flock; the kick pulses the grid. Shows the warp-field hook with a
 * playful crowd — swap the sprites or the boids weights to reskin it.
 */
export default defineScene({
  name: "hippo-flock",
  description:
    "A boids flock of hippo sprites wheels over a neon grid that bows under the herd (via warpField); bass gathers them, the kick pulses the grid.",
  tags: ["hippo", "flock", "boids", "grid", "warp", "neon", "audio-reactive", "showcase"],
  build(ctx) {
    // Params.
    const speed = ctx.float("flock.speed", { default: 1, min: 0.1, max: 3, description: "flight speed" });
    const cohesion = ctx.float("flock.cohesion", { default: 1, min: 0, max: 3, description: "steer toward the herd center" });
    const separation = ctx.float("flock.separation", { default: 1, min: 0, max: 3, description: "push off close neighbours" });
    const alignment = ctx.float("flock.alignment", { default: 1, min: 0, max: 3, description: "match neighbours' heading" });
    const hippoSize = ctx.float("hippo.size", { default: 0.14, min: 0.04, max: 0.4, description: "hippo sprite size" });
    const bank = ctx.float("hippo.bank", { default: 0.5, min: 0, max: 2, description: "how much hippos tilt into a turn" });

    const gridCells = ctx.float("grid.cells", { default: 15, min: 4, max: 40, description: "grid density (cells tall)" });
    const gridWarp = ctx.float("grid.warp", { default: 0.16, min: 0, max: 0.5, description: "global grid bend strength" });
    const fieldAmount = ctx.float("grid.fieldAmount", { default: 0.18, min: 0, max: 0.5, description: "how far the herd bends the grid" });
    const herdMass = ctx.float("warp.herdMass", { default: 1.1, min: 0, max: 3, description: "per-hippo grid pull" });
    const herdWake = ctx.float("warp.wake", { default: 0.5, min: 0, max: 2, description: "how much hippo motion drags the lattice" });

    const bloomAmt = ctx.float("finish.bloom", { default: 0.7, min: 0, max: 2.5, description: "glow strength" });
    const bloomRadius = ctx.float("finish.glow", { default: 20, min: 1, max: 60, description: "glow spread (px)" });
    const vig = ctx.float("finish.vignette", { default: 0.5, min: 0, max: 1, description: "corner darkening" });

    ctx.palette.own(["#05030f", "#1f6dff", "#19f0c8", "#ff2bd6", "#ffe45e"]);

    // Audio.
    const kick = ctx.input("kick");
    const bass = ctx.input("bass");

    // 2D boids sim — the single source of truth for the sprites AND the warp field.
    const rng = mulberry32(0x4170a5);
    const px = new Array<number>(N);
    const py = new Array<number>(N);
    const vx = new Array<number>(N);
    const vy = new Array<number>(N);
    for (let i = 0; i < N; i++) {
      px[i] = 0.15 + rng() * 0.7;
      py[i] = 0.15 + rng() * 0.7;
      const a = rng() * Math.PI * 2;
      vx[i] = Math.cos(a) * 0.1;
      vy[i] = Math.sin(a) * 0.1;
    }

    const speedS = speed.signal();
    const cohS = cohesion.signal();
    const sepS = separation.signal();
    const aliS = alignment.signal();

    const R = 0.22; // neighbour radius (uv)
    const step = (dt: number, f: FrameCtx) => {
      const sp = speedS.get(f);
      const cw = cohS.get(f) * (1 + bass.get(f) * 1.2); // bass gathers the flock
      const sw = sepS.get(f);
      const aw = aliS.get(f);
      for (let i = 0; i < N; i++) {
        let sepx = 0;
        let sepy = 0;
        let alx = 0;
        let aly = 0;
        let cox = 0;
        let coy = 0;
        let neigh = 0;
        for (let j = 0; j < N; j++) {
          if (j === i) continue;
          const dx = (px[i]! - px[j]!) * ASP;
          const dy = py[i]! - py[j]!;
          const d2 = dx * dx + dy * dy;
          if (d2 < R * R && d2 > 1e-6) {
            const inv = 1 / d2;
            sepx += dx * inv;
            sepy += dy * inv;
            alx += vx[j]!;
            aly += vy[j]!;
            cox += px[j]!;
            coy += py[j]!;
            neigh++;
          }
        }
        let ax = 0;
        let ay = 0;
        if (neigh > 0) {
          ax += sepx * 0.0009 * sw;
          ay += sepy * 0.0009 * sw;
          ax += (alx / neigh) * aw;
          ay += (aly / neigh) * aw;
          ax += (cox / neigh - px[i]!) * cw;
          ay += (coy / neigh - py[i]!) * cw;
        }
        // Soft containment in the playfield.
        const m = 0.08;
        if (px[i]! < m) ax += (m - px[i]!) * 6;
        if (px[i]! > 1 - m) ax -= (px[i]! - (1 - m)) * 6;
        if (py[i]! < m) ay += (m - py[i]!) * 6;
        if (py[i]! > 1 - m) ay -= (py[i]! - (1 - m)) * 6;

        vx[i] = vx[i]! + ax * dt;
        vy[i] = vy[i]! + ay * dt;
        // Clamp to a sane speed band, scaled by the speed knob.
        const v = Math.hypot(vx[i]!, vy[i]!);
        const lo = 0.06 * sp;
        const hi = 0.26 * sp;
        if (v > 1e-5 && v < lo) {
          vx[i] = (vx[i]! / v) * lo;
          vy[i] = (vy[i]! / v) * lo;
        } else if (v > hi) {
          vx[i] = (vx[i]! / v) * hi;
          vy[i] = (vy[i]! / v) * hi;
        }
        px[i] = Math.min(1.02, Math.max(-0.02, px[i]! + vx[i]! * dt));
        py[i] = Math.min(1.02, Math.max(-0.02, py[i]! + vy[i]! * dt));
      }
    };

    // Frame-guarded stepping (many uniforms pull these, sim advances once/frame).
    let lastFrame = -1;
    const ensure = (f: FrameCtx) => {
      if (f.frame === lastFrame) return;
      lastFrame = f.frame;
      let dt = f.dt;
      if (!(dt > 0)) dt = 0.016;
      step(Math.min(dt, 0.05), f);
    };
    const S = (fn: (f: FrameCtx) => number) => new Signal((f) => (ensure(f), fn(f)));

    const bankS = bank.signal();
    const wakeS = herdWake.signal();
    const massS = herdMass.signal();

    // The grid, bent by the whole herd through a warpField (buffered once).
    const emitters = Array.from({ length: N }, (_, i) => ({
      x: S(() => px[i]!),
      y: S(() => py[i]!),
      mass: S((f) => massS.get(f)),
      vx: S((f) => vx[i]! * wakeS.get(f) * 6),
      vy: S((f) => vy[i]! * wakeS.get(f) * 6),
      radius: 0.16 as number,
    }));
    const field = ctx.layer("herdfield", warpField(ctx, { emitters, gain: 3 }));
    let comp = ctx.layer(
      "grid",
      warpGrid(ctx, {
        cells: gridCells.signal(),
        wells: 1,
        warp: gridWarp.signal(),
        glow: 0.6,
        energy: new Signal((f) => 0.45 + kick.get(f) * 0.6 + bass.get(f) * 0.4),
        field,
        fieldAmount: fieldAmount.signal(),
      }),
    );

    // The hippos themselves: one sprite per boid, placed by the sim. mirrorX
    // flips them to face their travel direction; a small bank tilts into turns.
    for (let i = 0; i < N; i++) {
      const hippo = image(ctx, {
        url: HIPPOS[i % HIPPOS.length]!,
        transform: {
          x: S(() => px[i]!),
          y: S(() => py[i]!),
          scale: hippoSize.signal(),
          rotate: S((f) => Math.max(-0.4, Math.min(0.4, -vx[i]! * 6 * bankS.get(f)))),
          mirrorX: S(() => (vx[i]! < 0 ? -1 : 1)),
        },
      });
      comp = over(ctx, { input: comp, overlay: hippo });
    }

    const glow = bloom(ctx, { input: comp, level: 0.5, intensity: bloomAmt.signal(), radius: bloomRadius.signal() });
    return vignette(ctx, { input: glow, amount: vig.signal(), radius: 0.66, softness: 0.6 });
  },
});
