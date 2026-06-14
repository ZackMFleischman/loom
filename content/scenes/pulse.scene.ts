import { Signal, defineScene } from "@loom/runtime";
import { lfo } from "../modules/control/lfo";
import { feedback } from "../modules/effects/feedback";
import { levels } from "../modules/effects/levels";
import { pulseRings } from "../modules/sources/pulseRings";

/**
 * M1 demo, M5-promoted: kick-reactive ink feedback driven by the input rack.
 * The `kick` and `bass` channels (content/inputs.ts) replace the scene's old
 * hand-rolled detector — tune them for the room once, every consumer follows.
 */
export default defineScene({
  name: "pulse",
  description: "Kick-reactive feedback rings with a slowly drifting palette.",
  tags: ["audio-reactive", "feedback", "demo"],
  build(ctx) {
    const punch = ctx.float("punch", { default: 1.2, min: 0, max: 3, description: "kick hit strength" });
    const trail = ctx.float("trail", { default: 0.88, min: 0.5, max: 0.97, description: "feedback persistence" });
    const drift = ctx.float("drift", { default: 1.015, min: 0.98, max: 1.06, description: "trail zoom drift" });

    const kickEnv = ctx.input("kick"); // rack channel: bass onsets → envelope
    const bass = ctx.input("bass"); // rack channel: lagged bass energy
    const punchSig = punch.signal();
    const energy = new Signal(
      (f) => kickEnv.get(f) * punchSig.get(f) + bass.get(f) * 0.6 + 0.06,
    );

    const rings = pulseRings(ctx, { energy, hue: lfo(ctx, { shape: "sine", periodBeats: 16 }) });
    const trails = feedback(ctx, { input: rings, amount: trail.signal(), zoom: drift.signal() });
    return levels(ctx, {
      input: trails,
      gain: bass.map((b) => 1 + b * 0.7),
      gamma: 1.15,
    });
  },
});
