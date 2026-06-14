import { defineScene, integrateSignal, Signal } from "@loom/runtime";
import { envelope } from "../modules/control/envelope";
import { noiseSignal } from "../modules/control/noiseSignal";
import { bloom } from "../modules/effects/bloom";
import { mixer } from "../modules/effects/mixer";
import { vignette } from "../modules/effects/vignette";
import { enemySwarm } from "../modules/sources/enemySwarm";
import { particleBurst } from "../modules/sources/particleBurst";
import { vectorShip } from "../modules/sources/vectorShip";
import { warpGrid } from "../modules/sources/warpGrid";

export default defineScene({
  name: "geo-wars",
  description:
    "A neon twin-stick arcade battle: a vector ship holds the center of a gravity-warped grid while waves of glowing geometric enemies spiral in and detonate into particle bursts — full bloom juice.",
  tags: ["arcade", "geometry-wars", "neon", "vector", "particles", "audio-reactive", "showcase"],
  build(ctx) {
    // 1. Params — the human's mixing board.
    const gridCells = ctx.float("grid.cells", { default: 15, min: 4, max: 40, description: "grid density (cells tall)" });
    const gridWarp = ctx.float("grid.warp", { default: 0.18, min: 0, max: 0.5, description: "how hard the wells bend the grid" });
    const gridDrift = ctx.float("grid.drift", { default: 0.35, min: 0, max: 1.5, description: "well wander speed" });
    const gridGlow = ctx.float("grid.glow", { default: 0.6, min: 0, max: 2, description: "grid line halo bleed" });

    const enemyCount = ctx.float("enemies.count", { default: 12, min: 0, max: 16, description: "wave size (visible enemies)" });
    const enemySpeed = ctx.float("enemies.speed", { default: 0.18, min: 0.02, max: 0.6, description: "inward march speed" });
    const enemySwirl = ctx.float("enemies.swirl", { default: 2.4, min: 0, max: 8, description: "spiral curl of the approach" });
    const enemySize = ctx.float("enemies.size", { default: 0.07, min: 0.02, max: 0.16, description: "enemy size" });
    const enemySpin = ctx.float("enemies.spin", { default: 0.7, min: 0, max: 3, description: "enemy self-spin rate" });

    const shipSize = ctx.float("ship.size", { default: 0.1, min: 0.03, max: 0.3, description: "protagonist size" });
    const shipSpin = ctx.float("ship.spin", { default: 0.5, min: -3, max: 3, description: "protagonist turn rate (rad/s)" });

    const burstRate = ctx.float("burst.rate", { default: 0.8, min: 0.1, max: 3, description: "explosion re-pop rate" });
    const burstSpread = ctx.float("burst.spread", { default: 0.3, min: 0.05, max: 0.7, description: "how far shards fly" });
    const burstSize = ctx.float("burst.size", { default: 0.02, min: 0.005, max: 0.06, description: "shard glow size" });

    const punch = ctx.float("punch", { default: 1, min: 0, max: 3, description: "kick reactivity strength" });
    const bloomAmt = ctx.float("finish.bloom", { default: 1.3, min: 0, max: 3, description: "glow strength" });
    const bloomRadius = ctx.float("finish.glow", { default: 26, min: 1, max: 60, description: "glow spread (px)" });
    const vig = ctx.float("finish.vignette", { default: 0.55, min: 0, max: 1, description: "corner darkening" });

    // Bright arcade neon palette: bg · grid-edge blue · cyan core · magenta core · gold accent.
    ctx.palette.own(["#05030f", "#1f6dff", "#19f0c8", "#ff2bd6", "#ffe45e"]);

    // 2. World — audio rack channels into a punchy kick envelope.
    const kick = ctx.input("kick");
    const bass = ctx.input("bass");
    const energy = ctx.input("energy");
    const kickEnv = envelope(ctx, { input: kick, attack: 0.004, release: 0.3 });
    const punchS = punch.signal();
    const hit = new Signal((f) => kickEnv.get(f) * punchS.get(f)); // 0..~3 on the beat

    // The protagonist's live position — the hub every other module couples to.
    // It wanders on slow seeded noise; the grid dents around it, the enemies hunt
    // it, and the kick punches a shock through the grid at this point.
    const wanderX = ctx.float("ship.wander", { default: 1, min: 0, max: 1, description: "ship roam amount (0 = pinned to center)" }).signal();
    const roamX = noiseSignal(ctx, { rate: 0.08, lo: -0.16, hi: 0.16, octaves: 2 });
    const roamY = noiseSignal(ctx, { rate: 0.07, lo: -0.13, hi: 0.13, octaves: 2 });
    const shipX = new Signal((f) => 0.5 + roamX.get(f) * wanderX.get(f));
    const shipY = new Signal((f) => 0.5 + roamY.get(f) * wanderX.get(f));

    // 3. Grid stage — bends on the wells, pulses on the beat.
    const warpBase = gridWarp.signal();
    const grid = ctx.layer(
      "grid",
      warpGrid(ctx, {
        cells: gridCells.signal(),
        warp: new Signal((f) => warpBase.get(f) * (1 + hit.get(f) * 0.6)),
        drift: gridDrift.signal(),
        glow: gridGlow.signal(),
        energy: new Signal((f) => 0.4 + hit.get(f) * 0.7 + bass.get(f) * 0.5),
        wells: 2, // two roaming wells…
        anchors: [
          // …plus one pinned to the protagonist: the grid dimples around the ship
          // and follows it, and every kick punches a shock through that point.
          { x: shipX, y: shipY, strength: new Signal((f) => 1.3 + hit.get(f) * 2.6) },
        ],
      }),
    );

    // 4. Enemy waves spiral in toward the center; the kick lurches them inward.
    const enemies = ctx.layer(
      "enemies",
      enemySwarm(ctx, {
        count: enemyCount.signal(),
        shape: "star",
        points: 4,
        spike: 0.7,
        size: enemySize.signal(),
        speed: enemySpeed.signal(),
        swirl: enemySwirl.signal(),
        spin: enemySpin.signal(),
        surge: new Signal((f) => 1 + hit.get(f) * 1.4),
        targetX: shipX, // enemies converge on the protagonist, not a fixed point
        targetY: shipY,
        colorStop: 3,
        hueSpread: 0.85,
        thickness: 0.015,
        maxCount: 16,
      }),
    );

    // 5. Explosions detonate across the field, flaring on every kick.
    const bursts = ctx.layer(
      "bursts",
      particleBurst(ctx, {
        bursts: 6,
        particles: 8,
        burst: hit,
        rate: burstRate.signal(),
        spread: burstSpread.signal(),
        size: burstSize.signal(),
        decay: 1.4,
        colorStop: 4,
        hueSpread: 0.6,
      }),
    );

    // 6. Protagonist holds the center, turning and thrusting on the energy.
    const ship = ctx.layer(
      "ship",
      vectorShip(ctx, {
        shape: "poly",
        sides: 3,
        x: shipX,
        y: shipY,
        size: shipSize.signal(),
        rotate: integrateSignal(shipSpin.signal(), { wrap: Math.PI * 2 }),
        thrust: new Signal((f) => 0.3 + energy.get(f) * 0.8 + hit.get(f) * 0.7),
        thickness: 0.02,
        colorStop: 2,
        flameStop: 4,
      }),
    );

    // 7. Additively pile the neon up and bloom it — the juice.
    const lit = mixer(ctx, {
      input: mixer(ctx, {
        input: mixer(ctx, { input: grid, b: enemies, mode: "add", mix: 1 }),
        b: bursts,
        mode: "add",
        mix: 1,
      }),
      b: ship,
      mode: "add",
      mix: 1,
    });
    const glow = bloom(ctx, { input: lit, level: 0.3, intensity: bloomAmt.signal(), radius: bloomRadius.signal() });
    return vignette(ctx, { input: glow, amount: vig.signal(), radius: 0.66, softness: 0.6 });
  },
});
