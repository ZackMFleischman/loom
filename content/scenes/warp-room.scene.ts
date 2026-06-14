import { defineScene, Signal } from "@loom/runtime";
import { colorize } from "../modules/effects/colorize";
import { displace } from "../modules/effects/displace";
import { mirror } from "../modules/effects/mirror";
import { tile } from "../modules/effects/tile";
import { gradient } from "../modules/sources/gradient";
import { voronoi } from "../modules/sources/voronoi";

export default defineScene({
  name: "warp-room",
  description:
    "A palette wash warped by living voronoi cells, folded through a mirror and tiled into a breathing wall — bass pushes the warp.",
  tags: ["displace", "voronoi", "symmetry", "audio-reactive", "showcase"],
  build(ctx) {
    const warp = ctx.float("warp.amount", { default: 0.08, min: 0, max: 0.3, step: 0.005, description: "voronoi warp strength" });
    const surge = ctx.float("warp.surge", { default: 0.1, min: 0, max: 0.3, step: 0.005, description: "extra warp per bass" });
    const cells = ctx.float("warp.cells", { default: 5, min: 1, max: 12, description: "voronoi cell density" });
    const drift = ctx.float("warp.drift", { default: 0.5, min: 0, max: 3, description: "cell wander speed" });
    const foldAngle = ctx.float("fold.angle", { default: 0.6, min: -3.1416, max: 3.1416, step: 0.01, description: "mirror fold angle" });
    const wallX = ctx.int("wall.countX", { default: 2, min: 1, max: 8, description: "wall tiles across" });
    const wallY = ctx.int("wall.countY", { default: 2, min: 1, max: 8, description: "wall tiles down" });

    const bass = ctx.input("bass");
    const warpSig = warp.signal();
    const surgeSig = surge.signal();

    const bed = colorize(ctx, {
      input: gradient(ctx, { mode: "angular", scroll: 0.03 }),
      palette: 4,
      bands: 1.4,
    });
    const map = voronoi(ctx, { scale: cells.signal(), speed: drift.signal() });
    const warped = ctx.layer(
      "warped",
      displace(ctx, {
        input: bed,
        map,
        amount: new Signal((f) => warpSig.get(f) + bass.get(f) * surgeSig.get(f)),
      }),
    );
    const folded = mirror(ctx, { input: warped, angle: foldAngle.signal() });
    return tile(ctx, { input: folded, countX: wallX.signal(), countY: wallY.signal(), mirrorTiles: 1 });
  },
});
