import { defineScene, Signal } from "@loom/runtime";
import { lag } from "../modules/control/lag";
import { bloom } from "../modules/effects/bloom";
import { displaceGeo } from "../modules/geo/displaceGeo";
import { orbitCam } from "../modules/geo/orbitCam";
import { plane } from "../modules/geo/plane";
import { pointCloud } from "../modules/geo/pointCloud";
import { render3d } from "../modules/sources/render3d";

export default defineScene({
  name: "rutt-etra",
  description:
    "A vertex terrain breathing with the bass, drawn as glowing scan points under a slow orbit — the Rutt-Etra look, three generations later.",
  tags: ["3d", "terrain", "points", "rutt-etra", "audio-reactive", "showcase"],
  build(ctx) {
    const amount = ctx.float("terrain.height", { default: 0.35, min: 0, max: 1.2, description: "terrain wave height" });
    const surgeAmt = ctx.float("terrain.surge", { default: 0.5, min: 0, max: 1.5, description: "extra height per bass" });
    const fieldScale = ctx.float("terrain.scale", { default: 1.6, min: 0.3, max: 5, description: "wave field scale" });
    const flow = ctx.float("terrain.flow", { default: 0.5, min: 0, max: 3, description: "wave travel speed" });
    const dotSize = ctx.float("points.size", { default: 0.014, min: 0.002, max: 0.05, step: 0.001, description: "scan point size" });
    const camSpeed = ctx.float("cam.speed", { default: 0.15, min: -2, max: 2, description: "orbit speed (rad/s)" });
    const camHeight = ctx.float("cam.height", { default: 1.1, min: 0.2, max: 4, description: "camera height" });

    const bass = lag(ctx, { input: ctx.input("bass"), seconds: 0.12 });
    const amtSig = amount.signal();
    const surgeSig = surgeAmt.signal();

    const ground = plane(ctx, { size: [4, 3], segments: 80, color: "#0c1018", roughness: 0.9 });
    const terrain = displaceGeo(ctx, {
      input: ground,
      amount: new Signal((f) => amtSig.get(f) + bass.get(f) * surgeSig.get(f)),
      scale: fieldScale.signal(),
      speed: flow.signal(),
    });
    const points = pointCloud(ctx, { source: terrain, size: dotSize.signal(), color: "#9ae6ff", maxPoints: 7000 });
    const cam = orbitCam(ctx, { radius: 3.2, height: camHeight.signal(), speed: camSpeed.signal(), fov: 45 });
    const staged = ctx.layer("terrain", render3d(ctx, { world: [terrain, points], cam, ambient: 0.35, key: 0.7 }));
    return bloom(ctx, { input: staged, level: 0.35, intensity: 0.9, radius: 10 });
  },
});
