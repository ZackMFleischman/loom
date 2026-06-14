import { defineScene, Signal } from "@loom/runtime";
import { levels } from "../modules/effects/levels";
import { model, mediaFsUrl } from "../modules/geo/model";
import { orbitCam } from "../modules/geo/orbitCam";
import { particleEmitter } from "../modules/geo/particleEmitter";
import { render3d } from "../modules/sources/render3d";

// The M8 flagship prompt, on this rig's own model: particles boil off the 3D
// hippo's surface, the hats channel driving the turbulence. Commit it through
// a feedback+paletteMap chain with set_chain — no hand-wiring needed.
const HIPPO = mediaFsUrl(0, "3DModels/Hippo3D/Hippopotamus 3D Model.fbx");

export default defineScene({
  name: "hippo-swarm",
  description:
    "Glowing particles boil off the 3D hippo's hide — hats whip the swarm into turbulence, the kick punches the key light.",
  tags: ["3d", "particles", "model", "hippo", "audio-reactive", "flagship"],
  build(ctx) {
    const rate = ctx.float("swarm.rate", { default: 350, min: 0, max: 2000, description: "particles per second" });
    const lifetime = ctx.float("swarm.lifetime", { default: 1.8, min: 0.2, max: 5, description: "particle lifetime (s)" });
    const chaos = ctx.float("swarm.chaos", { default: 2.2, min: 0, max: 8, description: "how hard the hats whip the swarm" });
    const lift = ctx.float("swarm.lift", { default: 0.12, min: -1, max: 1, description: "upward drift (negative = rain down)" });
    const spin = ctx.float("hippo.spin", { default: 0.3, min: -3, max: 3, description: "hippo turn speed (rad/s)" });
    const punch = ctx.float("punch", { default: 0.8, min: 0, max: 3, description: "kick-driven key-light punch" });
    const camSpeed = ctx.float("cam.speed", { default: 0.2, min: -2, max: 2, description: "orbit speed (rad/s)" });

    const kick = ctx.input("kick");
    const hats = ctx.input("hats"); // hats drive the turbulence — the flagship wiring
    const chaosSig = chaos.signal();
    const liftSig = lift.signal();
    const punchSig = punch.signal();

    const hippo = model(ctx, { url: HIPPO, spin: spin.signal(), fit: 1.3 });
    const swarm = particleEmitter(ctx, {
      surface: hippo,
      rate: rate.signal(),
      lifetime: lifetime.signal(),
      speed: 0.35,
      turbulence: new Signal((f) => hats.get(f) * chaosSig.get(f)),
      gravity: new Signal((f) => liftSig.get(f)),
      size: 0.03,
      color: "#9ae6ff",
      maxParticles: 4000,
    });
    const cam = orbitCam(ctx, { radius: 2.8, height: 0.7, speed: camSpeed.signal() });
    const stage3d = ctx.layer(
      "swarm3d",
      render3d(ctx, {
        world: [hippo, swarm],
        cam,
        ambient: 1.0,
        key: new Signal((f) => 1.8 + kick.get(f) * punchSig.get(f)),
      }),
    );
    return levels(ctx, { input: stage3d, gain: 1.08, gamma: 1.03 });
  },
});
