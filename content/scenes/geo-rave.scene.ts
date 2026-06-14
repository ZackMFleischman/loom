import { defineScene, Signal } from "@loom/runtime";
import { feedback } from "../modules/effects/feedback";
import { levels } from "../modules/effects/levels";
import { box } from "../modules/geo/box";
import { orbitCam } from "../modules/geo/orbitCam";
import { sphere } from "../modules/geo/sphere";
import { torus } from "../modules/geo/torus";
import { render3d } from "../modules/sources/render3d";

export default defineScene({
  name: "geo-rave",
  description:
    "Three primitives — a tumbling torus, a spinning box, a kick-glowing sphere — under an orbiting camera, smeared through video feedback.",
  tags: ["3d", "geo", "primitives", "audio-reactive", "feedback"],
  build(ctx) {
    // Dotted paths form Console groups: cam / world / trail.
    const camSpeed = ctx.float("cam.speed", { default: 0.4, min: -2, max: 2, description: "orbit speed (rad/s, negative = reverse)" });
    const camRadius = ctx.float("cam.radius", { default: 3, min: 1, max: 8, description: "orbit distance" });
    const camHeight = ctx.float("cam.height", { default: 0.9, min: -2, max: 4, description: "camera height" });
    const spin = ctx.float("world.spin", { default: 0.7, min: -3, max: 3, description: "mesh spin (rad/s)" });
    const pulse = ctx.float("world.pulse", { default: 0.6, min: 0, max: 2, description: "kick-driven sphere glow + scale punch" });
    const trail = ctx.float("trail.amount", { default: 0.78, min: 0, max: 0.97, description: "feedback persistence" });
    const drift = ctx.float("trail.zoom", { default: 1.012, min: 0.95, max: 1.06, description: "trail zoom drift" });

    const kick = ctx.input("kick");
    const pulseSig = pulse.signal();
    const punch = new Signal((f) => kick.get(f) * pulseSig.get(f));

    const world = [
      torus(ctx, { radius: 0.85, tube: 0.2, tumble: 0.45, spin: spin.signal(), color: "#b73ff0", metalness: 0.6, roughness: 0.3 }),
      box(ctx, { size: [0.5, 0.5, 0.5], spin: spin.signal(), position: [-1.2, 0.3, 0], color: "#3fb7f0", roughness: 0.4 }),
      sphere(ctx, {
        radius: 0.32,
        position: [1.15, -0.2, 0],
        color: "#ffd24a",
        glow: punch,
        scale: new Signal((f) => 1 + punch.get(f) * 0.6),
      }),
    ];
    const cam = orbitCam(ctx, {
      radius: camRadius.signal(),
      height: camHeight.signal(),
      speed: camSpeed.signal(),
    });
    const stage3d = ctx.layer(
      "stage3d",
      render3d(ctx, { world, cam, key: new Signal((f) => 1.2 + kick.get(f)) }),
    );
    const trails = feedback(ctx, { input: stage3d, amount: trail.signal(), zoom: drift.signal() });
    return levels(ctx, { input: trails, gain: 1.05, gamma: 1.05 });
  },
});
