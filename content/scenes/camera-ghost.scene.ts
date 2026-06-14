import { defineScene, Signal } from "@loom/runtime";
import { echo } from "../modules/effects/echo";
import { invert } from "../modules/effects/invert";
import { key } from "../modules/effects/key";
import { over } from "../modules/effects/over";
import { posterize } from "../modules/effects/posterize";
import { gradient } from "../modules/sources/gradient";
import { webcam } from "../modules/sources/webcam";

export default defineScene({
  name: "camera-ghost",
  description:
    "Your camera, luma-keyed onto a palette wash, ghosted by frame echoes, poster-crushed — the kick flashes the negative.",
  tags: ["webcam", "key", "echo", "audio-reactive", "showcase"],
  build(ctx) {
    const keyTol = ctx.float("key.tolerance", { default: 0.18, min: 0, max: 1, step: 0.01, description: "how much dark keys away" });
    const keySoft = ctx.float("key.softness", { default: 0.12, min: 0.001, max: 0.5, step: 0.01, description: "key edge softness" });
    const ghost = ctx.float("ghost.amount", { default: 0.5, min: 0, max: 1, description: "echo blend" });
    const ghostDelay = ctx.int("ghost.delay", { default: 12, min: 0, max: 23, description: "echo distance (frames)" });
    const crush = ctx.int("crush.steps", { default: 5, min: 2, max: 32, description: "poster color steps" });
    const flash = ctx.float("flash", { default: 0.8, min: 0, max: 1, description: "kick-driven negative flash" });

    const kick = ctx.input("kick");
    const flashSig = flash.signal();

    const cam = ctx.layer(
      "cam",
      key(ctx, {
        input: webcam(ctx, {}),
        mode: "luma",
        tolerance: keyTol.signal(),
        softness: keySoft.signal(),
      }),
    );
    const ghosted = echo(ctx, { input: cam, delay: ghostDelay.signal(), amount: ghost.signal() });
    const wash = gradient(ctx, { mode: "radial", scroll: 0.015 });
    const staged = over(ctx, { input: wash, overlay: ghosted });
    const crushed = posterize(ctx, { input: staged, steps: crush.signal() });
    return invert(ctx, { input: crushed, amount: new Signal((f) => kick.get(f) * flashSig.get(f)) });
  },
});
