import { defineScene, Signal } from "@loom/runtime";
import { bloom } from "../modules/effects/bloom";
import { kaleido } from "../modules/effects/kaleido";
import { levels } from "../modules/effects/levels";
import { box } from "../modules/geo/box";
import { orbitCam } from "../modules/geo/orbitCam";
import { sphere } from "../modules/geo/sphere";
import { torus } from "../modules/geo/torus";
import { render3d } from "../modules/sources/render3d";

export default defineScene({
  name: "prism-array",
  description:
    "A formal array of hard-edged primitives — four corner boxes, a chrome torus, a kick-punched core sphere — folded through a bass-spun kaleidoscope under an orbiting camera.",
  tags: ["3d", "geo", "primitives", "kaleidoscope", "audio-reactive", "geometric"],
  build(ctx) {
    // Console groups: cam / world / fold / glow.
    const camSpeed = ctx.float("cam.speed", { default: 0.35, min: -2, max: 2, description: "orbit speed (rad/s, negative = reverse)" });
    const camRadius = ctx.float("cam.radius", { default: 4, min: 1.5, max: 9, description: "orbit distance" });
    const camHeight = ctx.float("cam.height", { default: 1.2, min: -2, max: 4, description: "camera height" });
    const spin = ctx.float("world.spin", { default: 0.6, min: -3, max: 3, description: "primitive spin (rad/s)" });
    const punch = ctx.float("world.punch", { default: 1, min: 0, max: 3, description: "kick-driven core scale + glow hit" });
    const segments = ctx.int("fold.segments", { default: 6, min: 2, max: 12, description: "kaleido wedge count" });
    const foldDrive = ctx.float("fold.drive", { default: 1, min: 0, max: 4, description: "bass-driven fold spin rate" });
    const foldAmount = ctx.float("fold.amount", { default: 0.85, min: 0, max: 1, description: "fold blend (0 = raw 3D stage)" });
    const glow = ctx.float("glow.kick", { default: 0.8, min: 0, max: 2.5, description: "kick-driven bloom intensity" });

    const kick = ctx.input("kick");
    const bass = ctx.input("bass");
    const punchSig = punch.signal();
    const hit = new Signal((f) => kick.get(f) * punchSig.get(f));

    // Bass integrates into the fold's rotation phase: heavier bass = faster mandala spin.
    let phase = 0;
    const driveSig = foldDrive.signal();
    const foldSpin = new Signal((f) => (phase += f.dt * (0.05 + bass.get(f) * driveSig.get(f))));

    const corners = [0, 1, 2, 3].map((i) => {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      return box(ctx, {
        size: [0.42, 0.42, 0.42],
        position: [Math.cos(a) * 1.5, 0, Math.sin(a) * 1.5],
        spin: spin.signal(),
        color: "#3fb7f0",
        metalness: 0.7,
        roughness: 0.25,
      });
    });
    const world = [
      ...corners,
      torus(ctx, { radius: 0.95, tube: 0.14, spin: spin.signal(), tumble: 0.3, color: "#f06bd3", metalness: 0.6, roughness: 0.3 }),
      sphere(ctx, {
        radius: 0.3,
        color: "#ffd24a",
        glow: hit,
        scale: new Signal((f) => 1 + hit.get(f) * 0.5),
      }),
    ];
    const cam = orbitCam(ctx, {
      radius: camRadius.signal(),
      height: camHeight.signal(),
      speed: camSpeed.signal(),
      fov: 45,
    });
    const stage = ctx.layer(
      "prisms",
      render3d(ctx, { world, cam, ambient: 0.45, key: new Signal((f) => 1.1 + hit.get(f) * 0.8) }),
    );
    const folded = kaleido(ctx, { input: stage, segments: segments.signal(), rotate: foldSpin, amount: foldAmount.signal() });
    const glowSig = glow.signal();
    const lit = bloom(ctx, { input: folded, level: 0.55, intensity: new Signal((f) => 0.3 + hit.get(f) * glowSig.get(f)) });
    return levels(ctx, { input: lit, gain: 1.05, gamma: 1.05 });
  },
});
