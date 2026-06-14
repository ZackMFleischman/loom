import { asSignal, BuildCtx, defineModule, type GeoNode, type SignalLike } from "@loom/runtime";
import { Vector3 } from "three/webgpu";
import { lineRibbon } from "./lineRibbon";

export type LSystemPreset = "plant" | "koch" | "dragon" | "sierpinski" | "bush";

interface Rule {
  axiom: string;
  rules: Record<string, string>;
  /** Default turn angle in degrees. */
  angle: number;
  /** Default generations (kept modest — string length is exponential). */
  iterations: number;
}

/** Classic rule library — selectable like the palette presets. */
const PRESETS: Record<LSystemPreset, Rule> = {
  plant: { axiom: "X", rules: { X: "F+[[X]-X]-F[-FX]+X", F: "FF" }, angle: 25, iterations: 5 },
  koch: { axiom: "F", rules: { F: "F+F-F-F+F" }, angle: 90, iterations: 4 },
  dragon: { axiom: "FX", rules: { X: "X+YF+", Y: "-FX-Y" }, angle: 90, iterations: 11 },
  sierpinski: { axiom: "F-G-G", rules: { F: "F-G+F+G-F", G: "GG" }, angle: 120, iterations: 5 },
  bush: { axiom: "Y", rules: { Y: "YFX[+Y][-Y]", X: "X[-FFF][+FFF]FX", F: "FF" }, angle: 25, iterations: 4 },
};

export interface LSystemOpts {
  /** Which classic grammar to grow. */
  preset?: LSystemPreset;
  /** Rewrite generations (clamped; string length grows exponentially). */
  iterations?: number;
  /** Turn angle in degrees (Signal-able — sweep it to morph the form live). */
  angle?: SignalLike;
  /**
   * Fraction of the path drawn this frame, 0..1 (Signal-able). Ramp it from 0→1
   * to UNFURL the plant; pin it at 1 for the full form. The literal "growing
   * fraction" animation, frame-clocked.
   */
  reveal?: SignalLike;
  /** Stroke half-thickness (forwarded to lineRibbon). */
  width?: SignalLike;
  /** Stroke colour "#rrggbb". */
  color?: string;
  /** Emissive intensity (forwarded to lineRibbon — flare on the kick). */
  glow?: SignalLike;
}

/** Turtle state for branch push/pop. */
interface Turtle {
  pos: Vector3;
  dir: Vector3;
}

/**
 * An L-system botanical as a GeoNode: an axiom is rewritten `k` generations by
 * its production rules, then a turtle interprets the string (`F` draw, `+`/`-`
 * yaw, `&`/`^` pitch, `[`/`]` push/pop branch) into 3D polyline segments —
 * classic plants, Koch curves, dragon curves, Sierpinski gaskets, bushes. The
 * string is built once (deterministic, no randomness); the `reveal` signal draws
 * a growing FRACTION of the path each frame so the form UNFURLS, and `angle`
 * sweeps live to morph it. Renders through the shared `lineRibbon`. iterations /
 * angle / preset (the rules) are the exposed params.
 */
