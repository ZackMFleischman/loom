import { defineScene, Signal, texNode } from "@loom/runtime";
import { fract, uv } from "three/tsl";

/**
 * Full-screen horizontal gradient across the active palette's five stops,
 * slowly scrolling. The simplest ctx.palette.ramp consumer — retint it from
 * the Console palettes drawer or flip palette.source live.
 */
export default defineScene({
  name: "gradient",
  description: "Scrolling horizontal gradient across the active palette's five stops.",
  tags: ["palette", "gradient", "minimal"],
  build(ctx) {
    const speed = ctx.float("speed", {
      default: 0.02,
      min: 0,
      max: 0.5,
      description: "scroll speed (ramps per second)",
    });
    const speedS = speed.signal();
    let phase = 0;
    // Stateful: uniformOf registration guarantees the per-frame pull.
    const phaseU = ctx.uniformOf(new Signal((f) => (phase = (phase + f.dt * speedS.get(f)) % 1)));
    return texNode(ctx.palette.ramp(fract(uv().x.add(phaseU))));
  },
});
