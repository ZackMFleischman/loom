import {
  asSignal,
  BuildCtx,
  defineModule,
  integrateSignal,
  Signal,
  texNode,
  type SignalLike,
  type TexNode,
} from "@loom/runtime";
import {
  acos,
  atan,
  Break,
  clamp,
  cos,
  cross,
  exp,
  float,
  Fn,
  If,
  length,
  log2,
  Loop,
  max,
  min,
  mix,
  normalize,
  pow,
  reflect,
  sin,
  smoothstep,
  uv,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import type { Node } from "three/webgpu";
import { surfaceAspect } from "../_shared";

// Fixed unroll bounds (WebGL2 fallback can't take dynamic loop counts). Uniform
// early-breaks keep the live cost down without recompiling. Raymarching a
// distance-estimated fractal is the heaviest source in the library — these
// bounds are the safety ceiling, the `detail`/quality opts ride underneath.
const MAX_STEPS = 64;
const FRACTAL_ITER = 6;
const LN2 = 0.6931471805599453;

export interface MandelbulbOpts {
  /** Bulb exponent — the headline knob. 8 is the classic Mandelbulb; 2..12 morphs the whole form. */
  power?: SignalLike;
  /** Power-breathing rate (units/sec) — the surface slowly inflates and folds. 0 = frozen geometry. */
  morph?: SignalLike;
  /** Orbit speed of the camera around the bulb (revolutions/sec). */
  spin?: SignalLike;
  /** Internal tumble rate (rev/sec) — rolls the fractal so new structure keeps surfacing under the dive. */
  tumble?: SignalLike;
  /** Dive speed (units/sec) — the camera ping-pongs in toward the surface and back out: the infinite zoom. */
  zoom?: SignalLike;
  /** Far camera distance (top of the dive). */
  camRadius?: SignalLike;
  /** Camera height above the equator. */
  camHeight?: SignalLike;
  /** Surface sharpness — smaller resolves finer filigree (and costs more). 0.0006..0.004. */
  detail?: SignalLike;
  /** Soft halo strength from rays grazing the surface — the glow that fills the crevices. */
  glow?: SignalLike;
  /** Key-light intensity on the lit faces. */
  light?: SignalLike;
  /** How fast distance fades surface into the background haze (depth-of-field feel). */
  fog?: SignalLike;
}

/**
 * An infinite 3D Mandelbulb: a distance-estimated fractal raymarched per pixel,
 * lit with diffuse + glossy specular + fresnel rim + ambient occlusion, its
 * surface tinted through the global palette by an orbit trap, and dived into
 * forever (ping-pong dolly + continuous tumble + slow power-breathing so the
 * dive never bottoms out). Colour roles: stop 0 = background haze, 1 = deep
 * crevice, 2/3 = body, 4 = highlight/rim. Everything animates on the frame
 * clock (fixture-deterministic — no wall-clock `time`).
 */
export const mandelbulb = defineModule(
  {
    name: "mandelbulb",
    kind: "source",
    description:
      "Raymarched 3D Mandelbulb fractal: orbit-trap palette skin, glossy lighting, endless tumbling dive.",
    tags: ["fractal", "3d", "raymarch", "mandelbulb", "infinite", "showcase"],
    example: 'mandelbulb(ctx, { power: 8, morph: 0.15, spin: 0.05, zoom: 0.08 })',
  },
  (ctx: BuildCtx, opts: MandelbulbOpts = {}): TexNode => {
    const power = ctx.uniformOf(opts.power ?? 8);
    // Frame-clock phases: morph breathes the power, tumble rolls the bulb, spin
    // orbits the camera. integrateSignal keeps long phases float-precise.
    const breathe = ctx.uniformOf(integrateSignal(asSignal(opts.morph ?? 0.15), { wrap: 1 }));
    const tumble = ctx.uniformOf(integrateSignal(asSignal(opts.tumble ?? 0.04), { wrap: 1 }));
    const spin = ctx.uniformOf(integrateSignal(asSignal(opts.spin ?? 0.05), { wrap: 1 }));

    // Ping-pong dive in 0..1 (0 = far, 1 = nearest), integrated on the CPU like
    // mandelbrot's `dive` so it stays fixture-safe and never overshoots.
    const zoomS = asSignal(opts.zoom ?? 0.08);
    let diveAcc = 0;
    const dive = ctx.uniformOf(
      new Signal((f) => {
        diveAcc += zoomS.get(f) * f.dt;
        const m = ((diveAcc % 2) + 2) % 2; // 0..2 sawtooth
        return m < 1 ? m : 2 - m; // fold to a 0..1 triangle
      }),
    );

    const camRadius = ctx.uniformOf(opts.camRadius ?? 2.7);
    const camHeight = ctx.uniformOf(opts.camHeight ?? 0.35);
    const detail = ctx.uniformOf(opts.detail ?? 0.0016);
    const glowAmt = ctx.uniformOf(opts.glow ?? 1);
    const lightAmt = ctx.uniformOf(opts.light ?? 1);
    const fogAmt = ctx.uniformOf(opts.fog ?? 1);

    // Palette stops captured as uniforms OUT here — referencing them inside the
    // shade Fn is fine, but ctx.palette.ramp() (a DataTexture sample) does NOT
    // bind inside an Fn closure, so the surface ramp is built by hand from these.
    const c0 = ctx.palette.color(0);
    const c1 = ctx.palette.color(1);
    const c2 = ctx.palette.color(2);
    const c3 = ctx.palette.color(3);
    const c4 = ctx.palette.color(4);
    // Per-pixel piecewise-linear 5-stop ramp (sequential mixes self-mask by clamp).
    const ramp5 = (tn: Node<"float">) => {
      const s = tn.clamp(0, 1).mul(4);
      let c: Node<"vec3"> = c0;
      c = mix(c, c1, s.clamp(0, 1));
      c = mix(c, c2, s.sub(1).clamp(0, 1));
      c = mix(c, c3, s.sub(2).clamp(0, 1));
      c = mix(c, c4, s.sub(3).clamp(0, 1));
      return c;
    };

    // Distance estimator for the Mandelbulb: iterate z = z^power + c in spherical
    // coordinates, tracking the running derivative dr for the analytic DE and an
    // orbit trap (closest approach to the origin) that drives the surface colour.
    const de = Fn(([p]: [Node<"vec3">]) => {
      const z = p.toVar();
      const dr = float(1).toVar();
      const r = float(0).toVar();
      const trap = float(1e10).toVar();
      Loop(FRACTAL_ITER, () => {
        r.assign(length(z));
        If(r.greaterThan(2.2), () => {
          Break();
        });
        trap.assign(min(trap, r));
        // Spherical decomposition (guard r away from 0 for the divisions/log).
        const rs = r.max(1e-6);
        const theta = acos(clamp(z.z.div(rs), float(-1), float(1))).mul(power);
        const phi = atan(z.y, z.x).mul(power);
        const rp = pow(rs, power.sub(1));
        dr.assign(rp.mul(power).mul(dr).add(1));
        const zr = rp.mul(rs); // pow(r, power)
        const st = sin(theta);
        z.assign(vec3(st.mul(cos(phi)), st.mul(sin(phi)), cos(theta)).mul(zr).add(p));
      });
      // Analytic DE: 0.5 * log(r) * r / dr  (log via log2 * ln2).
      const dist = float(0.5).mul(log2(r.max(1e-6)).mul(LN2)).mul(r).div(dr.max(1e-6));
      return vec2(dist, trap);
    });

    const shade = Fn(() => {
      // Build the orbiting camera basis, looking at the origin.
      const aspect = surfaceAspect();
      const ndc = uv().sub(0.5).mul(vec2(aspect, 1)).toVar();

      // Dolly from the far radius in toward the surface (~1.18) and back.
      const radius = mix(camRadius, float(1.18), dive);
      const ca = spin.mul(Math.PI * 2);
      const ro = vec3(sin(ca).mul(radius), camHeight, cos(ca).mul(radius)).toVar();
      const fwd = normalize(ro.negate());
      const right = normalize(cross(fwd, vec3(0, 1, 0)));
      const up = cross(right, fwd);
      // ~50° vertical FOV.
      const rd = normalize(fwd.add(right.mul(ndc.x).add(up.mul(ndc.y)).mul(0.9))).toVar();

      // Continuous tumble: rotate the ray space about X then Z so the bulb rolls
      // under the camera and fresh filigree keeps emerging through the dive.
      const ta = tumble.mul(Math.PI * 2);
      const cta = cos(ta);
      const sta = sin(ta);
      const rollX = (v: Node<"vec3">) =>
        vec3(v.x, v.y.mul(cta).sub(v.z.mul(sta)), v.y.mul(sta).add(v.z.mul(cta)));
      const za = breathe.mul(Math.PI * 2 * 0.5);
      const cza = cos(za);
      const sza = sin(za);
      const rollZ = (v: Node<"vec3">) =>
        vec3(v.x.mul(cza).sub(v.y.mul(sza)), v.x.mul(sza).add(v.y.mul(cza)), v.z);
      ro.assign(rollZ(rollX(ro)));
      rd.assign(rollZ(rollX(rd)));

      // March.
      const t = float(0).toVar();
      const hit = float(0).toVar();
      const trap = float(0).toVar();
      const glow = float(0).toVar();
      const eps = detail.max(0.0004);
      Loop(MAX_STEPS, () => {
        const pos = ro.add(rd.mul(t));
        const res = de(pos);
        const d = res.x.toVar();
        // Grazing rays bank a soft halo (thicker the closer & farther they reach).
        glow.addAssign(exp(d.mul(-22)).mul(0.6));
        If(d.lessThan(eps.mul(t.mul(0.5).add(1))), () => {
          hit.assign(1);
          trap.assign(res.y);
          Break();
        });
        t.addAssign(d.mul(0.9).max(eps));
        If(t.greaterThan(7.0), () => {
          Break();
        });
      });

      // Surface normal by tetrahedral DE sampling.
      const pos = ro.add(rd.mul(t));
      const h = eps.mul(2);
      const k0 = vec3(1, -1, -1);
      const k1 = vec3(-1, -1, 1);
      const k2 = vec3(-1, 1, -1);
      const k3 = vec3(1, 1, 1);
      const n = normalize(
        k0
          .mul(de(pos.add(k0.mul(h))).x)
          .add(k1.mul(de(pos.add(k1.mul(h))).x))
          .add(k2.mul(de(pos.add(k2.mul(h))).x))
          .add(k3.mul(de(pos.add(k3.mul(h))).x)),
      );

      // Lighting. Warm key from the upper front, cool sky fill from above.
      const lightDir = normalize(vec3(0.6, 0.8, 0.45));
      const diff = max(n.dot(lightDir), float(0));
      const sky = n.y.mul(0.5).add(0.5); // hemisphere ambient
      const spec = pow(max(reflect(rd, n).dot(lightDir), float(0)), float(36)).mul(0.6);
      const fres = pow(float(1).sub(max(n.dot(rd.negate()), float(0))), float(3.5));
      // Cheap AO from how quickly the march converged + the glow bank — crank it
      // so crevices read dark and the form keeps its copper-to-shadow depth.
      const ao = clamp(float(1).sub(glow.mul(0.02)), float(0.1), float(1)).pow(1.3);

      // Albedo (NOT lighting): the orbit trap picks a copper→gold tone, held off
      // both extremes (no bg-black, no pure cream) so the body stays metal.
      const albedoT = clamp(trap.sub(0.12).mul(1.2), float(0), float(1));
      const albedo = ramp5(albedoT.mul(0.5).add(0.28)); // stops ~1.1 .. 3.1

      // Lambert: cool fill + warm key over the albedo, AO darkening the creases;
      // glossy cream spec and a self-coloured fresnel rim ride on top.
      const fill = mix(c0, c1, sky).mul(0.4);
      const key = vec3(1.0, 0.82, 0.55).mul(diff.mul(lightAmt));
      let lit = albedo.mul(fill.add(key)).mul(ao);
      lit = lit.add(c4.mul(spec.mul(lightAmt)));
      lit = lit.add(albedo.mul(fres.mul(0.4)));

      // Background: a soft vertical haze through the cool stops, with a radial
      // vignette of light behind the bulb (the bokeh-blue negative space).
      const bgGrad = smoothstep(float(-0.6), float(0.9), rd.y);
      const bg = mix(c0.mul(0.7), c1.mul(0.9), bgGrad).add(
        c1.mul(length(ndc).oneMinus().max(0).mul(0.25)),
      );

      // Distance fog blends the hit surface into the haze (depth-of-field feel).
      const fogF = clamp(t.mul(fogAmt).mul(0.16), float(0), float(1));
      const surface = mix(lit, bg, fogF);

      // The grazing-ray halo tints the whole frame, warm where it's thick.
      const halo = mix(c1, c3, clamp(glow.mul(0.05), float(0), float(1)))
        .mul(glow)
        .mul(0.035)
        .mul(glowAmt);

      const col = mix(bg, surface, hit).add(halo);
      return vec4(col, 1);
    });

    return texNode(shade());
  },
);
