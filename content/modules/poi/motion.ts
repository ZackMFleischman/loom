import { asSignal, type FrameCtx, Signal, type SignalLike } from "@loom/runtime";
import { MANEUVERS, type PoiStyle } from "./maneuvers";

/**
 * STAGE 2 — the motion engine. Turns a maneuver index (from `poiSequencer`)
 * into the live positions of two glowing heads, two hands and the spinner
 * pivot, all in centered height units (y down, x already aspect-corrected so
 * circles stay round — feed straight to the `poiHeads` source).
 *
 * Why transitions are smooth, by construction:
 *  1. Arm/poi ANGLES are integrated from rates — never set absolutely. Changing
 *     the maneuver changes target rates; the integral (position) stays C0.
 *  2. Every target (rates, radii, separation, tilt, timing) is EASED with a
 *     time constant (`morph`) — so velocities change C1, no kinks.
 *  3. A small phase-locked loop nudges the two poi/arms toward the maneuver's
 *     target timing offset, so "same-time → split-time" slides in over a beat
 *     instead of jumping (real spinners call this *phasing*).
 *  4. A direction reversal eased through zero IS a stall — which is exactly how
 *     the `"stall"`/`"pendulum"` styles are produced (no special-casing).
 */

export interface PoiMotionOpts {
  /** Current maneuver index (poiSequencer output). */
  index: SignalLike;
  /** Beat clock — ctx.time.beats. Drives intra-move automation (stalls/binds). */
  beats: Signal<number>;
  /** Overall spin speed in revolutions/sec. */
  speed: SignalLike;
  /** Pattern size multiplier. */
  scale: SignalLike;
  /** Transition ease time constant, seconds (how fast a new move blends in). */
  morph: SignalLike;
  /** Global vertical center bias, added to each maneuver's centerY. */
  centerY?: SignalLike;
  /** Multiplies each maneuver's plane tilt (a camera lean toward the wheel plane). */
  tiltBias?: SignalLike;
}

export interface PoiPoint {
  x: Signal<number>;
  y: Signal<number>;
}

export interface PoiMotion {
  /** The two glowing heads. */
  heads: [PoiPoint, PoiPoint];
  /** The two hands (string anchors). */
  hands: [PoiPoint, PoiPoint];
  /** The spinner's body center. */
  pivot: PoiPoint;
  /** Eased trail bias 0..1 from the active maneuver (map to feedback persistence). */
  trailBias: Signal<number>;
}

const TAU = Math.PI * 2;
/** Wrap an angle error into [-π, π]. */
const wrapPi = (x: number) => ((((x + Math.PI) % TAU) + TAU) % TAU) - Math.PI;

/** Style automation: how a maneuver modulates its own targets on the beat clock. */
function styleMod(style: PoiStyle, beats: number): { dir: number; freq: number; radius: number } {
  switch (style) {
    case "stall":
      // Smoothly reverse every 4 beats — eased rate crosses zero → a held stall.
      return { dir: Math.cos((beats * Math.PI) / 2), freq: 1, radius: 1 };
    case "pendulum":
      // A wide back-and-forth swing that never closes the circle (over-driven so
      // the arc is generous, not a twitch).
      return { dir: 1.9 * Math.cos(beats * Math.PI * 0.7), freq: 1, radius: 1 };
    case "bind":
      // String spirals in to a third of its length and blooms back out over 4 beats.
      return { dir: 1, freq: 1, radius: 0.32 + 0.68 * (0.5 + 0.5 * Math.cos((beats * Math.PI) / 2)) };
    default:
      return { dir: 1, freq: 1, radius: 1 };
  }
}

/**
 * Build the poi motion engine. Runs one integration per frame (guarded so the
 * first output pulled does the work, the rest read the cache) and exposes every
 * position as a Signal — wire them into `poiHeads` via `ctx.uniformOf`.
 */
