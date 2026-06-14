import { BuildCtx, defineModule, Signal, texNode, type Pass, type SignalLike, type TexNode } from "@loom/runtime";
import { abs, clamp, cos, float, select, sin, step, texture, uv, vec2, vec4 } from "three/tsl";
import { SRGBColorSpace, TextureLoader, type Node } from "three/webgpu";

export interface SpriteSwarmOpts {
  /** Sprite-atlas URL: a cols x rows grid of equal square cells. */
  url: string;
  /** Atlas grid columns (compile-time constant). */
  cols: number;
  /** Atlas grid rows (compile-time constant). */
  rows: number;
  /** How many cells are actually used (default cols*rows); sprites cycle through them. */
  cells?: number;
  /** Hard ceiling on sprites baked into the shader (compile-time constant). */
  maxCount?: number;
  /** How many sprites are visible (runtime, fractional fades; default all). */
  count?: SignalLike;
  /** Sprite half-height as a fraction of screen height. */
  size?: SignalLike;
  /** Flight speed multiplier (0 freezes the swarm mid-air). */
  speed?: SignalLike;
  /** Output aspect ratio, keeps sprites square (compile-time constant). */
  aspect?: number;
}

const get = (v: SignalLike, f: Parameters<Signal<number>["get"]>[0]) =>
  typeof v === "number" ? v : v.get(f);

/**
 * A flock of textured sprites from ONE atlas texture — unlike chaining
 * `image` layers (one sampler each, WebGL2 caps a shader at ~16), this
 * scales to dozens of sprites with a single sampler. Same deterministic
 * Lissajous flight paths as `flyby` (tilt into the motion, mirror to face
 * heading), with a runtime `count` so a knob can ladle more in. Emits
 * premultiplied alpha — composite with `over`.
 */
export const spriteSwarm = defineModule(
  {
    name: "spriteSwarm",
    kind: "source",
    description: "Many flying sprites from a single atlas texture (runtime count, one sampler).",
    tags: ["sprites", "atlas", "particles", "overlay", "fun"],
    example: 'spriteSwarm(ctx, { url: atlasUrl, cols: 3, rows: 2, maxCount: 18, count: amountSig })',
  },
  (ctx: BuildCtx, opts: SpriteSwarmOpts): TexNode => {
    const cells = opts.cells ?? opts.cols * opts.rows;
    const maxCount = opts.maxCount ?? 12;
    const aspect = opts.aspect ?? 16 / 9;
    const countU = ctx.uniformOf(opts.count ?? maxCount);
    const size = ctx.uniformOf(opts.size ?? 0.16);
    const speed = opts.speed ?? 0.6;

    // Integrate speed into a phase so live speed changes never jump positions.
    let phaseAcc = 0;
    const phaseU = ctx.uniformOf(new Signal((f) => (phaseAcc += get(speed, f) * f.dt)));

    let acc: Node<"vec4"> = vec4(0, 0, 0, 0);
    const tex = new TextureLoader().load(opts.url);
    tex.colorSpace = SRGBColorSpace;

    for (let i = 0; i < maxCount; i++) {
      // Deterministic per-sprite path constants (golden-angle scattered).
      const o1 = i * 2.39996;
      const o2 = i * 4.71239 + 1.3;
      const o3 = i * 1.61803;
      const s1 = 0.55 + 0.4 * ((i * 0.618) % 1);
      const s2 = 0.45 + 0.4 * ((i * 0.382) % 1);

      const cx = sin(phaseU.mul(s1).add(o1)).mul(0.42).add(0.5);
      const cy = sin(phaseU.mul(s2).add(o2)).mul(0.33).add(0.5);
      const rot = sin(phaseU.mul(s1 * 0.7).add(o3)).mul(0.3);
      const s = size.mul(sin(phaseU.mul(s2 * 1.7).add(o1)).mul(0.15).add(1)).max(1e-4);

      // Screen -> sprite-local cell coords ([-0.5, 0.5] covers the sprite).
      const mirror = select(cos(phaseU.mul(s1).add(o1)).greaterThan(0), float(1), float(-1));
      const lx = uv().x.sub(cx).mul(aspect).div(s.mul(2)).mul(mirror);
      const ly = uv().y.sub(cy).div(s.mul(2));
      const ca = cos(rot);
      const sa = sin(rot);
      const rx = lx.mul(ca).sub(ly.mul(sa));
      const ry = lx.mul(sa).add(ly.mul(ca));

      // Atlas cell sample (v runs top-down, like the image module).
      const col = (i % cells) % opts.cols;
      const row = Math.floor((i % cells) / opts.cols);
      const auv = vec2(rx.add(0.5).add(col).div(opts.cols), float(0.5).sub(ry).add(row).div(opts.rows));
      const smp = texture(tex, auv);

      const inside = step(abs(rx), 0.499).mul(step(abs(ry), 0.499));
      const vis = clamp(countU.sub(float(i)), 0, 1);
      const a = smp.a.mul(inside).mul(vis);
      // Premultiplied "over": later sprites paint on top.
      acc = vec4(smp.rgb.mul(a).add(acc.rgb.mul(a.oneMinus())), a.add(acc.a.mul(a.oneMinus())));
    }

    const pass: Pass = {
      render() {}, // no per-frame work — owns the atlas texture's lifetime
      dispose() {
        tex.dispose();
      },
    };
    return texNode(acc, [pass]);
  },
);
