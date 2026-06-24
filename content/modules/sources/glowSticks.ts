import { BuildCtx, defineModule, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import { cos, float, length, max, mix, select, sin, smoothstep, uv, vec2, vec3, vec4 } from "three/tsl";
import type { Node } from "three/webgpu";
import { parseHex, surfaceAspect } from "../_shared";

const TAU = Math.PI * 2;

/** Classic festival glow-stick neon — the hi-vis crack-and-glow jar. */
const NEON = ["#39ff14", "#ff2fd0", "#00f0ff", "#faff00", "#ff7a00", "#2f6bff", "#b026ff", "#ff2d2d"];

/** Deterministic per-stick pseudo-random in [0,1) — stable across rebuilds. */
const rand = (i: number, k: number) => {
  const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

export interface GlowSticksOpts {
  /** Hard ceiling on glow sticks baked into the shader (compile-time). Default 30. */
  maxCount?: number;
  /** How many sticks are airborne (runtime SignalLike) — ride a kick envelope so the crowd erupts on the drop. */
  count?: SignalLike;
  /** Throw cadence — re-launches per second per stick (each on its own staggered clock). */
  cadence?: SignalLike;
  /** Brightness flash on the drop — feed a kick envelope. */
  burst?: SignalLike;
  /** Stick half-length (uv-height units). */
  size?: SignalLike;
  /** Stick radius as a fraction of its length. */
  thickness?: SignalLike;
  /** Peak arc height of the throw (uv-height units) — how high they fly. */
  arc?: SignalLike;
  /** Horizontal scatter of the launch points across the crowd (aspect-corrected x units). */
  spread?: SignalLike;
  /** Lateral throw velocity — how far sticks fan out sideways over a flight. */
  lateral?: SignalLike;
  /** Tumble rate — end-over-end spin while flying. */
  tumble?: SignalLike;
  /** Glow-halo size around each stick (multiples of its radius). */
  glow?: SignalLike;
  /** Motion-streak gain (0 = no trail). */
  trail?: SignalLike;
  /** Trail ghost samples baked in (compile-time; set 0 to drop the cost). Default 3. */
  trailSamples?: number;
  /** Overall gain. */
  brightness?: SignalLike;
}

/**
 * The drop hits and the whole crowd hurls glow sticks into the air: neon
 * capsules launch from below the frame, arc up under gravity, tumble
 * end-over-end and rain back down — each one a glowing tube (bright core +
 * colored halo) trailing a faint light-streak. Every stick re-throws on its
 * own staggered clock, so it reads as a continuous festival storm; drive
 * `count` with a kick envelope to make the eruption land on the beat, and
 * `burst` for the flash. Premultiplied alpha for over+bloom. Frame-clocked, so
 * fixture replays are byte-identical.
 */
export const glowSticks = defineModule(
  {
    name: "glowSticks",
    kind: "source",
    description:
      "An eruption of neon glow sticks flung up from the crowd — capsules arc under gravity, tumble and glow, raining back down; flares on the drop. Premultiplied for over+bloom.",
    tags: ["festival", "rave", "glow-stick", "neon", "particles", "explosion", "overlay", "audio-reactive"],
    example: 'glowSticks(ctx, { count: 24, burst: ctx.input("kick") })',
  },
  (ctx: BuildCtx, opts: GlowSticksOpts = {}): TexNode => {
    const maxCount = Math.max(1, Math.round(opts.maxCount ?? 30));
    const trailSamples = Math.max(0, Math.round(opts.trailSamples ?? 3));

    const countU = ctx.uniformOf(opts.count ?? 22);
    const cadence = ctx.uniformOf(opts.cadence ?? 0.5);
    const burst = ctx.uniformOf(opts.burst ?? 0);
    const size = ctx.uniformOf(opts.size ?? 0.05);
    const thickness = ctx.uniformOf(opts.thickness ?? 0.17);
    const arc = ctx.uniformOf(opts.arc ?? 0.95);
    const spread = ctx.uniformOf(opts.spread ?? 0.95);
    const lateral = ctx.uniformOf(opts.lateral ?? 0.28);
    const tumble = ctx.uniformOf(opts.tumble ?? 1);
    const glow = ctx.uniformOf(opts.glow ?? 3);
    const trail = ctx.uniformOf(opts.trail ?? 0.7);
    const brightness = ctx.uniformOf(opts.brightness ?? 1);

    // x aspect-corrected & centered; y flipped so 0 = screen bottom (the crowd), 1 = top.
    const asp = surfaceAspect();
    const px = uv().x.sub(0.5).mul(asp);
    const py = float(1).sub(uv().y);
    // Frame-clock time, NOT TSL `time` (wall clock) — keeps fixture replays deterministic.
    const t = ctx.uniformOf(ctx.time.now);
    const baseY = -0.14; // launch/land just below the frame (hands in the crowd)
    const trailDt = 0.014; // arc-time step between motion-streak ghosts

    let rgb: Node<"vec3"> = vec3(0);
    let alpha: Node<"float"> = float(0);

    for (let i = 0; i < maxCount; i++) {
      // Phase-stable re-throw cycle, staggered per stick → a continuous storm.
      const cyc = cadence.mul(0.6 + rand(i, 4) * 0.7).mul(t).add(rand(i, 5)).fract();

      // Ballistic arc: rises to `peak` at mid-flight, falls back below the frame.
      const launchX = spread.mul(float((rand(i, 1) - 0.5) * 2));
      const vx = lateral.mul(float((rand(i, 2) - 0.5) * 2));
      const peak = arc.mul(float(0.55 + rand(i, 3) * 0.9));
      const posX = launchX.add(vx.mul(cyc));
      const posY = float(baseY).add(peak.mul(4).mul(cyc).mul(cyc.oneMinus()));

      // Tumble end-over-end; the wrap snap at cyc≈0/1 happens while it's off-frame.
      const ang = float(rand(i, 7) * TAU).add(cyc.mul(TAU).mul(tumble.mul(1.5 + rand(i, 8) * 2)));
      const c = cos(ang);
      const sn = sin(ang);

      // Fade in just after launch / out before the re-throw so nothing pops.
      const vis = smoothstep(float(0), float(0.04), cyc).mul(smoothstep(float(1), float(0.92), cyc));
      const live = select(float(i).lessThan(countU), float(1), float(0));
      const gate = vis.mul(live);

      const [r, g, b] = parseHex(NEON[Math.floor(rand(i, 10) * NEON.length) % NEON.length]!);
      const color = vec3(r, g, b);

      // Glowing capsule: solid white-hot core + soft colored halo.
      const len = size.mul(float(0.7 + rand(i, 9) * 0.7));
      const rad = len.mul(thickness).max(1e-4);
      const lx = px.sub(posX);
      const ly = py.sub(posY);
      const qx = lx.mul(c).add(ly.mul(sn));
      const qy = ly.mul(c).sub(lx.mul(sn));
      const dseg = length(vec2(qx.abs().sub(len).max(0), qy));
      const core = smoothstep(rad, rad.mul(0.4), dseg);
      const glowRad = rad.mul(glow.add(1));
      const halo = glowRad.div(dseg.add(glowRad));
      const lum = core.add(halo.mul(halo).mul(0.5));
      const body = mix(color, vec3(1), core.mul(0.7)).mul(lum).mul(gate);
      rgb = rgb.add(body);
      alpha = max(alpha, lum.mul(gate).clamp(0, 1));

      // Light-streak: faint glow ghosts trailing back along the arc.
      for (let k = 1; k <= trailSamples; k++) {
        const tcyc = cyc.sub(float(k * trailDt));
        const ty = float(baseY).add(peak.mul(4).mul(tcyc).mul(tcyc.oneMinus()));
        const tx = launchX.add(vx.mul(tcyc));
        const dd = length(vec2(px.sub(tx), py.sub(ty)));
        const tr = rad.mul(1.6);
        const td = tr.div(dd.add(tr));
        const tg = td.mul(td).mul(float((1 - k / (trailSamples + 1)) * 0.45)).mul(trail).mul(gate);
        rgb = rgb.add(color.mul(tg));
        alpha = max(alpha, tg);
      }
    }

    const flash = burst.mul(0.7).add(1).mul(brightness);
    return texNode(vec4(rgb.mul(flash), alpha.clamp(0, 1)));
  },
);
