import { defineScene, lagSignal, Signal, texNode } from "@loom/runtime";
import { vec4 } from "three/tsl";
import { pickPalette } from "../palettes";
import { bloom } from "../modules/effects/bloom";
import { vignette } from "../modules/effects/vignette";
import { physarum } from "../modules/sources/physarum";

/**
 * A Physarum slime-mold colony grows its transport network live: tens of
 * thousands of agents taste a diffusing trail field at three sensors, steer up
 * the strongest scent and deposit as they crawl, so glowing veins braid,
 * reinforce and prune themselves into neuron / leaf-venation lattices. The
 * kick widens the sensor splay (the colony flares open and re-knits on the
 * beat) and flashes the deposit so fresh trails punch through; the bass swells
 * the agent speed so the network breathes. The trail density is ramped through
 * the palette with an accent flash on the kick, then bloomed and vignetted.
 */
export default defineScene({
  name: "slime-veins",
  description: "A living Physarum colony braids glowing vein/neuron networks — kick flares the sensors, bass breathes the swarm.",
  tags: ["physarum", "slime-mold", "agents", "organic", "generative", "audio-reactive", "showcase"],
  build(ctx) {
    const count = ctx.int("colony.agents", { default: 160000, min: 4096, max: 400000, step: 4096, description: "agent count (rebuild)" });
    const speed = ctx.float("colony.speed", { default: 1.0, min: 0.3, max: 3, step: 0.05, description: "forward step per frame (texels)" });
    const speedSwell = ctx.float("colony.breathe", { default: 0.6, min: 0, max: 2, step: 0.05, description: "bass push on agent speed" });
    const sensorDist = ctx.float("sense.reach", { default: 12, min: 3, max: 22, step: 0.5, description: "how far ahead the sensors taste" });
    const sensorAngle = ctx.float("sense.splay", { default: 0.4, min: 0.2, max: 1.3, step: 0.02, description: "sensor splay angle (radians)" });
    const splayFlare = ctx.float("sense.flare", { default: 0.35, min: 0, max: 0.9, step: 0.02, description: "kick widens the splay (flare/re-knit)" });
    const turnSpeed = ctx.float("colony.turn", { default: 0.6, min: 0.1, max: 1.2, step: 0.02, description: "turn rate toward the strongest sensor" });
    const deposit = ctx.float("trail.deposit", { default: 0.12, min: 0.02, max: 1, step: 0.01, description: "trail laid per agent per frame" });
    const depPunch = ctx.float("trail.punch", { default: 0.5, min: 0, max: 1, step: 0.01, description: "kick flash on the deposit" });
    const decay = ctx.float("trail.persist", { default: 0.88, min: 0.7, max: 0.99, step: 0.005, description: "trail survival per frame (vein length)" });
    const spread = ctx.float("color.spread", { default: 5, min: 1, max: 12, step: 0.1, description: "palette spread across trail density" });
    const bloomLevel = ctx.float("finish.bloom", { default: 0.45, min: 0, max: 1, step: 0.01, description: "bloom threshold" });
    const bloomInt = ctx.float("finish.glow", { default: 0.8, min: 0, max: 2, step: 0.05, description: "bloom intensity" });
    const vig = ctx.float("finish.vignette", { default: 0.55, min: 0, max: 1, step: 0.01, description: "corner darkening" });

    // Palette is a CHOICE (palette.pick): both global palettes (retint live) +
    // scene presets. Roles: 0 bg · 1 edge · 2/3 core · 4 accent.
    const pal = pickPalette(ctx, [
      { name: "Mycelium", stops: ["#02040a", "#0c2a3a", "#16b39a", "#caff5e", "#fff2b0"] },
      { name: "Neuron", stops: ["#04020a", "#1a0e3a", "#5b3cff", "#ff5db1", "#ffe27a"] },
      { name: "Vein", stops: ["#0a0204", "#3a0d14", "#c2304a", "#ff8a3c", "#ffe9b0"] },
      { name: "Bio", stops: ["#01060a", "#063a2a", "#0fae6b", "#3df2c4", "#e6fff0"] },
    ]);

    const kick = ctx.input("kick");
    const bass = lagSignal(ctx.audio.band("bass"), 0.12);

    // Kick flares the sensor splay open then it re-knits; bass swells speed.
    const splayBase = sensorAngle.signal();
    const flareAmt = splayFlare.signal();
    const splaySig = new Signal((f) => splayBase.get(f) + kick.get(f) * flareAmt.get(f));

    const speedBase = speed.signal();
    const breatheAmt = speedSwell.signal();
    const speedSig = new Signal((f) => speedBase.get(f) * (1 + bass.get(f) * breatheAmt.get(f)));

    const depBase = deposit.signal();
    const punchAmt = depPunch.signal();
    const depositSig = new Signal((f) => depBase.get(f) * (1 + kick.get(f) * punchAmt.get(f)));

    const field = physarum(ctx, {
      count: count.value,
      speed: speedSig,
      sensorDist: sensorDist.signal(),
      sensorAngle: splaySig,
      turnSpeed: turnSpeed.signal(),
      deposit: depositSig,
      decay: decay.signal(),
    });

    // Colorize: ramp the trail density through the palette; flash the accent on kicks.
    const spreadU = ctx.uniformOf(spread.signal());
    const kickU = ctx.uniformOf(kick);
    const density = field.color.x.mul(spreadU).clamp(0, 1);
    const rgb = pal.ramp(density).rgb.add(pal.color(4).mul(density).mul(kickU).mul(0.6));
    const src = ctx.layer("colony", texNode(vec4(rgb, 1), field.passes));

    const glow = bloom(ctx, { input: src, level: bloomLevel.signal(), intensity: bloomInt.signal() });
    return vignette(ctx, { input: glow, amount: vig.signal() });
  },
});
