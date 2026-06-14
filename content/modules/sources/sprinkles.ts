import { BuildCtx, defineModule, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import { cos, float, fract, length, max, pow, select, sin, smoothstep, uv, vec2, vec3, vec4 } from "three/tsl";
import type { Node } from "three/webgpu";
import { parseHex, surfaceAspect } from "../_shared";

const TAU = Math.PI * 2;

/** Candy-coated sprinkle colors — classic jimmies jar. */
const CANDY = ["#ff4f7e", "#ffd24f", "#4fd2ff", "#7dff6b", "#b06bff", "#ff8a3d", "#fff6f0"];

/** Deterministic per-sprinkle pseudo-random in [0,1) — stable across rebuilds. */
const rand = (i: number, k: number) => {
  const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

export interface SprinklesOpts {
  /** Hard ceiling on sprinkles baked into the shader (compile-time). Default 44. */
  maxCount?: number;
  /** How many sprinkles are live (runtime SignalLike — ride a burst envelope). */
  count?: SignalLike;
  /** Rod half-length in uv-height units. */
  size?: SignalLike;
  /** Rod radius as a fraction of its length. */
  thickness?: SignalLike;
  /** Toss cadence — re-throws per second per sprinkle (steady; phase-stable). */
  cadence?: SignalLike;
  /** Brightness flash on bursts — feed a kick envelope. */
  burst?: SignalLike;
  /** Overall gain. */
  brightness?: SignalLike;
  // --- swirl geometry: MUST match the softServe these land on (so they stick). ---
  /** Swirl base in uv-y. */
  baseY?: number;
  /** Swirl tip in uv-y. */
  tipY?: number;
  /** Swirl base half-width (aspect-corrected x units). */
  width?: SignalLike;
  /** Swirl axis sway. */
  sway?: SignalLike;
  /** Swirl tip lean. */
  hook?: SignalLike;
  /** Coil climb speed the stuck sprinkles ride along with. */
  flow?: SignalLike;
}

/**
 * Sprinkles tossed onto a soft-serve swirl: each candy rod flies in from a
 * random edge angle, lands on the cream surface (placed with the SAME profile
 * math `softServe` uses, so it sits ON the swirl) and then sticks — riding the
 * coil climb as fresh cream is added. Re-throws on its own cadence; drive
 * `count` with a kick envelope + a beat LFO for bursts and cadences, and
 * `burst` for a flash on the hit. Premultiplied alpha overlay.
 */
export const sprinkles = defineModule(
  {
    name: "sprinkles",
    kind: "source",
    description:
      "Candy sprinkles flung in from every edge angle that land on a soft-serve swirl and stick, riding the coil climb (premultiplied alpha).",
    tags: ["ice-cream", "sprinkles", "particles", "overlay", "burst", "audio-reactive", "fun"],
    example: 'sprinkles(ctx, { count: burstCountSig, burst: ctx.input("kick") })',
  },
  (ctx: BuildCtx, opts: SprinklesOpts = {}): TexNode => {
    const maxCount = opts.maxCount ?? 44;
    const countU = ctx.uniformOf(opts.count ?? 16);
    const size = ctx.uniformOf(opts.size ?? 0.018);
    const thickness = ctx.uniformOf(opts.thickness ?? 0.34);
    const cadence = ctx.uniformOf(opts.cadence ?? 0.4);
    const burst = ctx.uniformOf(opts.burst ?? 0);
    const brightness = ctx.uniformOf(opts.brightness ?? 1);
    const baseY = opts.baseY ?? 0.34;
    const tipY = opts.tipY ?? 0.82;
    const width = ctx.uniformOf(opts.width ?? 0.3);
    const sway = ctx.uniformOf(opts.sway ?? 0.03);
    const hook = ctx.uniformOf(opts.hook ?? 0.1);
    const flow = ctx.uniformOf(opts.flow ?? 0.4);

    // x is aspect-corrected & centered; y stays in uv — matches softServe's frame.
    const px = uv().x.sub(0.5).mul(surfaceAspect());
    const py = float(1).sub(uv().y); // flip to match softServe/waffleCone (engine uv-y=0 is screen top)
    // Frame-clock time, NOT TSL `time` (wall clock) — keeps fixture replays deterministic.
    const t = ctx.uniformOf(ctx.time.now);
    const span = float(tipY - baseY);
    const intro = 0.16; // fraction of each cycle spent flying in before it sticks

    let rgb: Node<"vec3"> = vec3(0);
    let cover: Node<"float"> = float(0);
    for (let i = 0; i < maxCount; i++) {
      // Stuck home on the swirl, climbing with the coils (so it rides the cream).
      const sHome = fract(float(rand(i, 1) * 0.8 + 0.1).add(t.mul(flow).mul(0.12)));
      const fracL = rand(i, 2) - 0.5; // -0.5..0.5 across the local width
      const xc = sin(sHome.mul(3).add(t.mul(0.5))).mul(sway).mul(sHome)
        .add(hook.mul(smoothstep(float(0.6), float(1), sHome)));
      const taper = pow(max(float(1).sub(sHome), float(0)), float(0.55));
      const homeX = xc.add(float(fracL * 1.5).mul(width.mul(taper)));
      const homeY = sHome.mul(span).add(baseY);

      // Phase-stable re-throw cycle: fly in from an edge, then stick the rest.
      const cyc = fract(t.mul(cadence).mul(0.6 + rand(i, 4) * 0.7).add(rand(i, 5)));
      const a0 = rand(i, 6) * TAU;
      const startX = homeX.add(float(Math.cos(a0) * 1.7));
      const startY = homeY.add(float(Math.sin(a0) * 1.2));
      const flyT = smoothstep(float(0), float(intro), cyc);
      const ease = flyT.mul(flyT).mul(float(3).sub(flyT.mul(2))); // smoothstep ease-in
      const posX = startX.mul(float(1).sub(ease)).add(homeX.mul(ease));
      const posY = startY.mul(float(1).sub(ease)).add(homeY.mul(ease));
      // Fade in on launch, fade out before the re-throw so it never pops.
      const vis = smoothstep(float(0), float(0.05), cyc).mul(smoothstep(float(1), float(0.85), cyc));

      // Tumble while flying, settle to a fixed lie once stuck.
      const ang = float(rand(i, 7) * TAU).add(t.mul(2.4 + rand(i, 8) * 3).mul(float(1).sub(flyT)));
      const c = cos(ang);
      const sn = sin(ang);
      const lx = px.sub(posX);
      const ly = py.sub(posY);
      const qx = lx.mul(c).add(ly.mul(sn));
      const qy = ly.mul(c).sub(lx.mul(sn));
      const len = size.mul(0.7 + rand(i, 9) * 0.7);
      const rad = len.mul(thickness).max(1e-4);
      const d = length(vec2(qx.abs().sub(len).max(0), qy));
      const rod = smoothstep(rad, rad.mul(0.5), d);

      const [r, g, b] = parseHex(CANDY[Math.floor(rand(i, 10) * CANDY.length) % CANDY.length]!);
      const gain = rod.mul(vis).mul(select(float(i).lessThan(countU), float(1), float(0)));
      rgb = rgb.add(vec3(r, g, b).mul(gain));
      cover = cover.add(gain);
    }

    const flash = burst.mul(0.6).add(1).mul(brightness);
    return texNode(vec4(rgb.mul(flash), cover.clamp(0, 1)));
  },
);
