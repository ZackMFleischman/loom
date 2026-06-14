import { defineScene, Signal } from "@loom/runtime";
import { feedback } from "../modules/effects/feedback";
import { levels } from "../modules/effects/levels";
import { model, mediaFsUrl } from "../modules/geo/model";
import { orbitCam } from "../modules/geo/orbitCam";
import { render3d } from "../modules/sources/render3d";

// The DJ Hippo himself — served path-style by loom:mediafs (root 0 in
// content/state/media-roots.json) so the FBX's relative textures resolve.
// Missing on another machine? The node stays empty; the scene still runs.
const HIPPO = mediaFsUrl(0, "3DModels/Hippo3D/Hippopotamus 3D Model.fbx");

export default defineScene({
  name: "hippo3d",
  description:
    "The 3D hippo, height-normalized and slowly turning under an orbiting camera, kick punching the key light, feedback smearing the turn.",
  tags: ["3d", "geo", "model", "fbx", "hippo", "audio-reactive"],
  build(ctx) {
    const spin = ctx.float("hippo.spin", { default: 0.4, min: -3, max: 3, description: "hippo turn speed (rad/s)" });
    const size = ctx.float("hippo.size", { default: 1.4, min: 0.2, max: 4, description: "hippo height (world units)" });
    const camSpeed = ctx.float("cam.speed", { default: 0.25, min: -2, max: 2, description: "orbit speed (rad/s)" });
    const camRadius = ctx.float("cam.radius", { default: 2.6, min: 1, max: 8, description: "orbit distance" });
    const punch = ctx.float("punch", { default: 0.8, min: 0, max: 3, description: "kick-driven key-light punch" });
    const trail = ctx.float("trail", { default: 0.6, min: 0, max: 0.97, description: "feedback persistence" });

    const kick = ctx.input("kick");
    const punchSig = punch.signal();

    const hippo = model(ctx, { url: HIPPO, spin: spin.signal(), scale: size.signal() });
    const cam = orbitCam(ctx, { radius: camRadius.signal(), height: 0.6, speed: camSpeed.signal() });
    const stage3d = ctx.layer(
      "hippo",
      render3d(ctx, {
        world: hippo,
        cam,
        ambient: 1.1,
        key: new Signal((f) => 2 + kick.get(f) * punchSig.get(f)),
      }),
    );
    const trails = feedback(ctx, { input: stage3d, amount: trail.signal(), zoom: 1.004 });
    return levels(ctx, { input: trails, gain: 1.05, gamma: 1.04 });
  },
});
