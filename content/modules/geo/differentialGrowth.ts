import { asSignal, BuildCtx, defineModule, type GeoNode, type SignalLike } from "@loom/runtime";
import { Vector3 } from "three/webgpu";
import { lineRibbon } from "./lineRibbon";

export interface DifferentialGrowthOpts {
  /** Starting nodes on the seed ring (the line grows from here). */
  startNodes?: number;
  /** Hard cap on node count (perf guard — growth stops splitting past this). */
  maxNodes?: number;
  /** Local repulsion radius — nodes push apart within this distance. */
  repelRadius?: SignalLike;
  /** Repulsion strength (Signal-able — feed bass for fuller, crumplier coral). */
  repel?: SignalLike;
  /** Attraction (spring) strength toward the two chain neighbours. */
  attract?: SignalLike;
  /** Edge length a segment must exceed to split (smaller = denser meander). */
  splitLength?: SignalLike;
  /** Per-frame split-rate scale (Signal-able — feed a kick to spurt growth). */
  growth?: SignalLike;
  /** Stroke half-thickness (forwarded to lineRibbon). */
  width?: SignalLike;
  /** Stroke colour "#rrggbb". */
  color?: string;
  /** Emissive intensity (forwarded to lineRibbon — flare on the kick). */
  glow?: SignalLike;
  /** PRNG seed (deterministic init + split jitter; no Math.random). */
  seed?: number;
}

