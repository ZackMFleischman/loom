import { asSignal, type FrameCtx, Signal, type SignalLike } from "@loom/runtime";

/**
 * STAGE 1 — the poi-maneuver catalog and transition graph.
 *
 * Every poi move in this catalog is expressed in ONE motion model (see
 * `motion.ts`): two heads, each a point on a string (length `poiR`) whose hand
 * orbits a shoulder point (radius `armR`). Arm angle and poi angle are
 * integrated from rates, so a move is fully described by a handful of numeric
 * *targets* plus a `style` for intra-move automation (stalls, binds). Because
 * the engine integrates phase and EASES these targets, any maneuver can flow
 * into any other smoothly — the `flowsTo` graph only encodes which transitions
 * read as musical/natural for the auto-sequencer.
 *
 * Petal counts, weave beats, etc. emerge from the arm/poi frequency ratio
 * (classic spirograph math): an antispin flower of N petals runs the poi N+1
 * turns against 1 arm turn in the OPPOSITE direction; an inspin flower of N
 * petals runs N-1 turns the SAME direction. Numbers below are tuned by eye.
 */

/** Intra-maneuver automation the motion engine applies on its own beat clock. */
export type PoiStyle =
  | "flow" // steady — the move just runs
  | "stall" // poi direction smoothly reverses every few beats (stall → switch dir)
  | "pendulum" // poi never completes a circle — it swings back and forth
  | "bind"; // string length spirals in and releases (wraps / binds)

export type PoiFamily =
  | "spin"
  | "flower"
  | "weave"
  | "windmill"
  | "stall"
  | "wrap"
  | "hybrid"
  | "iso"
  | "showpiece";

/** The numeric target a maneuver eases the motion engine toward. */
export interface PoiTargets {
  /** Arm/hand orbit radius (0 = a static hand: pure poi spin / isolation-from-center). */
  armR: number;
  /** Poi string length. */
  poiR: number;
  /** Arm revolutions, relative (actual rad/s = base·speed·armFreq). */
  armFreq: number;
  /** Poi revolutions, relative — its ratio to armFreq sets the petal count. */
  poiFreq: number;
  /** Overall arm direction. */
  armDir: 1 | -1;
  /** Poi base direction: +1 inspin (same as arm), -1 antispin (opposite). */
  poiDir: 1 | -1;
  /** 1 = the two poi mirror each other (B rate = -A rate); 0 = parallel (same rate). */
  mirror: 0 | 1;
  /** Target phase offset between the two poi, radians (0 = same-time, π = split-time). */
  timing: number;
  /** Target phase offset between the two arms, radians (π = alternating-arm weaves). */
  armOffset: number;
  /** Horizontal separation between the two shoulder points (per-shoulder moves). */
  handSep: number;
  /** Vertical center offset of the whole pattern (height units, + = down). */
  centerY: number;
  /** Plane: 1 = wall plane (full circles facing us), →0.12 = wheel/edge plane (squashed). */
  tilt: number;
  /** Whole-pattern rotation rate, relative (turning travels / CATs / camera body-turn). */
  spin: number;
  /** Suggested trail bias 0..1 — the scene maps it to feedback persistence. */
  trail: number;
  /** Intra-move automation. */
  style: PoiStyle;
  /**
   * Isolation lock (radians) — when set, each poi phase-locks to its OWN arm at
   * this offset (use π with armR == poiR so the head hangs still and the string
   * sweeps a halo). Leave undefined for every non-isolation move.
   */
  isoLock?: number;
}

export interface Maneuver {
  id: string;
  name: string;
  family: PoiFamily;
  /** One-line description of what it looks like. */
  blurb: string;
  targets: PoiTargets;
  /** Maneuvers this one flows naturally into (the transition graph edges). */
  flowsTo: string[];
}

