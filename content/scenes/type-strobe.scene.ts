import { defineScene, Signal } from "@loom/runtime";
import { counter } from "../modules/control/counter";
import { gate } from "../modules/control/gate";
import { sampleHold } from "../modules/control/sampleHold";
import { lfo } from "../modules/control/lfo";
import { over } from "../modules/effects/over";
import { solid } from "../modules/sources/solid";
import { text } from "../modules/sources/text";

const LINES = ["DJ", "HIPPO", "IN THE", "HOUSE"];

export default defineScene({
  name: "type-strobe",
  description:
    "Title cards step line-by-line on the kick — each hit re-rolls the placement, the bass gate strobes the backdrop.",
  tags: ["text", "strobe", "type", "audio-reactive", "showcase"],
  build(ctx) {
    const size = ctx.float("type.size", { default: 0.45, min: 0.1, max: 1.5, description: "title scale" });
    const throwAmt = ctx.float("type.throw", { default: 0.18, min: 0, max: 0.4, description: "how far each hit throws the line" });
    const strobe = ctx.float("strobe.amount", { default: 0.5, min: 0, max: 1, description: "bass-gated backdrop flash level" });
    const strobeAt = ctx.float("strobe.threshold", { default: 0.45, min: 0, max: 1, description: "bass level that fires the strobe" });

    const kick = ctx.input("kick");
    const bass = ctx.input("bass");

    // Step through the lines on each kick; re-roll placement per hit.
    const step = counter(ctx, { trigger: kick, wrap: LINES.length });
    const throwSig = throwAmt.signal();
    const heldX = sampleHold(ctx, { input: lfo(ctx, { shape: "sine", periodBeats: 2.7 }), trigger: kick });
    const heldY = sampleHold(ctx, { input: lfo(ctx, { shape: "sine", periodBeats: 1.9 }), trigger: kick, initial: 0.5 });

    // Bass-gated backdrop strobe (palette accent stop).
    const strobeSig = strobe.signal();
    const flash = gate(ctx, { input: bass, threshold: strobeAt.signal(), hysteresis: 0.08 });
    const backdrop = solid(ctx, { paletteStop: 1, level: new Signal((f) => 0.12 + flash.get(f) * strobeSig.get(f)) });

    // One text layer per line; only the active step shows. Placement signals
    // are shared — every hit moves the NEXT line to a fresh spot.
    const sizeSig = size.signal();
    let staged = backdrop;
    LINES.forEach((line, i) => {
      const visible = new Signal((f) => (step.get(f) === i ? 1 : 0));
      const t = text(ctx, {
        text: line,
        weight: 900,
        transform: {
          scale: new Signal((f) => sizeSig.get(f) * visible.get(f)),
          x: new Signal((f) => 0.5 + heldX.get(f) * throwSig.get(f)),
          y: new Signal((f) => 0.5 + (heldY.get(f) - 0.5) * throwSig.get(f) * 2),
        },
      });
      staged = over(ctx, { input: staged, overlay: t });
    });
    return ctx.layer("titles", staged);
  },
});
