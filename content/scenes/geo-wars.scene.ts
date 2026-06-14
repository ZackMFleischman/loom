import { defineScene, Signal, type FrameCtx } from "@loom/runtime";
import { envelope } from "../modules/control/envelope";
import { bloom } from "../modules/effects/bloom";
import { mixer } from "../modules/effects/mixer";
import { vignette } from "../modules/effects/vignette";
import { bullets } from "../modules/sources/bullets";
import { enemySwarm } from "../modules/sources/enemySwarm";
import { particleBurst } from "../modules/sources/particleBurst";
import { vectorShip } from "../modules/sources/vectorShip";
import { warpGrid } from "../modules/sources/warpGrid";

const TAU = Math.PI * 2;
const ASP = 16 / 9; // playfield aspect (keeps steering/aim circular)

// Counts are compile-time (they size the unrolled shaders + the sim arrays).
const N = 10; // enemies
const M = 8; // bullets in flight
const H = 6; // explosion slots
const E_SPAWN = 0.5; // enemy fade-in time (s)
const B_LIFE = 0.7; // bullet lifetime (s)
const H_DUR = 0.45; // blast lifetime (s)

/** Small seeded PRNG (no Math.random — keeps the sim reproducible). */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export default defineScene({
  name: "geo-wars",
  description:
    "A neon twin-stick arcade battle: a vector ship flies a primitive AI — dodging waves of geometric enemies and firing tracers that detonate on impact — across a gravity-warped grid that every entity bends. Full bloom juice.",
  tags: ["arcade", "geometry-wars", "neon", "vector", "particles", "ai", "audio-reactive", "showcase"],
  build(ctx) {
    // 1. Params — the human's mixing board (feel + the AI's temperament).
    const gridCells = ctx.float("grid.cells", { default: 15, min: 4, max: 40, description: "grid density (cells tall)" });
    const gridWarp = ctx.float("grid.warp", { default: 0.16, min: 0, max: 0.5, description: "global grid bend strength" });
    const gridGlow = ctx.float("grid.glow", { default: 0.5, min: 0, max: 2, description: "grid line halo bleed" });
    const shipPull = ctx.float("warp.shipPull", { default: 0.55, min: 0, max: 2, description: "how much the ship dents the grid" });
    const bombShock = ctx.float("warp.bombShock", { default: 1.6, min: 0, max: 4, description: "explosion shock through the grid" });

    const enemySize = ctx.float("enemies.size", { default: 0.062, min: 0.02, max: 0.16, description: "enemy size" });
    const enemySpeed = ctx.float("enemies.speed", { default: 0.12, min: 0.02, max: 0.5, description: "enemy chase speed" });
    const enemySpin = ctx.float("enemies.spin", { default: 0.7, min: 0, max: 3, description: "enemy self-spin rate" });

    const shipSize = ctx.float("ship.size", { default: 0.075, min: 0.03, max: 0.2, description: "protagonist size" });
    const shipAgility = ctx.float("ship.agility", { default: 1, min: 0.2, max: 3, description: "how hard the AI dodges/seeks" });
    const fireRate = ctx.float("ship.fireRate", { default: 6, min: 0.5, max: 16, description: "shots per second" });

    const burstSpread = ctx.float("burst.spread", { default: 0.26, min: 0.05, max: 0.7, description: "explosion shard reach" });
    const burstBright = ctx.float("burst.bright", { default: 0.8, min: 0, max: 2, description: "explosion brightness" });

    const punch = ctx.float("punch", { default: 1, min: 0, max: 3, description: "kick reactivity strength" });
    const bloomAmt = ctx.float("finish.bloom", { default: 0.7, min: 0, max: 2.5, description: "glow strength" });
    const bloomLevel = ctx.float("finish.level", { default: 0.5, min: 0, max: 1, description: "luma where glow starts (higher = less wash)" });
    const bloomRadius = ctx.float("finish.glow", { default: 22, min: 1, max: 60, description: "glow spread (px)" });
    const vig = ctx.float("finish.vignette", { default: 0.55, min: 0, max: 1, description: "corner darkening" });

    // Bright arcade neon palette: bg · grid-edge blue · cyan core · magenta core · gold accent.
    ctx.palette.own(["#05030f", "#1f6dff", "#19f0c8", "#ff2bd6", "#ffe45e"]);

    // 2. Audio + reactivity.
    const kick = ctx.input("kick");
    const bass = ctx.input("bass");
    const energy = ctx.input("energy");
    const kickEnv = envelope(ctx, { input: kick, attack: 0.004, release: 0.3 });
    const punchS = punch.signal();
    const hit = new Signal((f) => kickEnv.get(f) * punchS.get(f));
    const enemySpeedS = enemySpeed.signal();
    const agilityS = shipAgility.signal();
    const fireRateS = fireRate.signal();

    // 3. The battle sim — a tiny deterministic CPU model, the single source of
    // truth that every render module reads. It runs once per frame (frame-guarded)
    // off the engine clock (f.dt), so no wall-clock time leaks in.
    const rng = mulberry32(0x6e0a17);
    const ex = new Array<number>(N);
    const ey = new Array<number>(N);
    const eph = new Array<number>(N); // 0..1 spawn progress
    const bx = new Array<number>(M).fill(0);
    const by = new Array<number>(M).fill(0);
    const bang = new Array<number>(M).fill(0);
    const blife = new Array<number>(M).fill(0); // seconds remaining (0 = free)
    const hx = new Array<number>(H).fill(0);
    const hy = new Array<number>(H).fill(0);
    const hf = new Array<number>(H).fill(0); // blast seconds remaining
    let shipx = 0.5;
    let shipy = 0.5;
    let svx = 0;
    let svy = 0;
    let shipAng = 0;
    let T = 0;
    let fireT = 0;
    let hc = 0; // hit ring-buffer cursor

    const spawn = (i: number) => {
      const a = rng() * TAU;
      ex[i] = 0.5 + Math.cos(a) * 0.62; // appear just off the playfield
      ey[i] = 0.5 + Math.sin(a) * 0.46;
      eph[i] = 0;
    };
    for (let i = 0; i < N; i++) spawn(i);

    const step = (dt: number, f: FrameCtx) => {
      T += dt;
      const agility = agilityS.get(f);
      const eSpeed = enemySpeedS.get(f);

      // Ship steering: seek a slow wander point, flee nearby enemies, stay in bounds.
      const wx = 0.5 + 0.26 * Math.sin(T * 0.27) + 0.08 * Math.sin(T * 0.63);
      const wy = 0.5 + 0.22 * Math.sin(T * 0.31 + 1.3);
      let axn = (wx - shipx) * 1.1 * agility;
      let ayn = (wy - shipy) * 1.1 * agility;
      let nd = 1e9;
      let ni = -1;
      for (let i = 0; i < N; i++) {
        const dx = (ex[i]! - shipx) * ASP;
        const dy = ey[i]! - shipy;
        const d = Math.hypot(dx, dy);
        if (d < nd) {
          nd = d;
          ni = i;
        }
        const avoid = 0.26;
        if (d < avoid) {
          const w = ((avoid - d) / avoid) * 3.2 * agility;
          axn += ((shipx - ex[i]!) / (d + 1e-3)) * w;
          ayn += ((shipy - ey[i]!) / (d + 1e-3)) * w;
        }
      }
      const m = 0.1;
      if (shipx < m) axn += (m - shipx) * 8;
      if (shipx > 1 - m) axn -= (shipx - (1 - m)) * 8;
      if (shipy < m) ayn += (m - shipy) * 8;
      if (shipy > 1 - m) ayn -= (shipy - (1 - m)) * 8;
      svx = (svx + axn * dt) * 0.96;
      svy = (svy + ayn * dt) * 0.96;
      const sp = Math.hypot(svx, svy);
      const maxv = 0.6;
      if (sp > maxv) {
        svx *= maxv / sp;
        svy *= maxv / sp;
      }
      shipx = Math.min(0.94, Math.max(0.06, shipx + svx * dt));
      shipy = Math.min(0.92, Math.max(0.08, shipy + svy * dt));
      if (ni >= 0) shipAng = Math.atan2(ey[ni]! - shipy, (ex[ni]! - shipx) * ASP); // aim at the nearest enemy

      // Enemies chase the ship; respawn at the rim if they reach it.
      for (let i = 0; i < N; i++) {
        const dx = shipx - ex[i]!;
        const dy = shipy - ey[i]!;
        const du = Math.hypot(dx, dy) + 1e-4;
        ex[i] = ex[i]! + (dx / du) * eSpeed * dt;
        ey[i] = ey[i]! + (dy / du) * eSpeed * dt;
        eph[i] = Math.min(1, eph[i]! + dt / E_SPAWN);
        if (du < 0.045) spawn(i);
      }

      // Fire at the nearest enemy on the fire-rate clock.
      fireT -= dt;
      if (fireT <= 0 && ni >= 0 && nd < 0.85) {
        let bi = -1;
        for (let k = 0; k < M; k++)
          if (blife[k]! <= 0) {
            bi = k;
            break;
          }
        if (bi >= 0) {
          bx[bi] = shipx;
          by[bi] = shipy;
          bang[bi] = shipAng;
          blife[bi] = B_LIFE;
        }
        fireT = 1 / Math.max(0.5, fireRateS.get(f));
      }

      // Advance bullets; detonate on the first enemy they touch.
      const bspd = 1.4;
      for (let k = 0; k < M; k++) {
        if (blife[k]! <= 0) continue;
        bx[k] = bx[k]! + (Math.cos(bang[k]!) / ASP) * bspd * dt;
        by[k] = by[k]! + Math.sin(bang[k]!) * bspd * dt;
        blife[k] = blife[k]! - dt;
        for (let i = 0; i < N; i++) {
          const dx = (bx[k]! - ex[i]!) * ASP;
          const dy = by[k]! - ey[i]!;
          if (Math.hypot(dx, dy) < 0.05 && eph[i]! > 0.3) {
            hx[hc] = ex[i]!;
            hy[hc] = ey[i]!;
            hf[hc] = H_DUR;
            hc = (hc + 1) % H;
            spawn(i);
            blife[k] = 0;
            break;
          }
        }
        if (bx[k]! < -0.1 || bx[k]! > 1.1 || by[k]! < -0.1 || by[k]! > 1.1) blife[k] = 0;
      }

      for (let h = 0; h < H; h++) if (hf[h]! > 0) hf[h] = Math.max(0, hf[h]! - dt);
    };

    // Frame-guarded stepping: many uniforms pull these signals each frame, but the
    // sim must advance exactly once per frame.
    let lastFrame = -1;
    const ensure = (f: FrameCtx) => {
      if (f.frame === lastFrame) return;
      lastFrame = f.frame;
      let dt = f.dt;
      if (!(dt > 0)) dt = 0.016;
      step(Math.min(dt, 0.05), f);
    };
    const S = (fn: () => number) => new Signal((f) => (ensure(f), fn()));

    // 4. Expose the sim state as signal sets the render modules consume.
    const shipX = S(() => shipx);
    const shipY = S(() => shipy);
    const enemyNodes = Array.from({ length: N }, (_, i) => ({ x: S(() => ex[i]!), y: S(() => ey[i]!), phase: S(() => eph[i]!) }));
    const bulletNodes = Array.from({ length: M }, (_, k) => ({ x: S(() => bx[k]!), y: S(() => by[k]!), angle: S(() => bang[k]!), life: S(() => blife[k]! / B_LIFE) }));
    const blastNodes = Array.from({ length: H }, (_, h) => ({ x: S(() => hx[h]!), y: S(() => hy[h]!), fire: S(() => hf[h]! / H_DUR) }));

    // 5. The grid — bent by every entity. Ship dents + drags it; enemies dimple it;
    // each blast bulges a shockwave out of it (negative mass). This is the general
    // warp hook: any visualization with a position feeds an influence.
    const shipPullS = shipPull.signal();
    const bombShockS = bombShock.signal();
    const influences = [
      {
        x: shipX,
        y: shipY,
        mass: new Signal((f) => (ensure(f), 0.4 + Math.hypot(svx, svy) * 0.5) * shipPullS.get(f)),
        swirl: new Signal((f) => (ensure(f), 0.3 + hit.get(f) * 0.7)),
        vx: S(() => svx * 1.1),
        vy: S(() => svy * 1.1),
        radius: 0.32 as number,
      },
      ...enemyNodes.map((e) => ({ x: e.x, y: e.y, mass: S(() => 0.12), radius: 0.14 as number })),
      ...blastNodes.map((b, h) => ({ x: b.x, y: b.y, mass: new Signal((f) => (ensure(f), -(hf[h]! / H_DUR) * bombShockS.get(f))), radius: 0.34 as number })),
    ];

    const grid = ctx.layer(
      "grid",
      warpGrid(ctx, {
        cells: gridCells.signal(),
        warp: gridWarp.signal(),
        drift: 0.3,
        glow: gridGlow.signal(),
        energy: new Signal((f) => 0.4 + hit.get(f) * 0.5 + bass.get(f) * 0.4),
        wells: 2,
        influences,
      }),
    );

    // 6. The combatants — all drawn from the same sim state.
    const enemies = ctx.layer(
      "enemies",
      enemySwarm(ctx, {
        positions: enemyNodes,
        shape: "star",
        points: 4,
        spike: 0.7,
        size: enemySize.signal(),
        spin: enemySpin.signal(),
        colorStop: 3,
        hueSpread: 0.85,
        thickness: 0.014,
      }),
    );

    const tracers = ctx.layer(
      "bullets",
      bullets(ctx, { shots: bulletNodes, length: 0.05, width: 0.008, colorStop: 2, brightness: 0.9 }),
    );

    const blasts = ctx.layer(
      "bursts",
      particleBurst(ctx, {
        sites: blastNodes,
        particles: 9,
        spread: burstSpread.signal(),
        size: 0.016,
        decay: 1.5,
        colorStop: 4,
        hueSpread: 0.6,
        brightness: burstBright.signal(),
      }),
    );

    const ship = ctx.layer(
      "ship",
      vectorShip(ctx, {
        shape: "poly",
        sides: 3,
        x: shipX,
        y: shipY,
        size: shipSize.signal(),
        rotate: new Signal((f) => (ensure(f), shipAng)),
        thrust: new Signal((f) => (ensure(f), 0.12 + Math.hypot(svx, svy) * 0.5 + energy.get(f) * 0.3)),
        thickness: 0.018,
        colorStop: 2,
        flameStop: 4,
        brightness: 0.85,
      }),
    );

    // 7. Composite with SCREEN (caps at 1 — no white-out), then a gentler bloom.
    const layer = (a: ReturnType<typeof warpGrid>, b: ReturnType<typeof warpGrid>) =>
      mixer(ctx, { input: a, b, mode: "screen", mix: 1 });
    const lit = layer(layer(layer(layer(grid, enemies), tracers), blasts), ship);
    const glow = bloom(ctx, { input: lit, level: bloomLevel.signal(), intensity: bloomAmt.signal(), radius: bloomRadius.signal() });
    return vignette(ctx, { input: glow, amount: vig.signal(), radius: 0.66, softness: 0.6 });
  },
});
