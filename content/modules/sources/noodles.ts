import { BuildCtx, defineModule, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import { abs, float, max, mix, sin, smoothstep, uv, vec3, vec4 } from "three/tsl";
import type { Node } from "three/webgpu";

const TAU = Math.PI * 2;

export interface NoodlesOpts {
  /** Strand count (compile-time constant — the loop is unrolled). */
  count?: number;
  /** How far strands wander from their lane, as a fraction of screen height. */
  wiggle?: SignalLike;
  /** Wave count along a strand (higher = curlier). */
  waves?: SignalLike;
  /** Strand half-thickness as a fraction of screen height. */
  width?: SignalLike;
  /** Undulation/slide speed (strands flow sideways at staggered rates). */
  flow?: SignalLike;
  /** Wiggle multiplier drive — feed a kick envelope to make the noodles slurp. */
  energy?: SignalLike;
}

/**
 * A field of procedural rice-noodle strands: each strand is a soft capsule
 * around a two-harmonic sine path drifting through its own lane, creamy
 * white with a center highlight. Emits premultiplied alpha so it drops onto
 * any broth via `over`. Strand paths are scattered deterministically, so the
 * same opts always cook the same bowl.
 */
export const noodles = defineModule(
  {
    name: "noodles",
    kind: "source",
    description: "Wavy procedural noodle strands (premultiplied alpha) that undulate and slurp on an energy signal.",
    tags: ["noodles", "strands", "organic", "pho", "audio-reactive", "overlay"],
    example: 'noodles(ctx, { count: 9, wiggle: 0.05, energy: kickEnv })',
  },
  (ctx: BuildCtx, opts: NoodlesOpts = {}): TexNode => {
    const count = opts.count ?? 9;
    const wiggle = ctx.uniformOf(opts.wiggle ?? 0.05);
    const waves = ctx.uniformOf(opts.waves ?? 2.2);
    const width = ctx.uniformOf(opts.width ?? 0.012);
    const flow = ctx.uniformOf(opts.flow ?? 0.5);
    const energy = ctx.uniformOf(opts.energy ?? 0);

    const x = uv().x;
    const y = uv().y;
    // Frame-clock time, NOT TSL `time` (wall clock) — keeps fixture replays deterministic.
    const t = ctx.uniformOf(ctx.time.now).mul(flow);
    // Energy multiplies the wander — a kick ripples through every strand.
    const amp = wiggle.mul(energy.mul(0.9).add(1));

    let body: Node<"float"> = float(0); // strand coverage (max over strands)
    let core: Node<"float"> = float(0); // center-line highlight
    for (let i = 0; i < count; i++) {
      // Deterministic per-strand scatter: lane jitter, curl scale, drift rate.
      const lane = (i + 0.5) / count + (((i * 0.618) % 1) - 0.5) * (0.6 / count);
      const curl = 0.75 + 0.5 * ((i * 0.382) % 1);
      const drift = (0.4 + 0.6 * ((i * 0.236) % 1)) * (i % 2 ? 1 : -1);
      const o1 = i * 2.39996;
      const o2 = i * 4.71239 + 1.3;

      const phase = x.mul(float(TAU * curl).mul(waves)).add(t.mul(drift)).add(o1);
      const wave = sin(phase)
        .add(sin(phase.mul(2.6).add(o2)).mul(0.35))
        .mul(amp.mul(curl));
      const d = abs(y.sub(float(lane).add(wave)));
      body = max(body, smoothstep(width, width.mul(0.45), d));
      core = max(core, smoothstep(width.mul(0.4), float(0), d));
    }

    // Rice-noodle cream, brighter along the strand center; premultiplied.
    const col = mix(vec3(0.93, 0.88, 0.78), vec3(1.0, 0.99, 0.94), core);
    return texNode(vec4(col.mul(body), body));
  },
);
