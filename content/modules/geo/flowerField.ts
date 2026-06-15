import { asSignal, BuildCtx, defineModule, type GeoNode, type SignalLike } from "@loom/runtime";
import { Group, Vector3 } from "three/webgpu";
import { lineRibbon, type RibbonPath } from "./lineRibbon";

export interface FlowerFieldOpts {
  /** Grid columns across the ground (build-time — rebuilds). */
  cols?: number;
  /** Grid rows receding into depth (build-time — rebuilds). */
  rows?: number;
  /** World spacing between neighbouring plants (build-time). */
  spacing?: number;
  /** Base plant height in world units (per-cell scale jitter rides on top). */
  plantScale?: number;
  /** Lifecycles per second — how fast each flower grows then fades (integrated, frame-clock). */
  rate?: SignalLike;
  /** Wind sway amplitude (world units at the plant top). */
  wind?: SignalLike;
  /** Stroke half-thickness (forwarded to lineRibbon). */
  width?: SignalLike;
  /** Emissive intensity (forwarded to every ribbon — flare on the kick). */
  glow?: SignalLike;
  /** Variation seed — re-rolls the templates and per-cell assignment. */
  seed?: number;
  /** Max segments drawn per frame across the whole field — nearest plants win. */
  maxSegments?: number;
  /** Distinct plant templates to grow (more = more variety, slightly slower build). */
  templates?: number;
  /** Stem stroke colour "#rrggbb". */
  stemColor?: string;
  /** Leaf stroke colour "#rrggbb". */
  leafColor?: string;
  /** Flower-centre colour "#rrggbb". */
  centerColor?: string;
  /** Petal colours — each flower is assigned one, so the field blooms in mixed hues. */
  petalColors?: string[];
}

/** Upright branching grammars — only yaw (+/-) so each plant stays planar and faces the camera. */
const GRAMMARS: { axiom: string; rules: Record<string, string>; angle: number }[] = [
  { axiom: "X", rules: { X: "F[+X]F[-X]+X", F: "FF" }, angle: 22 },
  { axiom: "X", rules: { X: "F[+X][-X]FX", F: "FF" }, angle: 26 },
  { axiom: "X", rules: { X: "F[-X]F[+X]-X", F: "FF" }, angle: 20 },
  { axiom: "F", rules: { F: "F[+F]F[-F]F" }, angle: 24 },
];

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Flower {
  center: Vector3;        // local, already normalised — connected to the stem tip
  petals: Vector3[][];    // petal outlines as offsets from the centre (scaled by bloom)
  marks: Vector3[][];     // centre dot as offsets from the centre
  attachIdx: number;
}
interface Template {
  stems: [Vector3, Vector3][]; // local, base at y=0, centred in x, height ~1
  leaves: { pts: Vector3[]; attachIdx: number }[];
  flowers: Flower[];
  total: number;          // stem segment count
  bloomSpan: number;
}
interface Cell {
  tpl: number;            // template index
  ox: number; oz: number; // ground position (XZ)
  scale: number;
  phase: number;          // lifecycle offset 0..1
  windSeed: number;
  colorGroup: number;
}

/**
 * A dense field of L-system flowers on a receding ground plane, each constantly
 * growing, blooming, then fading away. A pool of distinct upright grammars is
 * grown once into plant templates (stems + sprouting leaves + rounded petal
 * flower heads bound to the branch tips); the grid then instances those
 * templates across the XZ ground with per-cell variation (position, scale,
 * colour, lifecycle phase) so neighbours differ. Each plant unfurls its stem,
 * blooms its flowers, then shrinks back into the ground, looping forever; a
 * gentle wind shears the tops. Nearest plants are drawn first up to a segment
 * budget, so the grid scales to thousands of flowers and degrades gracefully.
 * Deterministic on the frame clock (fixture-safe). Returns a GeoNode (a Group of
 * lineRibbons) — render via render3d with a low, forward-looking camera.
 */
