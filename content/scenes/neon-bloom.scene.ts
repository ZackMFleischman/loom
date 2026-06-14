import { defineScene, Signal } from "@loom/runtime";
import { envelope } from "../modules/control/envelope";
import { bloom } from "../modules/effects/bloom";
import { levels } from "../modules/effects/levels";
import { over } from "../modules/effects/over";
import { gradient } from "../modules/sources/gradient";
import { shape } from "../modules/sources/shape";

export default defineScene({
  name: "neon-bloom",
  description:
    "Neon rings detonate from the center on every kick and bloom over a slow radial palette wash.",
  tags: ["rings", "bloom", "palette", "audio-reactive", "showcase"],
  build(ctx) {
    const punch = ctx.float("ring.punch", { default: 0.45, min: 0, max: 1, description: "how far a kick throws the rings" });
    const release = ctx.float("ring.release", { default: 0.45, min: 0.05, max: 2, description: "ring fall time (s)" });
    const width = ctx.float("ring.width", { default: 0.05, min: 0.005, max: 0.3, description: "ring stroke width" });
    const glowLevel = ctx.float("glow.level", { default: 0.45, min: 0, max: 1, description: "luma where the glow starts" });
    const glowAmt = ctx.float("glow.intensity", { default: 1.2, min: 0, max: 3, description: "glow strength" });
    const glowSize = ctx.float("glow.radius", { default: 22, min: 1, max: 60, description: "glow spread (px)" });
    const wash = ctx.float("wash.level", { default: 0.25, min: 0, max: 1, description: "backdrop gradient brightness" });

    const kick = ctx.input("kick");
    const env = envelope(ctx, { input: kick, attack: 0.004, release: release.signal() });
    const punchSig = punch.signal();

    const bg = gradient(ctx, { mode: "radial", scroll: 0.02, repeat: 1.5 });
    const bgDim = ctx.layer("wash", levels(ctx, { input: bg, gain: wash.signal() }));

    const ringA = shape(ctx, {
      kind: "ring",
      radius: new Signal((f) => 0.12 + env.get(f) * punchSig.get(f)),
      thickness: width.signal(),
      soft: 0.04,
      paletteStop: 4,
    });
    const ringB = shape(ctx, {
      kind: "ring",
      radius: new Signal((f) => 0.2 + env.get(f) * punchSig.get(f) * 1.6),
      thickness: width.signal(),
      soft: 0.06,
      paletteStop: 2,
    });

    const rings = ctx.layer("rings", over(ctx, { input: ringA, overlay: ringB }));
    const staged = over(ctx, { input: bgDim, overlay: rings });
    return bloom(ctx, {
      input: staged,
      level: glowLevel.signal(),
      intensity: glowAmt.signal(),
      radius: glowSize.signal(),
    });
  },
});