const DEFAULTS: PoiTargets = {
  armR: 0,
  poiR: 0.3,
  armFreq: 1,
  poiFreq: 1,
  armDir: 1,
  poiDir: 1,
  mirror: 0,
  timing: 0,
  armOffset: 0,
  handSep: 0,
  centerY: 0,
  tilt: 1,
  spin: 0,
  trail: 0.5,
  style: "flow",
};

const mv = (
  id: string,
  name: string,
  family: PoiFamily,
  blurb: string,
  targets: Partial<PoiTargets>,
  flowsTo: string[],
): Maneuver => ({ id, name, family, blurb, targets: { ...DEFAULTS, ...targets }, flowsTo });

/**
 * The catalog — 44 maneuvers across the families a flow artist actually spins.
 * `handSep` > 0 means a two-handed, per-shoulder move (weaves, windmills);
 * `handSep` 0 means both poi share a center (flowers, butterflies, CATs).
 */
export const MANEUVERS: Maneuver[] = [
  // ── Basic spins ──────────────────────────────────────────────────────────
  mv("forward-spin", "Forward Spin", "spin", "Both poi wheel forward together — the home position.",
    { handSep: 0.34, poiR: 0.28, timing: 0, mirror: 0, trail: 0.45 },
    ["split-time", "reverse-spin", "3-beat-weave", "windmill", "extension"]),
  mv("reverse-spin", "Reverse Spin", "spin", "Both poi wheel backward together.",
    { handSep: 0.34, poiR: 0.28, armDir: -1, poiDir: -1, trail: 0.45 },
    ["forward-spin", "split-time", "2-beat-weave", "windmill"]),
  mv("split-time", "Split-Time Spin", "spin", "The two poi run a half-beat apart — one up while one's down.",
    { handSep: 0.34, poiR: 0.28, timing: Math.PI, trail: 0.5 },
    ["forward-spin", "together-time", "butterfly", "stall-switch", "4-petal-antispin"]),
  mv("together-time", "Same-Time Spin", "spin", "Both heads locked in phase, sweeping as one.",
    { handSep: 0.34, poiR: 0.28, timing: 0, trail: 0.5 },
    ["split-time", "butterfly", "wall-plane-spin", "windmill"]),
  mv("extension", "Extension", "spin", "Long strings, slow wheel — wide arcs that fill the frame.",
    { handSep: 0.3, poiR: 0.4, armFreq: 0, poiFreq: 0.7, timing: Math.PI, trail: 0.6 },
    ["forward-spin", "comet", "windmill", "5-beat-weave"]),
  mv("wall-plane-spin", "Wall-Plane Spin", "spin", "Flat to the audience, two clean discs side by side.",
    { handSep: 0.36, poiR: 0.26, tilt: 1, trail: 0.45 },
    ["windmill", "fountain", "together-time", "turning-spin"]),
  mv("turning-spin", "Turning Spin", "spin", "The whole pattern slowly turns as if the spinner pivots.",
    { handSep: 0.34, poiR: 0.26, spin: 0.25, trail: 0.55 },
    ["forward-spin", "windmill", "cat-eye", "comet"]),

  // ── Wheel-plane / windmills ──────────────────────────────────────────────
  mv("windmill", "Windmill", "windmill", "Wheel plane, split-time — the textbook windmill turning over.",
    { handSep: 0.3, poiR: 0.27, tilt: 0.45, timing: Math.PI, trail: 0.5 },
    ["fountain", "forward-spin", "3-beat-weave", "tractor", "wall-plane-spin"]),
  mv("fountain", "Fountain", "windmill", "Same as a windmill but same-time — water arcing up and out.",
    { handSep: 0.3, poiR: 0.27, tilt: 0.45, timing: 0, trail: 0.5 },
    ["windmill", "wall-plane-spin", "butterfly", "tractor"]),
  mv("tractor", "Tractor", "windmill", "Both poi on one side, stacked wheels grinding together.",
    { handSep: 0.16, poiR: 0.24, tilt: 0.4, timing: 0.6, trail: 0.5 },
    ["windmill", "fountain", "barrel-roll", "thread-the-needle"]),
  mv("barrel-roll", "Barrel Roll", "windmill", "Wheel plane tumbling forward, strings long and lazy.",
    { handSep: 0.26, poiR: 0.34, tilt: 0.35, armDir: -1, poiDir: -1, trail: 0.6 },
    ["windmill", "comet", "tractor", "extension"]),

  // ── Butterflies ──────────────────────────────────────────────────────────
  mv("butterfly", "Butterfly", "spin", "Both poi out front mirrored — the classic crossing wings.",
    { handSep: 0.0, poiR: 0.34, mirror: 1, timing: 0, trail: 0.5 },
    ["split-butterfly", "buzzsaw", "forward-spin", "wall-plane-spin", "flower-butterfly"]),
  mv("split-butterfly", "Split-Time Butterfly", "spin", "Mirrored wings half a beat apart — they kiss and part.",
    { handSep: 0.0, poiR: 0.34, mirror: 1, timing: Math.PI, trail: 0.55 },
    ["butterfly", "buzzsaw", "flower-butterfly", "stall-switch"]),
  mv("flower-butterfly", "Flower Butterfly", "flower", "A butterfly bent into antispin petals — a blooming wing.",
    { handSep: 0.0, armR: 0.12, poiR: 0.26, armFreq: 1, poiFreq: 5, poiDir: -1, mirror: 1, trail: 0.6 },
    ["butterfly", "4-petal-antispin", "6-petal-inspin", "split-butterfly"]),

  // ── Flowers (antispin: poi opposite the arm circle) ──────────────────────
  mv("3-petal-antispin", "3-Petal Antispin", "flower", "A trefoil of three crisp scalloped petals.",
    { handSep: 0.0, armR: 0.14, poiR: 0.22, armFreq: 1, poiFreq: 4, poiDir: -1, timing: Math.PI, trail: 0.62 },
    ["4-petal-antispin", "3-petal-inspin", "isolation", "split-time"]),
  mv("4-petal-antispin", "4-Petal Antispin", "flower", "Four petals, the signature antispin flower.",
    { handSep: 0.0, armR: 0.14, poiR: 0.22, armFreq: 1, poiFreq: 5, poiDir: -1, timing: Math.PI, trail: 0.64 },
    ["5-petal-antispin", "4-petal-inspin", "flower-butterfly", "cat-eye"]),
  mv("5-petal-antispin", "5-Petal Antispin", "flower", "Five-pointed star bloom — dense and hypnotic.",
    { handSep: 0.0, armR: 0.14, poiR: 0.2, armFreq: 1, poiFreq: 6, poiDir: -1, timing: Math.PI, trail: 0.66 },
    ["4-petal-antispin", "6-petal-inspin", "isolation"]),
  mv("6-petal-antispin", "6-Petal Antispin", "flower", "Six petals — a fast, lacy rosette.",
    { handSep: 0.0, armR: 0.13, poiR: 0.18, armFreq: 1, poiFreq: 7, poiDir: -1, timing: Math.PI, trail: 0.68 },
    ["5-petal-antispin", "5-petal-inspin", "cat-eye"]),

  // ── Flowers (inspin: poi same direction as the arm circle) ────────────────
  mv("3-petal-inspin", "3-Petal Inspin", "flower", "Three rounded inspin lobes curling outward.",
    { handSep: 0.0, armR: 0.16, poiR: 0.2, armFreq: 1, poiFreq: 2, poiDir: 1, timing: Math.PI, trail: 0.62 },
    ["4-petal-inspin", "3-petal-antispin", "isolation"]),
  mv("4-petal-inspin", "4-Petal Inspin", "flower", "Four inspin lobes — a soft pinwheel.",
    { handSep: 0.0, armR: 0.16, poiR: 0.2, armFreq: 1, poiFreq: 3, poiDir: 1, timing: Math.PI, trail: 0.64 },
    ["5-petal-inspin", "4-petal-antispin", "flower-butterfly"]),
  mv("5-petal-inspin", "5-Petal Inspin", "flower", "Five inspin lobes spiralling round the center.",
    { handSep: 0.0, armR: 0.15, poiR: 0.18, armFreq: 1, poiFreq: 4, poiDir: 1, timing: Math.PI, trail: 0.66 },
    ["6-petal-inspin", "5-petal-antispin"]),
  mv("6-petal-inspin", "6-Petal Inspin", "flower", "Six inspin lobes — a tight churning daisy.",
    { handSep: 0.0, armR: 0.14, poiR: 0.16, armFreq: 1, poiFreq: 5, poiDir: 1, timing: Math.PI, trail: 0.68 },
    ["5-petal-inspin", "6-petal-antispin", "isolation"]),

  // ── Isolations & CATs (the head hangs still / orbits a point) ──────────────
  mv("isolation", "Isolation", "iso", "Two heads hang dead still while the strings sweep haloes around them.",
    { handSep: 0.32, armR: 0.19, poiR: 0.19, armFreq: 1, poiFreq: 1, poiDir: 1, isoLock: Math.PI, trail: 0.72 },
    ["cat-eye", "3-petal-antispin", "two-bean", "isolated-triquetra"]),
  mv("cat-eye", "Cat-Eye", "iso", "A pinched almond orbit — the isolation loosened into an eye.",
    { handSep: 0.32, armR: 0.21, poiR: 0.15, armFreq: 1, poiFreq: 1, poiDir: 1, isoLock: Math.PI, trail: 0.7 },
    ["isolation", "two-bean", "4-petal-antispin"]),
  mv("two-bean", "Two-Bean", "iso", "Two kidney-bean isolations chasing nose to tail.",
    { handSep: 0.0, armR: 0.2, poiR: 0.24, armFreq: 1, poiFreq: 2, poiDir: -1, timing: Math.PI, trail: 0.7 },
    ["isolation", "cat-eye", "isolated-triquetra"]),
  mv("isolated-triquetra", "Isolated Triquetra", "iso", "A three-lobed knot of isolations woven into a trinity.",
    { handSep: 0.0, armR: 0.18, poiR: 0.22, armFreq: 1, poiFreq: 3, poiDir: -1, timing: Math.PI, trail: 0.72 },
    ["isolation", "two-bean", "5-petal-antispin"]),

  // ── Weaves (per-shoulder, alternating arms) ───────────────────────────────
  mv("2-beat-weave", "2-Beat Weave", "weave", "The simplest weave — two beats across the body.",
    { handSep: 0.4, poiR: 0.24, armR: 0.08, armFreq: 1, poiFreq: 2, armOffset: Math.PI, timing: Math.PI, trail: 0.5 },
    ["3-beat-weave", "forward-spin", "windmill"]),
  mv("3-beat-weave", "3-Beat Weave", "weave", "The bread-and-butter weave — three beats woven side to side.",
    { handSep: 0.42, poiR: 0.24, armR: 0.1, armFreq: 1, poiFreq: 3, armOffset: Math.PI, timing: Math.PI, trail: 0.52 },
    ["5-beat-weave", "2-beat-weave", "windmill", "turning-weave", "forward-spin"]),
  mv("5-beat-weave", "5-Beat Weave", "weave", "A long luxurious weave — five beats of looping arcs.",
    { handSep: 0.44, poiR: 0.22, armR: 0.12, armFreq: 1, poiFreq: 5, armOffset: Math.PI, timing: Math.PI, trail: 0.56 },
    ["3-beat-weave", "turning-weave", "extension"]),
  mv("turning-weave", "Turning Weave", "weave", "A weave that rotates the whole body as it travels.",
    { handSep: 0.42, poiR: 0.22, armR: 0.1, armFreq: 1, poiFreq: 3, armOffset: Math.PI, timing: Math.PI, spin: 0.3, trail: 0.58 },
    ["3-beat-weave", "turning-spin", "thread-the-needle"]),
  mv("thread-the-needle", "Thread the Needle", "weave", "Tight crossed weave — the strings thread through a gap.",
    { handSep: 0.22, poiR: 0.2, armR: 0.06, armFreq: 1, poiFreq: 3, armOffset: Math.PI, timing: Math.PI, tilt: 0.7, trail: 0.55 },
    ["3-beat-weave", "tractor", "windmill"]),

  // ── Stalls & redirects (smooth direction reversals) ───────────────────────
  mv("stall-switch", "Stall & Switch", "stall", "One beat of stall, then the poi reverse and flow on.",
    { handSep: 0.3, poiR: 0.28, timing: Math.PI, style: "stall", trail: 0.55 },
    ["forward-spin", "split-time", "pendulum", "comet"]),
  mv("pendulum", "Pendulum", "stall", "Both poi swing like a clock, never closing the circle.",
    { handSep: 0.34, poiR: 0.3, timing: 0, style: "pendulum", trail: 0.5 },
    ["stall-switch", "buzzsaw", "forward-spin"]),
  mv("buzzsaw", "Buzzsaw", "stall", "A tight pendulum in front — the poi saw back and forth fast.",
    { handSep: 0.0, poiR: 0.26, mirror: 1, style: "pendulum", trail: 0.5 },
    ["butterfly", "pendulum", "split-butterfly"]),
  mv("point-stall", "Point Stall", "stall", "The poi freeze at the top, hang, then drop back — a held beat.",
    { handSep: 0.3, poiR: 0.3, timing: Math.PI, style: "stall", armFreq: 0, poiFreq: 0.8, trail: 0.45 },
    ["stall-switch", "extension", "forward-spin"]),

  // ── Wraps, binds & air wraps (string shortens / spirals) ──────────────────
  mv("spiral-bind", "Spiral Wrap", "wrap", "The strings spiral inward and snap back out — a wind-up bind.",
    { handSep: 0.0, armR: 0.1, poiR: 0.3, armFreq: 1, poiFreq: 4, poiDir: -1, style: "bind", timing: Math.PI, trail: 0.66 },
    ["air-wrap", "4-petal-antispin", "isolation", "comet"]),
  mv("air-wrap", "Air Wrap", "wrap", "A poi wraps the empty air and unspools — a whipping coil.",
    { handSep: 0.2, poiR: 0.32, armR: 0.06, armFreq: 0.5, poiFreq: 3, style: "bind", timing: Math.PI, trail: 0.62 },
    ["spiral-bind", "comet", "windmill"]),
  mv("body-wrap", "Body Wrap", "wrap", "The strings coil close to the center then bloom open.",
    { handSep: 0.12, poiR: 0.28, armR: 0.08, armFreq: 1, poiFreq: 2, style: "bind", timing: Math.PI, tilt: 0.6, trail: 0.6 },
    ["spiral-bind", "tractor", "isolation"]),

  // ── Hybrids & advanced ────────────────────────────────────────────────────
  mv("cap", "CAP", "hybrid", "Center-axis point — a four-petal antispin orbiting one fixed point.",
    { handSep: 0.0, armR: 0.16, poiR: 0.2, armFreq: 1, poiFreq: 3, poiDir: -1, timing: Math.PI, spin: 0.12, trail: 0.66 },
    ["4-petal-antispin", "isolated-triquetra", "hybrid-thread", "isolation"]),
  mv("hybrid-thread", "Hybrid Thread", "hybrid", "One poi inspins while the other antispins — woven asymmetry.",
    { handSep: 0.28, armR: 0.12, poiR: 0.22, armFreq: 1, poiFreq: 3, mirror: 1, poiDir: -1, timing: Math.PI * 0.5, trail: 0.64 },
    ["cap", "flower-butterfly", "3-petal-antispin"]),
  mv("triquetra", "Triquetra", "hybrid", "A three-cornered woven knot that keeps folding through itself.",
    { handSep: 0.0, armR: 0.18, poiR: 0.22, armFreq: 1, poiFreq: 4, poiDir: -1, mirror: 1, timing: Math.PI, trail: 0.7 },
    ["isolated-triquetra", "cap", "5-petal-antispin"]),

  // ── Showpieces ─────────────────────────────────────────────────────────────
  mv("comet", "Comet", "showpiece", "A single slow heavy sweep with a long burning tail.",
    { handSep: 0.12, poiR: 0.42, armFreq: 0, poiFreq: 0.55, timing: 0.4, trail: 0.85 },
    ["extension", "stall-switch", "forward-spin", "spiral-bind", "barrel-roll"]),
  mv("flower-comet", "Flower Comet", "showpiece", "An antispin flower drawn huge and slow — petals as comet tails.",
    { handSep: 0.0, armR: 0.16, poiR: 0.3, armFreq: 0.5, poiFreq: 2.5, poiDir: -1, timing: Math.PI, trail: 0.85 },
    ["comet", "4-petal-antispin", "isolation"]),
  mv("supernova", "Supernova", "showpiece", "Everything wide open, fast and mirrored — a blazing bloom.",
    { handSep: 0.0, armR: 0.18, poiR: 0.3, armFreq: 1, poiFreq: 6, poiDir: -1, mirror: 1, timing: Math.PI, trail: 0.8 },
    ["flower-comet", "supernova", "flower-butterfly", "triquetra"]),
];