export function poiMotion(opts: PoiMotionOpts): PoiMotion {
  const index = asSignal(opts.index);
  const beats = opts.beats;
  const speedS = asSignal(opts.speed);
  const scaleS = asSignal(opts.scale);
  const morphS = asSignal(opts.morph);
  const centerYS = asSignal(opts.centerY ?? 0);
  const tiltBiasS = asSignal(opts.tiltBias ?? 1);

  // Integrated angles (continuous across maneuver changes). Start aligned so a
  // cold boot is clean; the phase-locks ease into each move's split/weave offset.
  let aA = 0, aB = 0; // arms
  let pA = 0, pB = 0; // poi swings
  let body = 0; // whole-pattern rotation

  // Eased BASE targets (style automation applies on top, after easing).
  let eArmRate = 0, eBasePoiRateA = 0, eBasePoiRateB = 0, eSpin = 0;
  let eArmR = 0, eBasePoiR = 0.3, eHandSep = 0.34, eTilt = 1, eCenterY = 0;
  let eTiming = 0, eArmOff = 0, eTrail = 0.5;
  let inited = false;

  // Cached outputs.
  const out = {
    hAx: 0, hAy: 0, hBx: 0, hBy: 0, // heads
    nAx: 0, nAy: 0, nBx: 0, nBy: 0, // hands
    px: 0, py: 0, // pivot
    trail: 0.5,
  };
  let lastFrame = -1;

  function update(f: FrameCtx) {
    if (f.frame === lastFrame) return;
    lastFrame = f.frame;

    const i = Math.max(0, Math.min(MANEUVERS.length - 1, Math.round(index.get(f))));
    const t = MANEUVERS[i]!.targets;
    const b = beats.get(f);
    const base = TAU * speedS.get(f);
    const scale = scaleS.get(f);
    const tau = Math.max(0.02, morphS.get(f));
    const dt = Math.min(0.1, f.dt);
    const sm = styleMod(t.style, b);

    // BASE targets — no style automation (that applies AFTER easing, so fast
    // stall/pendulum swings aren't smoothed away by the slow transition morph).
    const armRateT = base * t.armFreq * t.armDir;
    const basePoiRateAT = base * t.poiFreq * t.poiDir;
    const basePoiRateBT = basePoiRateAT * (t.mirror ? -1 : 1);
    const spinT = base * t.spin;
    const tiltT = Math.max(0.05, Math.min(1, t.tilt * tiltBiasS.get(f)));

    if (!inited) {
      inited = true;
      eArmRate = armRateT; eBasePoiRateA = basePoiRateAT; eBasePoiRateB = basePoiRateBT; eSpin = spinT;
      eArmR = t.armR; eBasePoiR = t.poiR; eHandSep = t.handSep; eTilt = tiltT;
      eCenterY = t.centerY; eTiming = t.timing; eArmOff = t.armOffset; eTrail = t.trail;
      // Isolations want the head to START cancelled (head at the hand-center),
      // so seed the poi phase at its arm phase + lock so frame 1 is already an iso.
      if (t.isoLock != null) { pA = aA + t.isoLock; pB = aB + t.isoLock; }
    }

    // Ease BASE targets (this is what makes transitions smooth).
    const a = 1 - Math.exp(-dt / tau);
    eArmRate += (armRateT - eArmRate) * a;
    eBasePoiRateA += (basePoiRateAT - eBasePoiRateA) * a;
    eBasePoiRateB += (basePoiRateBT - eBasePoiRateB) * a;
    eSpin += (spinT - eSpin) * a;
    eArmR += (t.armR - eArmR) * a;
    eBasePoiR += (t.poiR - eBasePoiR) * a;
    eHandSep += (t.handSep - eHandSep) * a;
    eTilt += (tiltT - eTilt) * a;
    eCenterY += (t.centerY - eCenterY) * a;
    eTiming += (t.timing - eTiming) * a;
    eArmOff += (t.armOffset - eArmOff) * a;
    eTrail += (t.trail - eTrail) * a;

    // Style automation applied directly (undamped) — keeps its full amplitude.
    const poiRateA = eBasePoiRateA * sm.dir * sm.freq;
    const poiRateB = eBasePoiRateB * sm.dir * sm.freq;

    // Phase locks (bounded so they never overpower the integrated motion). Arms
    // always lock to their offset. Poi lock to each other (timing) — or, for an
    // isolation, each poi locks to its OWN arm so the head hangs still while the
    // string sweeps a halo around it.
    const kp = 2.0;
    const cap = base * 0.8 + 0.6;
    const clampc = (x: number) => Math.max(-cap, Math.min(cap, x));
    const corrArm = clampc(kp * wrapPi(eArmOff - (aB - aA)));
    let corrPoiA = 0, corrPoiB = 0;
    if (t.isoLock != null) {
      corrPoiA = clampc(kp * wrapPi(t.isoLock - (pA - aA)));
      corrPoiB = clampc(kp * wrapPi(t.isoLock - (pB - aB)));
    } else {
      corrPoiB = clampc(kp * (t.mirror ? wrapPi(eTiming - (pB + pA)) : wrapPi(eTiming - (pB - pA))));
    }

    // Integrate angles.
    aA += eArmRate * dt;
    aB += (eArmRate + corrArm) * dt;
    pA += (poiRateA + corrPoiA) * dt;
    pB += (poiRateB + corrPoiB) * dt;
    body += eSpin * dt;
    // Keep phases bounded for float precision over a long set.
    aA %= TAU; aB %= TAU; pA %= TAU; pB %= TAU; body %= TAU;

    // Geometry in centered height units (y down; tilt squashes the vertical axis).
    const armR = eArmR * scale;
    const poiR = eBasePoiR * sm.radius * scale;
    const sep = eHandSep * scale;
    const cy = eCenterY + centerYS.get(f);
    const cb = Math.cos(body), sb = Math.sin(body);
    const rot = (x: number, y: number): [number, number] => {
      const dy = y - cy;
      return [cb * x - sb * dy, cy + sb * x + cb * dy];
    };

    // Hand A (left) / B (right).
    const nAx0 = -sep * 0.5 + armR * Math.cos(aA);
    const nAy0 = cy + armR * Math.sin(aA) * eTilt;
    const nBx0 = +sep * 0.5 + armR * Math.cos(aB);
    const nBy0 = cy + armR * Math.sin(aB) * eTilt;
    const hAx0 = nAx0 + poiR * Math.cos(pA);
    const hAy0 = nAy0 + poiR * Math.sin(pA) * eTilt;
    const hBx0 = nBx0 + poiR * Math.cos(pB);
    const hBy0 = nBy0 + poiR * Math.sin(pB) * eTilt;

    [out.nAx, out.nAy] = rot(nAx0, nAy0);
    [out.nBx, out.nBy] = rot(nBx0, nBy0);
    [out.hAx, out.hAy] = rot(hAx0, hAy0);
    [out.hBx, out.hBy] = rot(hBx0, hBy0);
    [out.px, out.py] = rot(0, cy);
    out.trail = eTrail;
  }

  const sig = (read: () => number) =>
    new Signal((f: FrameCtx) => {
      update(f);
      return read();
    });

  return {
    heads: [
      { x: sig(() => out.hAx), y: sig(() => out.hAy) },
      { x: sig(() => out.hBx), y: sig(() => out.hBy) },
    ],
    hands: [
      { x: sig(() => out.nAx), y: sig(() => out.nAy) },
      { x: sig(() => out.nBx), y: sig(() => out.nBy) },
    ],
    pivot: { x: sig(() => out.px), y: sig(() => out.py) },
    trailBias: sig(() => out.trail),
  };
}