export const lsystem = defineModule(
  {
    name: "lsystem",
    kind: "geo",
    description: "L-system string rewriting turtle-drawn into ribbon strokes (plant/koch/dragon/sierpinski/bush) — render via render3d.",
    tags: ["3d", "lsystem", "l-system", "turtle", "fractal", "plant", "generative", "geo"],
    example: 'render3d(ctx, { world: [lsystem(ctx, { preset: "plant", reveal: unfurl, angle: 25 })], cam: orbitCam(ctx, {}) })',
  },
  (ctx: BuildCtx, opts: LSystemOpts = {}): GeoNode => {
    const preset = PRESETS[opts.preset ?? "plant"];
    const iters = Math.max(0, Math.min(preset.iterations, Math.round(opts.iterations ?? preset.iterations)));
    const angle = asSignal(opts.angle ?? preset.angle);
    const reveal = asSignal(opts.reveal ?? 1);

    // Rewrite the axiom `iters` generations, with a length cap so a bad
    // preset/iters combo can't explode the string (and the frame budget).
    const MAX_LEN = 200_000;
    let str = preset.axiom;
    for (let g = 0; g < iters; g++) {
      let next = "";
      for (const ch of str) next += preset.rules[ch] ?? ch;
      str = next;
      if (str.length > MAX_LEN) break;
    }

    // The turtle interpretation depends on the angle, so it's rebuilt per frame
    // when the angle changes — but only then (cache on the rounded angle). We
    // emit a flat list of all segments [a,b] so `reveal` can clip by count.
    type Seg = [Vector3, Vector3];
    let lastAngle = NaN;
    let segs: Seg[] = [];
    const buildSegs = (deg: number) => {
      const rad = (deg * Math.PI) / 180;
      const cy = Math.cos(rad), sy = Math.sin(rad); // yaw (around Z)
      const cp = Math.cos(rad), sp = Math.sin(rad); // pitch (around X)
      const out: Seg[] = [];
      const stack: Turtle[] = [];
      let pos = new Vector3(0, -0.9, 0);
      let dir = new Vector3(0, 1, 0); // grow upward
      const step = 0.05;
      const rotZ = (v: Vector3, c: number, s: number) => v.set(v.x * c - v.y * s, v.x * s + v.y * c, v.z);
      const rotX = (v: Vector3, c: number, s: number) => v.set(v.x, v.y * c - v.z * s, v.y * s + v.z * c);
      for (const ch of str) {
        switch (ch) {
          case "F":
          case "G": {
            const a = pos.clone();
            pos = pos.clone().addScaledVector(dir, step);
            out.push([a, pos.clone()]);
            break;
          }
          case "+": rotZ(dir, cy, sy); break;
          case "-": rotZ(dir, cy, -sy); break;
          case "&": rotX(dir, cp, sp); break;
          case "^": rotX(dir, cp, -sp); break;
          case "[": stack.push({ pos: pos.clone(), dir: dir.clone() }); break;
          case "]": {
            const t = stack.pop();
            if (t) { pos = t.pos; dir = t.dir; }
            break;
          }
        }
      }
      // Centre + normalise to a unit-ish box so every preset frames the same.
      const min = new Vector3(Infinity, Infinity, Infinity);
      const max = new Vector3(-Infinity, -Infinity, -Infinity);
      for (const [p, q] of out) { min.min(p).min(q); max.max(p).max(q); }
      const center = min.clone().add(max).multiplyScalar(0.5);
      const span = Math.max(max.x - min.x, max.y - min.y, max.z - min.z, 1e-4);
      const s = 1.6 / span;
      for (const seg of out) for (const v of seg) v.sub(center).multiplyScalar(s);
      return out;
    };

    let pathCache: Vector3[][] = [];
    ctx.updaters.push((f) => {
      const deg = angle.get(f);
      const rounded = Math.round(deg * 4) / 4; // re-tessellate only on a real change
      if (rounded !== lastAngle) { lastAngle = rounded; segs = buildSegs(rounded); }
      const rev = Math.max(0, Math.min(1, reveal.get(f)));
      const count = Math.round(segs.length * rev);
      // Emit each (already-disjoint) segment as its own 2-point path so branch
      // jumps never draw a connecting stroke.
      const out: Vector3[][] = [];
      for (let i = 0; i < count; i++) out.push([segs[i]![0], segs[i]![1]]);
      pathCache = out;
    });

    return lineRibbon(ctx, {
      paths: () => pathCache,
      width: opts.width ?? 0.006,
      color: opts.color ?? "#86f7a0",
      ...(opts.glow !== undefined ? { glow: opts.glow } : {}),
      maxSegments: Math.min(60_000, Math.max(64, str.length)),
    });
  },
);