export const flowerField = defineModule(
  {
    name: "flowerField",
    kind: "geo",
    description:
      "A dense perspective-ground grid of L-system flowers (stems/leaves/rounded petal heads) endlessly growing, blooming and fading; template-instanced + segment-budgeted so it scales to thousands — render via render3d.",
    tags: ["3d", "lsystem", "l-system", "plant", "flower", "garden", "generative", "organic", "geo"],
    example:
      'render3d(ctx, { world: [flowerField(ctx, { cols: 30, rows: 30, rate: 0.12 })], cam: orbitCam(ctx, { target: [0, 0.4, -3.5], radius: 3.5, height: 1.8 }) })',
  },
  (ctx: BuildCtx, opts: FlowerFieldOpts = {}): GeoNode => {
    const cols = Math.max(1, Math.min(300, Math.round(opts.cols ?? 30)));
    const rows = Math.max(1, Math.min(300, Math.round(opts.rows ?? 30)));
    const spacing = opts.spacing ?? 0.34;
    const plantScale = opts.plantScale ?? 0.42;
    const seed = opts.seed ?? 1;
    const budget = Math.max(2000, Math.round(opts.maxSegments ?? 48_000));
    const nTemplates = Math.max(4, Math.min(96, Math.round(opts.templates ?? 36)));
    const petalColors = opts.petalColors && opts.petalColors.length > 0
      ? opts.petalColors
      : ["#ff6fae", "#ffd24a", "#c08bff", "#ff8a5b", "#ffffff", "#ff5a7a"];

    const rateS = asSignal(opts.rate ?? 0.12);
    const windS = asSignal(opts.wind ?? 0.05);
    const STEP = 0.05;
    const MAX_STEM = 150; // per-template segment cap (plants stay small in a dense field)

    // ---- Build the template pool ONCE -------------------------------------
    const templates: Template[] = [];
    for (let ti = 0; ti < nTemplates; ti++) {
      const rand = rng((ti + 1) * 1013904223 + seed * 2246822519);
      const gram = GRAMMARS[Math.floor(rand() * GRAMMARS.length)]!;
      const iters = 2 + (rand() < 0.5 ? 0 : 1);
      const angDeg = gram.angle + (rand() * 2 - 1) * 6;
      const leafEvery = 4 + Math.floor(rand() * 3);
      const petalCount = 5 + Math.floor(rand() * 4);
      const flowerHeads = 1 + Math.floor(rand() * 3);

      let str = gram.axiom;
      for (let g = 0; g < iters; g++) {
        let next = "";
        for (const ch of str) next += gram.rules[ch] ?? ch;
        str = next;
        if (str.length > 20_000) break;
      }

      const rad = (angDeg * Math.PI) / 180;
      const cyaw = Math.cos(rad), syaw = Math.sin(rad);
      const stems: [Vector3, Vector3][] = [];
      const leavesRaw: { pos: Vector3; dir: Vector3; attachIdx: number; side: number }[] = [];
      const tips: { pos: Vector3; dir: Vector3; attachIdx: number }[] = [];
      const stack: { pos: Vector3; dir: Vector3; drewF: boolean }[] = [];
      let pos = new Vector3(0, 0, 0);
      let dir = new Vector3(0, 1, 0);
      let drewF = false, fCount = 0, leafSide = 1;
      const rotZ = (vv: Vector3, cc: number, ss: number) =>
        vv.set(vv.x * cc - vv.y * ss, vv.x * ss + vv.y * cc, 0).normalize();
      for (const ch of str) {
        if (stems.length >= MAX_STEM) break;
        switch (ch) {
          case "F":
          case "G": {
            const a = pos.clone();
            pos = pos.clone().addScaledVector(dir, STEP);
            stems.push([a, pos.clone()]);
            drewF = true; fCount++;
            if (fCount % leafEvery === 0) { leavesRaw.push({ pos: pos.clone(), dir: dir.clone(), attachIdx: stems.length, side: leafSide }); leafSide *= -1; }
            break;
          }
          case "+": rotZ(dir, cyaw, syaw); break;
          case "-": rotZ(dir, cyaw, -syaw); break;
          case "[": stack.push({ pos: pos.clone(), dir: dir.clone(), drewF }); drewF = false; break;
          case "]": {
            if (drewF) tips.push({ pos: pos.clone(), dir: dir.clone(), attachIdx: stems.length });
            const t = stack.pop(); if (t) { pos = t.pos; dir = t.dir; drewF = t.drewF; }
            break;
          }
        }
      }
      if (drewF) tips.push({ pos: pos.clone(), dir: dir.clone(), attachIdx: stems.length });

      // Normalise EVERYTHING (stems, leaves, tips) into the same unit space —
      // base at y=0, centred in x, height ~1. (Normalising tips too is what
      // keeps the flower heads bound to the stem.)
      const min = new Vector3(Infinity, Infinity, Infinity);
      const max = new Vector3(-Infinity, -Infinity, -Infinity);
      for (const [a, b] of stems) { min.min(a).min(b); max.max(a).max(b); }
      if (!isFinite(min.x)) { min.set(0, 0, 0); max.set(0, 1, 0); }
      const cx = (min.x + max.x) * 0.5;
      const spanY = Math.max(max.y - min.y, 1e-3);
      const s = 1 / spanY;
      const norm = (v: Vector3) => v.set((v.x - cx) * s, (v.y - min.y) * s, 0);
      for (const seg of stems) { norm(seg[0]); norm(seg[1]); }
      for (const lf of leavesRaw) norm(lf.pos);
      for (const tp of tips) norm(tp.pos);

      // Leaves: a slim diamond sprouting sideways.
      const leafLen = 0.14;
      const leaves = leavesRaw.map((lf) => {
        const la = (50 * Math.PI / 180) * lf.side;
        const ld = new Vector3(lf.dir.x * Math.cos(la) - lf.dir.y * Math.sin(la), lf.dir.x * Math.sin(la) + lf.dir.y * Math.cos(la), 0).normalize();
        const perp = new Vector3(-ld.y, ld.x, 0);
        const base = lf.pos.clone();
        const mid1 = base.clone().addScaledVector(ld, leafLen * 0.5).addScaledVector(perp, leafLen * 0.3);
        const mid2 = base.clone().addScaledVector(ld, leafLen * 0.5).addScaledVector(perp, -leafLen * 0.3);
        const tip = base.clone().addScaledVector(ld, leafLen);
        return { pts: [base.clone(), mid1, tip, mid2, base.clone()], attachIdx: lf.attachIdx };
      });

      // Flowers at the tallest tips: ROUNDED overlapping petals (teardrops),
      // built from the centre out so the bloom stays bound to the tip.
      tips.sort((p, q) => q.pos.y - p.pos.y);
      const keep = Math.min(tips.length, flowerHeads);
      const petalLen = 0.2;
      const markS = 0.03;
      const flowers: Flower[] = [];
      for (let i = 0; i < keep; i++) {
        const tip = tips[i]!;
        const baseAngle = Math.atan2(tip.dir.y, tip.dir.x);
        const petals: Vector3[][] = [];
        for (let k = 0; k < petalCount; k++) {
          const ang = baseAngle + (k / petalCount) * Math.PI * 2;
          const d = new Vector3(Math.cos(ang), Math.sin(ang), 0);
          const p = new Vector3(-d.y, d.x, 0);
          const L = petalLen;
          // Teardrop outline: centre → out one side → rounded tip → back the other side → centre.
          petals.push([
            new Vector3(0, 0, 0),
            d.clone().multiplyScalar(L * 0.35).addScaledVector(p, L * 0.26),
            d.clone().multiplyScalar(L * 0.78).addScaledVector(p, L * 0.16),
            d.clone().multiplyScalar(L),
            d.clone().multiplyScalar(L * 0.78).addScaledVector(p, -L * 0.16),
            d.clone().multiplyScalar(L * 0.35).addScaledVector(p, -L * 0.26),
            new Vector3(0, 0, 0),
          ]);
        }
        const marks = [
          [new Vector3(-markS, 0, 0), new Vector3(markS, 0, 0)],
          [new Vector3(0, -markS, 0), new Vector3(0, markS, 0)],
        ];
        flowers.push({ center: tip.pos.clone(), petals, marks, attachIdx: tip.attachIdx });
      }

      templates.push({ stems, leaves, flowers, total: stems.length, bloomSpan: Math.max(3, stems.length * 0.18) });
    }

    // ---- Build the cell grid on the ground (XZ), nearest-first -------------
    const cells: Cell[] = [];
    const cellRand = rng(seed * 374761393 + 7);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const jx = (cellRand() - 0.5) * spacing * 0.4;
        const jz = (cellRand() - 0.5) * spacing * 0.4;
        cells.push({
          tpl: Math.floor(cellRand() * templates.length),
          ox: (c - (cols - 1) / 2) * spacing + jx,
          oz: -r * spacing + jz,
          scale: plantScale * (0.78 + cellRand() * 0.5),
          phase: cellRand(),
          windSeed: cellRand() * Math.PI * 2,
          colorGroup: Math.floor(cellRand() * petalColors.length),
        });
      }
    }
    cells.sort((a, b) => b.oz - a.oz); // nearest (z≈0) first → the budget fills the foreground

    // ---- Per-frame: drive lifecycles into the ribbon path sinks -----------
    const pool: Vector3[] = [];
    let poolN = 0;
    const v = (x: number, y: number, z: number): Vector3 => {
      let p = pool[poolN]; if (!p) { p = new Vector3(); pool[poolN] = p; } poolN++;
      return p.set(x, y, z);
    };
    /** A reusable path sink — no per-frame array allocation. */
    const sink = () => {
      const live: RibbonPath[] = [];
      const arrs: Vector3[][] = [];
      let k = 0;
      return {
        live,
        reset() { live.length = 0; k = 0; },
        alloc(n: number): Vector3[] { let a = arrs[k]; if (!a) { a = []; arrs[k] = a; } a.length = n; live.push(a); k++; return a; },
      };
    };
    const stemSink = sink();
    const leafSink = sink();
    const petalSinks = petalColors.map(() => sink());
    const centerSink = sink();

    let life = 0, windT = 0;
    const smooth = (t: number) => t * t * (3 - 2 * t);

    ctx.updaters.push((f) => {
      life += rateS.get(f) * f.dt;
      windT += f.dt;
      const windAmt = windS.get(f);
      stemSink.reset(); leafSink.reset(); centerSink.reset();
      for (const ps of petalSinks) ps.reset();
      poolN = 0;
      let segs = 0;

      for (const cell of cells) {
        if (segs >= budget) break;
        const t = (((life + cell.phase) % 1) + 1) % 1;
        let growth: number, fade: number;
        if (t < 0.42) { growth = smooth(t / 0.42); fade = 1; }
        else if (t < 0.72) { growth = 1; fade = 1; }
        else { growth = 1; fade = 1 - smooth((t - 0.72) / 0.28); }
        if (fade <= 0.01) continue;

        const tpl = templates[cell.tpl]!;
        const sc = cell.scale * fade;
        const ox = cell.ox, oz = cell.oz;
        // Local (XY, base origin) → world: scale, wind-shear the top, drop on the ground at (ox,0,oz).
        const place = (lx: number, ly: number): Vector3 => {
          const sx = lx * sc, sy = ly * sc;
          const shear = Math.sin(windT * 0.9 + cell.windSeed + sy * 3) * windAmt * sy;
          return v(ox + sx + shear, sy, oz);
        };
        const revealCount = Math.round(tpl.total * growth);

        for (let i = 0; i < revealCount && segs < budget; i++) {
          const seg = tpl.stems[i]!;
          const a = stemSink.alloc(2);
          a[0] = place(seg[0].x, seg[0].y); a[1] = place(seg[1].x, seg[1].y);
          segs++;
        }
        for (const lf of tpl.leaves) {
          if (revealCount < lf.attachIdx || segs >= budget) continue;
          const a = leafSink.alloc(lf.pts.length);
          for (let i = 0; i < lf.pts.length; i++) a[i] = place(lf.pts[i]!.x, lf.pts[i]!.y);
          segs += lf.pts.length - 1;
        }
        for (const fl of tpl.flowers) {
          if (revealCount < fl.attachIdx || segs >= budget) continue;
          const bloom = Math.max(0, Math.min(1, (revealCount - fl.attachIdx) / tpl.bloomSpan));
          if (bloom <= 0.01) continue;
          const cxl = fl.center.x, cyl = fl.center.y;
          const ps = petalSinks[cell.colorGroup]!;
          for (const petal of fl.petals) {
            if (segs >= budget) break;
            const a = ps.alloc(petal.length);
            for (let i = 0; i < petal.length; i++) a[i] = place(cxl + petal[i]!.x * bloom, cyl + petal[i]!.y * bloom);
            segs += petal.length - 1;
          }
          for (const m of fl.marks) {
            if (segs >= budget) break;
            const a = centerSink.alloc(2);
            a[0] = place(cxl + m[0]!.x * bloom, cyl + m[0]!.y * bloom);
            a[1] = place(cxl + m[1]!.x * bloom, cyl + m[1]!.y * bloom);
            segs++;
          }
        }
      }
    });

    // ---- Ribbons (one per colour) into a Group GeoNode --------------------
    const width = opts.width ?? 0.005;
    const glow = opts.glow;
    const mk = (paths: () => RibbonPath[], color: string, cap: number) =>
      lineRibbon(ctx, { paths, width, color, maxSegments: cap, ...(glow !== undefined ? { glow } : {}) }).object;

    const group = new Group();
    group.add(mk(() => stemSink.live, opts.stemColor ?? "#3f9d4f", budget));
    group.add(mk(() => leafSink.live, opts.leafColor ?? "#7bd86a", Math.round(budget * 0.7)));
    petalColors.forEach((col, i) => group.add(mk(() => petalSinks[i]!.live, col, Math.round(budget * 0.6))));
    group.add(mk(() => centerSink.live, opts.centerColor ?? "#ffe7a0", Math.round(budget * 0.3)));
    return { object: group };
  },
);
