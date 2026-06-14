import { defineScene, Signal, texNode } from "@loom/runtime";
import { mix, uv, vec2, vec3, vec4 } from "three/tsl";

/**
 * The default PANIC safe scene: a slow-breathing radial gradient. No audio,
 * no feedback, no global-palette dependency — a self-contained, cheap,
 * dark-but-not-black visual that always renders, so the escape hatch can
 * never fail to open. `content/scenes/panic.scene.ts` points here out of the
 * box; repoint that file to designate a different safe target.
 */
export default defineScene({
  name: "safe",
  description: "Slow-breathing radial gradient — the default PANIC safe scene (audio-independent).",
  tags: ["panic", "safe", "minimal"],
  build(ctx) {
    const level = ctx.float("level", {
      default: 0.4,
      min: 0,
      max: 1,
      description: "overall brightness",
    });
    const period = ctx.float("period", {
      default: 8,
      min: 1,
      max: 30,
      description: "breath length in seconds",
    });

    const levelS = level.signal();
    const periodS = period.signal();
    // Stateful breath phase: advances dt/period each frame, eased to 0..1.
    // uniformOf registration guarantees the per-frame pull.
    let phase = 0;
    const breathU = ctx.uniformOf(
      new Signal((f) => {
        phase = (phase + f.dt / Math.max(0.001, periodS.get(f))) % 1;
        return Math.sin(phase * Math.PI * 2) * 0.5 + 0.5;
      }),
    );
    const levelU = ctx.uniformOf(levelS);

    // Radial falloff: a calm core fading to near-black at the edges.
    const d = uv().sub(vec2(0.5)).length().mul(1.6).clamp(0, 1);
    const core = vec3(0.16, 0.22, 0.42);
    const edge = vec3(0.02, 0.03, 0.07);
    const grad = mix(core, edge, d);
    // Brightness breathes between 55% and 100% of `level`.
    const bright = levelU.mul(breathU.mul(0.45).add(0.55));
    return texNode(vec4(grad.mul(bright), 1));
  },
});