/** Seeded PRNG (mulberry32) — deterministic, no Math.random (fixture-safe). */
const mulberry32 = (seed: number) => () => {
  seed += 0x6d2b79f5;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/**
 * Differential growth as a GeoNode: a closed polyline whose every node REPELS
 * neighbours within a radius (spatial-hash grid → O(n)), ATTRACTS along the
 * chain toward its two neighbours, and SPLITS — a fresh node inserted wherever
 * an edge stretches past a threshold — so the line lengthens and crumples into
 * space-filling organic meanders (coral / brain-coral). CPU-procedural, advanced
 * over the frame clock, seeded (mulberry32) so fixture replays match, and node
 * count is hard-capped for the frame budget. Renders through the shared
 * `lineRibbon`; audio rides the repulsion (bass) and split rate (kick).
 */
export const differentialGrowth = defineModule(
  {
    name: "differentialGrowth",
    kind: "geo",
    description: "A polyline that repels locally, attracts along the chain and splits stretched edges — organic coral meanders; render via render3d.",
    tags: ["3d", "growth", "differential-growth", "coral", "organic", "generative", "audio-reactive", "geo"],
    example: 'render3d(ctx, { world: [differentialGrowth(ctx, { repel: ctx.input("bass"), growth: ctx.input("kick") })], cam: orbitCam(ctx, {}) })',
  },
  (ctx: BuildCtx, opts: DifferentialGrowthOpts = {}): GeoNode => {
    const startNodes = Math.max(8, Math.min(200, Math.round(opts.startNodes ?? 24)));
    const maxNodes = Math.max(startNodes + 8, Math.min(4000, Math.round(opts.maxNodes ?? 1400)));
    const repelRadius = asSignal(opts.repelRadius ?? 0.09);
    const repel = asSignal(opts.repel ?? 1);
    const attract = asSignal(opts.attract ?? 0.55);
    const splitLength = asSignal(opts.splitLength ?? 0.05);
    const growth = asSignal(opts.growth ?? 1);
    const rng = mulberry32(opts.seed ?? 0xc02a1);

    // Seed: a small jittered ring in the XY plane (z≈0 — a flat coral sheet).
    let nodes: Vector3[] = [];
    const R0 = 0.25;
    for (let i = 0; i < startNodes; i++) {
      const a = (i / startNodes) * Math.PI * 2;
      const jit = 1 + (rng() - 0.5) * 0.12;
      nodes.push(new Vector3(Math.cos(a) * R0 * jit, Math.sin(a) * R0 * jit, (rng() - 0.5) * 0.01));
    }

    // Scratch.
    const force = new Vector3();
    const diff = new Vector3();
    const grid = new Map<number, number[]>(); // spatial hash for the O(n) repel query
    const newNode = new Vector3();

    // One relaxation iteration: repulsion (capped per node so it never blows the
    // curve into crossings) + Laplacian smoothing toward the neighbour midpoint.
    // Displacements computed against the FROZEN positions, then applied — a
    // Jacobi step. Run several per frame so the curve stays relaxed as it grows.
    const relaxStep = (rad: number, rep: number, att: number) => {
      const n = nodes.length;
      const rad2 = rad * rad;
      const maxMove = rad * 0.45; // cap keeps the solve stable / non-crossing

      // Spatial hash (cell = repel radius) — O(n) neighbour query in the XY plane.
      grid.clear();
      const cell = rad;
      for (let i = 0; i < n; i++) {
        const p = nodes[i]!;
        const k = (Math.floor(p.x / cell) * 73856093) ^ (Math.floor(p.y / cell) * 19349663);
        let bucket = grid.get(k);
        if (!bucket) grid.set(k, (bucket = []));
        bucket.push(i);
      }

      const forces: Vector3[] = [];
      for (let i = 0; i < n; i++) {
        const p = nodes[i]!;
        force.set(0, 0, 0);
        const cx = Math.floor(p.x / cell);
        const cy = Math.floor(p.y / cell);
        for (let gx = -1; gx <= 1; gx++) {
          for (let gy = -1; gy <= 1; gy++) {
            const bucket = grid.get(((cx + gx) * 73856093) ^ ((cy + gy) * 19349663));
            if (!bucket) continue;
            for (const j of bucket) {
              if (j === i) continue;
              diff.subVectors(p, nodes[j]!);
              const d2 = diff.lengthSq();
              if (d2 > 1e-10 && d2 < rad2) {
                const d = Math.sqrt(d2);
                // Push to a fixed target spacing (rad), normalised — strong & local.
                force.addScaledVector(diff, (rep * (rad - d)) / (d * rad));
              }
            }
          }
        }
        // Laplacian smoothing: ease toward the neighbours' midpoint (closed loop).
        const prev = nodes[(i - 1 + n) % n]!;
        const next = nodes[(i + 1) % n]!;
        diff.addVectors(prev, next).multiplyScalar(0.5).sub(p);
        force.addScaledVector(diff, att);
        force.z *= 0.6; // keep the sheet near-planar so the meander reads clean
        // Cap the per-iteration displacement → stable, never self-crossing.
        const fl = force.length();
        if (fl > maxMove) force.multiplyScalar(maxMove / fl);
        forces.push(force.clone());
      }
      for (let i = 0; i < n; i++) nodes[i]!.add(forces[i]!);
    };

    const split = (rate: number, thresh: number) => {
      if (nodes.length >= maxNodes) return;
      const out: Vector3[] = [];
      const n = nodes.length;
      for (let i = 0; i < n && out.length < maxNodes; i++) {
        const p = nodes[i]!;
        const q = nodes[(i + 1) % n]!;
        out.push(p);
        // Split a stretched edge: probability scales with overstretch × the rate knob.
        const len = p.distanceTo(q);
        if (len > thresh && out.length < maxNodes && rng() < Math.min(0.5, (len / thresh - 1) * 0.6 * rate)) {
          newNode.addVectors(p, q).multiplyScalar(0.5);
          // Tiny seeded nudge breaks symmetry so folds nucleate organically.
          newNode.x += (rng() - 0.5) * thresh * 0.15;
          newNode.y += (rng() - 0.5) * thresh * 0.15;
          out.push(newNode.clone());
        }
      }
      nodes = out;
    };

    let pathCache: Vector3[][] = [[...nodes, nodes[0]!]];
    ctx.updaters.push((f) => {
      const rad = Math.max(0.01, repelRadius.get(f));
      const rep = Math.max(0, repel.get(f));
      const att = Math.max(0, Math.min(1, attract.get(f)));
      const rate = Math.max(0, growth.get(f));
      const thresh = Math.max(0.005, splitLength.get(f));
      // Several relaxation iterations per frame keep the growing curve relaxed.
      for (let it = 0; it < 8; it++) relaxStep(rad, rep, att);
      split(rate, thresh);
      // Closed loop: repeat the first point so lineRibbon draws the closing edge.
      pathCache = [[...nodes, nodes[0]!]];
    });

    return lineRibbon(ctx, {
      paths: () => pathCache,
      width: opts.width ?? 0.008,
      color: opts.color ?? "#ff5d9e",
      ...(opts.glow !== undefined ? { glow: opts.glow } : {}),
      maxSegments: maxNodes + 4,
    });
  },
);
