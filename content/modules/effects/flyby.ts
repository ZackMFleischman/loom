import { BuildCtx, defineModule, Signal, type SignalLike, type TexNode } from "@loom/runtime";
import { image } from "../sources/image";
import { over } from "./over";

export interface FlybyOpts {
  input: TexNode;
  /** One sprite per image URL (transparent PNGs read best). */
  urls: string[];
  /** Sprite half-height as a fraction of screen height. */
  size?: SignalLike;
  /** Flight speed multiplier (0 freezes the flock mid-air). */
  speed?: SignalLike;
  /** Flock opacity 0..1 — fade them in for the drop. */
  opacity?: SignalLike;
  /** How many sprites are visible (0..urls.length, fractional fades; default all). */
  count?: SignalLike;
}

const get = (v: SignalLike, f: Parameters<Signal<number>["get"]>[0]) =>
  typeof v === "number" ? v : v.get(f);

/**
 * A flock of image sprites swooping around the screen on top of any input.
 * Pure composition of the building blocks: each sprite is an `image` with a
 * live Transform2D (deterministic Lissajous path per index — tilting into
 * the motion, mirroring to face its heading) layered on with `over`. The
 * flight phase integrates a speed signal, so retuning speed never teleports
 * the flock.
 */
export const flyby = defineModule(
  {
    name: "flyby",
    kind: "effect",
    description: "Image sprites (logos, critters) flying around the screen over any input.",
    tags: ["sprites", "overlay", "composite", "fun"],
    example: 'flyby(ctx, { input: chain, urls: hippoUrls, size: 0.16, speed: 0.6 })',
  },
  (ctx: BuildCtx, opts: FlybyOpts): TexNode => {
    const size = opts.size ?? 0.16;
    const speed = opts.speed ?? 0.6;
    const opacity = opts.opacity ?? 1;
    const count = opts.count ?? opts.urls.length;

    // Integrate speed into a phase so live speed changes never jump positions.
    let acc = 0;
    const phase = new Signal((f) => {
      acc += get(speed, f) * f.dt;
      return acc;
    });

    return opts.urls.reduce((chain, url, i) => {
      // Deterministic per-sprite path constants (golden-angle scattered).
      const o1 = i * 2.39996;
      const o2 = i * 4.71239 + 1.3;
      const o3 = i * 1.61803;
      const s1 = 0.55 + 0.4 * ((i * 0.618) % 1);
      const s2 = 0.45 + 0.4 * ((i * 0.382) % 1);

      const sprite = image(ctx, {
        url,
        transform: {
          x: new Signal((f) => 0.5 + 0.42 * Math.sin(phase.get(f) * s1 + o1)),
          y: new Signal((f) => 0.5 + 0.33 * Math.sin(phase.get(f) * s2 + o2)),
          rotate: new Signal((f) => 0.3 * Math.sin(phase.get(f) * s1 * 0.7 + o3)),
          scale: new Signal((f) => get(size, f) * (1 + 0.15 * Math.sin(phase.get(f) * s2 * 1.7 + o1))),
          mirrorX: new Signal((f) => (Math.cos(phase.get(f) * s1 + o1) >= 0 ? 1 : -1)),
        },
      });
      // Sprite i fades out as count drops below i+1 (fractional counts blend).
      const visible = new Signal((f) =>
        get(opacity, f) * Math.max(0, Math.min(1, get(count, f) - i)),
      );
      return over(ctx, { input: chain, overlay: sprite, opacity: visible });
    }, opts.input);
  },
);