/** Index lookup by id. */
export const MANEUVER_BY_ID: Record<string, number> = Object.fromEntries(
  MANEUVERS.map((m, i) => [m.id, i]),
);

/** The transition graph as index→indices adjacency (derived from `flowsTo`). */
export const TRANSITION_GRAPH: number[][] = MANEUVERS.map((m) =>
  m.flowsTo.map((id) => MANEUVER_BY_ID[id]).filter((i): i is number => i != null),
);

/** Deterministic mulberry32 — no Math.random (fixture determinism). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PoiSequencerOpts {
  /** Beat clock (ctx.time.beats). */
  beats: Signal<number>;
  /** When this is high (>0.5) the sequencer walks the graph; else it holds `manual`. */
  auto: SignalLike;
  /** Manual maneuver index when not auto. */
  manual: SignalLike;
  /** Beats to hold each maneuver before flowing to the next. */
  holdBeats: SignalLike;
  /** Seed for the walk. */
  seed?: number;
}

/**
 * Walks the transition graph, emitting the CURRENT maneuver index. It steps
 * only at hold-boundaries, picking a random `flowsTo` neighbour — the motion
 * engine eases between whatever indices it's handed, so the walk itself is just
 * "which move next". Falls back to the full catalog if a node has no edges.
 */
export function poiSequencer(opts: PoiSequencerOpts): Signal<number> {
  const beats = opts.beats;
  const auto = asSignal(opts.auto);
  const manual = asSignal(opts.manual);
  const hold = asSignal(opts.holdBeats);
  const rand = mulberry32(opts.seed ?? 0x10ed);
  let current = 0;
  let lastStep = -1e9;
  let started = false;
  return new Signal((f: FrameCtx) => {
    if (auto.get(f) <= 0.5) {
      const m = Math.round(manual.get(f));
      return Math.max(0, Math.min(MANEUVERS.length - 1, m));
    }
    const b = beats.get(f);
    const h = Math.max(0.25, hold.get(f));
    if (!started) {
      started = true;
      lastStep = b;
    }
    if (b - lastStep >= h) {
      lastStep = b;
      const edges = TRANSITION_GRAPH[current];
      const pool = edges && edges.length > 0 ? edges : MANEUVERS.map((_, i) => i);
      current = pool[Math.floor(rand() * pool.length) % pool.length]!;
    }
    return current;
  });
}
