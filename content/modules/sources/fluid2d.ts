import { BuildCtx, defineModule, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import { cos, dot, exp, float, length, sin, uv, vec2, vec3, vec4 } from "three/tsl";
import type { Node } from "three/webgpu";
import { simBufferMulti } from "../_shared";

/** Sim grid — fixed, 16:9, modest so the Jacobi loop stays in budget. */
const W = 256;
const H = 144;
const TX = float(1 / W);
const TY = float(1 / H);
/** Force/dye injection spot tightness (smaller = tighter splat). */
const SPOT_R2 = 0.0016;

export interface Fluid2dOpts {
  /** Force impulse strength on injection — wire ctx.input("kick") to billow on the beat (0..1). */
  inject?: SignalLike;
  /** Dye amount sprayed with each impulse (0..1). */
  dye?: SignalLike;
  /** Velocity dissipation per step (<1 calms the flow) — bass can ease this for longer smoke (0.95..1). */
  dissipation?: SignalLike;
  /** Dye fade per step (<1 thins the smoke) (0.97..1). */
  fade?: SignalLike;
  /** Jacobi pressure iterations — incompressibility quality vs. cost (16..48). */
  pressureIters?: SignalLike;
  /** Integration steps per frame — flow speed (1..3). */
  iterations?: SignalLike;
  /** Rising past 0.5 clears velocity + dye (a trigger). */
  reseed?: SignalLike;
}

/**
 * Stam stable-fluids 2D smoke: a genuine incompressible-flow simulation —
 * semi-Lagrangian advect → divergence → Jacobi pressure solve → project to
 * divergence-free → advect dye through the velocity. Four coupled HalfFloat
 * fields (velocity, divergence, pressure, dye) hosted on the shared
 * `simBufferMulti`. Inject a force impulse + a puff of dye at two orbiting
 * points on the kick and it billows; bass can ease dissipation for longer,
 * lazier smoke. The canonical VJ ink/smoke.
 *
 * Output channels: .x = dye luminance (ramp this through the palette), .y =
 * speed |velocity| (foam / motion highlight), .z = dye luminance. Reads
 * non-black on its own (a starter puff is seeded).
 */
export const fluid2d = defineModule(
  {
    name: "fluid2d",
    kind: "source",
    description: "Stam stable-fluids 2D smoke/ink: real incompressible flow, dye + force injected on the beat.",
    tags: ["fluid", "stable-fluids", "smoke", "ink", "simulation", "navier-stokes", "audio-reactive", "gpu"],
    example: 'fluid2d(ctx, { inject: ctx.input("kick"), dye: 0.8, pressureIters: 30 })',
  },
  (ctx: BuildCtx, opts: Fluid2dOpts = {}): TexNode => {
    const inject = ctx.uniformOf(opts.inject ?? 0);
    const dyeAmt = ctx.uniformOf(opts.dye ?? 0.8);
    const dissipation = ctx.uniformOf(opts.dissipation ?? 0.992);
    const fade = ctx.uniformOf(opts.fade ?? 0.982);

    // Two orbiting injection points (frame-clocked, deterministic), sweeping fast
    // enough to drag the dye into trailing wisps rather than a static blob.
    const spots = (phase: Node<"float">) => {
      const p1 = vec2(cos(phase.mul(0.041)).mul(0.26).add(0.5), sin(phase.mul(0.053)).mul(0.22).add(0.5));
      const p2 = vec2(cos(phase.mul(-0.061).add(2.1)).mul(0.3).add(0.5), sin(phase.mul(0.037).add(1.3)).mul(0.26).add(0.5));
      return { p1, p2 };
    };
    const splat = (d: Node<"vec2">) => exp(dot(d, d).div(SPOT_R2).negate());
    // A vortex impulse: tangential (perpendicular) velocity around a spot center →
    // the injected dye twists into curling filaments instead of a round puff.
    const vortex = (d: Node<"vec2">, g: Node<"float">, spin: number) =>
      vec2(d.y.negate(), d.x).mul(spin).add(d.mul(0.6)).mul(g);

    const sim = simBufferMulti(ctx, {
      iterations: opts.iterations ?? 1,
      reseed: opts.reseed ?? 0,
      fields: [
        // velocity (rg), divergence (r), pressure (r), dye (rgb). All 16:9, toroidal.
        { name: "vel", width: W, height: H, wrap: "repeat", seed: () => vec4(0, 0, 0, 1) },
        { name: "div", width: W, height: H, wrap: "repeat", seed: () => vec4(0, 0, 0, 1) },
        { name: "pres", width: W, height: H, wrap: "repeat", seed: () => vec4(0, 0, 0, 1) },
        // A faint starter puff so the field reads non-black from frame 0.
        {
          name: "dye",
          width: W,
          height: H,
          wrap: "repeat",
          seed: () => {
            const d = uv().sub(vec2(0.5, 0.45));
            const g = exp(dot(d, d).div(0.008).negate()).mul(0.35);
            return vec4(vec3(g.mul(0.4), g.mul(0.7), g), 1);
          },
        },
      ],
      passes: [
        // 1. Advect velocity through itself (semi-Lagrangian backtrace) + dissipate + inject force.
        {
          target: "vel",
          step: ({ sample, sampleUv, phase }) => {
            const v = sample("vel", 0, 0).xy;
            const back = uv().sub(v.mul(vec2(TX, TY)));
            const advected = sampleUv("vel", back).xy.mul(dissipation);
            const { p1, p2 } = spots(phase);
            // Counter-rotating vortices around each orbiting spot → swirling smoke.
            const d1 = uv().sub(p1);
            const d2 = uv().sub(p2);
            const force = vortex(d1, splat(d1), 3.5).add(vortex(d2, splat(d2), -3.5)).mul(inject).mul(0.9);
            return vec4(advected.add(force).clamp(-8, 8), 0, 1);
          },
        },
        // 2. Divergence of the (advected) velocity field.
        {
          target: "div",
          step: ({ sample }) => {
            const r = sample("vel", 1, 0).x;
            const l = sample("vel", -1, 0).x;
            const u = sample("vel", 0, 1).y;
            const d = sample("vel", 0, -1).y;
            return vec4(r.sub(l).add(u.sub(d)).mul(0.5), 0, 0, 1);
          },
        },
        // 3. Jacobi pressure solve: ∇²p = div. Sub-iterated `pressureIters` times.
        {
          target: "pres",
          repeat: opts.pressureIters ?? 30,
          step: ({ sample }) => {
            const pL = sample("pres", -1, 0).x;
            const pR = sample("pres", 1, 0).x;
            const pU = sample("pres", 0, 1).x;
            const pD = sample("pres", 0, -1).x;
            const div = sample("div", 0, 0).x;
            return vec4(pL.add(pR).add(pU).add(pD).sub(div).mul(0.25), 0, 0, 1);
          },
        },
        // 4. Project: subtract the pressure gradient → divergence-free velocity.
        {
          target: "vel",
          step: ({ sample }) => {
            const v = sample("vel", 0, 0).xy;
            const gx = sample("pres", 1, 0).x.sub(sample("pres", -1, 0).x).mul(0.5);
            const gy = sample("pres", 0, 1).x.sub(sample("pres", 0, -1).x).mul(0.5);
            return vec4(v.sub(vec2(gx, gy)), 0, 1);
          },
        },
        // 5. Advect dye through the projected velocity + fade + inject coloured puffs.
        {
          target: "dye",
          step: ({ sample, sampleUv, phase }) => {
            const v = sample("vel", 0, 0).xy;
            const back = uv().sub(v.mul(vec2(TX, TY)));
            const advected = sampleUv("dye", back).xyz.mul(fade);
            const { p1, p2 } = spots(phase);
            const s1 = splat(uv().sub(p1)).mul(inject).mul(dyeAmt).mul(0.12);
            const s2 = splat(uv().sub(p2)).mul(inject).mul(dyeAmt).mul(0.12);
            const ink = vec3(float(0.6), float(0.85), float(1)).mul(s1).add(vec3(float(1), float(0.6), float(0.9)).mul(s2));
            return vec4(advected.add(ink).clamp(0, 1.4), 1);
          },
        },
      ],
    });

    // Output: dye luminance + velocity speed for a motion highlight.
    const dye = sim.sampleOut("dye", 0, 0).xyz;
    const lum = dot(dye, vec3(0.299, 0.587, 0.114)).clamp(0, 1);
    const vel = sim.sampleOut("vel", 0, 0).xy;
    const speed = length(vel).mul(2.5).clamp(0, 1);
    return texNode(vec4(lum, speed, lum, 1), [sim.pass]);
  },
);
