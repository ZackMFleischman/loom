import { defineScene, Signal } from "@loom/runtime";
import { envelope } from "../modules/control/envelope";
import { remap } from "../modules/control/remap";
import { spring } from "../modules/control/spring";
import { feedback } from "../modules/effects/feedback";
import { orbitCam } from "../modules/geo/orbitCam";
import { tube } from "../modules/geo/tube";
import { render3d } from "../modules/sources/render3d";

export default defineScene({
  name: "spring-rave",
  description:
    "A ring of laser beams on spring physics — every kick bounces and rings instead of easing, hats lift the glow, trails smear the orbit.",
  tags: ["3d", "beams", "spring", "physics", "audio-reactive", "showcase"],
  build(ctx) {
    const stiffness = ctx.float("bounce.stiffness", { default: 170, min: 20, max: 400, description: "spring stiffness (overshoot)" });
    const damping = ctx.float("bounce.damping", { default: 7, min: 1, max: 40, description: "spring damping (ring length)" });
    const kickScale = ctx.float("bounce.amount", { default: 0.7, min: 0, max: 3, description: "beam stretch per kick" });
    const shimmer = ctx.float("beams.shimmer", { default: 1.2, min: 0, max: 4, description: "hats-driven glow lift" });
    const camSpeed = ctx.float("cam.speed", { default: 0.35, min: -2, max: 2, description: "orbit speed (rad/s)" });
    const trail = ctx.float("trail", { default: 0.72, min: 0, max: 0.97, description: "feedback persistence" });

    const kick = ctx.input("kick");
    const hats = ctx.input("hats");

    // Spring-shaped kick: overshoots past 1 and rings back — physical, not eased.
    const bounce = spring(ctx, { input: kick, stiffness: stiffness.signal(), damping: damping.signal() });
    const stretch = remap(ctx, { input: bounce, inMax: 1, outMin: 1, outMax: 1.6, curve: "linear", clamp: false });
    const glowLift = envelope(ctx, { input: hats, attack: 0.003, release: 0.18 });
    const shimmerSig = shimmer.signal();
    const kickScaleSig = kickScale.signal();

    const COLORS = ["#9ae6ff", "#f06bd3", "#ffd24a", "#7df0a8", "#b388ff", "#ff8a6b"];
    const beams = COLORS.map((color, i) => {
      const a = (i / COLORS.length) * Math.PI * 2;
      return tube(ctx, {
        radius: 0.04,
        length: 1.9,
        color,
        position: [Math.cos(a) * 1.4, 0, Math.sin(a) * 1.4],
        glow: new Signal((f) => 0.5 + glowLift.get(f) * shimmerSig.get(f)),
        scale: new Signal((f) => 1 + (stretch.get(f) - 1) * kickScaleSig.get(f)),
        spin: 0.3,
      });
    });
    const cam = orbitCam(ctx, { radius: 5, height: 1.4, speed: camSpeed.signal(), fov: 45 });
    const staged = ctx.layer("beams", render3d(ctx, { world: beams, cam, ambient: 0.5, key: 1.1 }));
    return feedback(ctx, { input: staged, amount: trail.signal(), zoom: 1.006 });
  },
});
