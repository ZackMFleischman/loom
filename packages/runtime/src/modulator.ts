import { z } from "zod";
import { lagSignal } from "./control";
import type { FrameCtx } from "./frame";
import type { AudioBusLike } from "./inputbus/audio";
import type { ParamType } from "./param";

/**
 * Run-time param modulators (the live-performance layer over the same math
 * as the lfo control module): a spec is plain JSON attached to one
 * (instance, paramPath) pair; createModulator compiles it to a per-frame
 * evaluator. Phase advances by f.dt only when evaluated, so pausing the
 * engine's modulator pass (PANIC) freezes phase and RESUME never jumps
 * (FR-10); periodBeats converts via live BPM each frame, so tap-tempo
 * retunes every synced modulator at once (FR-5).
 */

const Rate = {
  periodSeconds: z.number().positive().optional(),
  periodBeats: z.number().positive().optional(),
  /** 0..1 start offset so two modulators can be staggered. */
  phase: z.number().min(0).max(1).default(0),
};
const Range = { lo: z.number().optional(), hi: z.number().optional() };

export const ModulatorSpec = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("sine"), ...Rate, ...Range }),
  z.strictObject({ type: z.literal("triangle"), ...Rate, ...Range }),
  z.strictObject({
    type: z.literal("ramp"),
    direction: z.enum(["up", "down"]).default("up"),
    ...Rate,
    ...Range,
  }),
  z.strictObject({
    type: z.literal("square"),
    duty: z.number().min(0).max(1).default(0.5),
    ...Rate,
    ...Range,
  }),
  z.strictObject({ type: z.literal("random"), ...Rate, ...Range }),
  z.strictObject({
    type: z.literal("drift"),
    smooth: z.number().positive().optional(),
    ...Rate,
    ...Range,
  }),
  z.strictObject({
    type: z.literal("cycle"),
    order: z.enum(["forward", "reverse", "pingpong", "random"]).default("forward"),
    values: z.array(z.number()).min(1).optional(),
    ...Rate,
    ...Range,
  }),
  z.strictObject({
    type: z.literal("audio"),
    band: z.enum(["bass", "mid", "treble", "rms"]).default("rms"),
    smooth: z.number().nonnegative().default(0.05),
    ...Range,
  }),
]);
export type ModulatorSpec = z.infer<typeof ModulatorSpec>;
export type ModulatorType = ModulatorSpec["type"];

/** What a modulator needs to know about its target param. */
export interface ModulatorParamMeta {
  type: ParamType;
  min?: number | undefined;
  max?: number | undefined;
  /** Current value — drift starts here so attaching never jumps. */
  value?: number | boolean | undefined;
}

/** World hooks: live BPM for beat-synced rates, audio for the follower. */
export interface ModulatorBus {
  bpm(): number;
  audio?: AudioBusLike | undefined;
}

export type ModulatorEval = (f: FrameCtx) => number | boolean;

const BOOL_OK: ReadonlySet<ModulatorType> = new Set(["square", "random", "cycle"]);

/**
 * Compile a validated spec into a per-frame evaluator for one param.
 * Throws clear errors on spec/param mismatches (FR-6 and the v1
 * applicability matrix). Evaluators allocate nothing per call (NFR-1).
 */
export function createModulator(
  spec: ModulatorSpec,
  param: ModulatorParamMeta,
  bus: ModulatorBus,
): ModulatorEval {
  if (param.type === "bool") {
    if (!BOOL_OK.has(spec.type)) {
      throw new Error(`${spec.type} cannot modulate a bool param — use square, random, or cycle`);
    }
    if (spec.lo !== undefined || spec.hi !== undefined) {
      throw new Error("bool params take no lo/hi range");
    }
  }
  if (spec.type === "audio") {
    if (!bus.audio) throw new Error("audio modulator needs an audio bus");
  } else if ((spec.periodSeconds === undefined) === (spec.periodBeats === undefined)) {
    throw new Error(`${spec.type} needs exactly one of periodSeconds or periodBeats`);
  }

  // FR-6: [lo, hi] defaults to the declared range and can never escape it.
  const min = param.min ?? 0;
  const max = param.max ?? 1;
  const lo = spec.lo ?? min;
  const hi = spec.hi ?? max;
  if (param.type !== "bool" && !(min <= lo && lo <= hi && hi <= max)) {
    throw new Error(`range [${lo}, ${hi}] must satisfy min ≤ lo ≤ hi ≤ max within [${min}, ${max}]`);
  }
  const span = hi - lo;
  const map = (w: number) => lo + w * span;
  const frac = (p: number) => ((p % 1) + 1) % 1;

  const periodSec = (): number =>
    spec.type === "audio"
      ? 1
      : (spec.periodSeconds ?? ((spec.periodBeats ?? 1) * 60) / Math.max(bus.bpm(), 1e-6));
  // Phase advances only when the engine evaluates — PANIC pauses, RESUME
  // continues with no catch-up burst (FR-10).
  let phase = spec.type === "audio" ? 0 : spec.phase;
  const advance = (f: FrameCtx): number => {
    const p = phase;
    phase += f.dt / periodSec();
    return p;
  };

  switch (spec.type) {
    case "sine":
      return (f) => map(0.5 - 0.5 * Math.cos(frac(advance(f)) * Math.PI * 2));
    case "triangle":
      return (f) => {
        const p = frac(advance(f));
        return map(p < 0.5 ? p * 2 : 2 - p * 2);
      };
    case "ramp": {
      const up = spec.direction === "up";
      return (f) => {
        const p = frac(advance(f));
        return map(up ? p : 1 - p);
      };
    }
    case "square": {
      const duty = spec.duty;
      if (param.type === "bool") return (f) => frac(advance(f)) < duty;
      return (f) => map(frac(advance(f)) < duty ? 1 : 0);
    }
    case "random": {
      let last = -1;
      let held: number | boolean = param.type === "bool" ? false : lo;
      return (f) => {
        const idx = Math.floor(advance(f));
        if (idx > last) {
          last = idx;
          held = param.type === "bool" ? Math.random() < 0.5 : lo + Math.random() * span;
        }
        return held;
      };
    }
    case "drift": {
      let last = -1;
      let target = lo + span / 2;
      let value =
        typeof param.value === "number" ? Math.min(hi, Math.max(lo, param.value)) : lo + span / 2;
      return (f) => {
        const idx = Math.floor(advance(f));
        if (idx > last) {
          last = idx;
          target = lo + Math.random() * span;
        }
        const tc = spec.smooth ?? periodSec() / 2;
        value += (target - value) * (1 - Math.exp(-f.dt / Math.max(tc, 1e-4)));
        return value;
      };
    }
    case "cycle": {
      let list: ReadonlyArray<number | boolean>;
      if (param.type === "bool") list = [false, true];
      else if (spec.values) {
        for (const v of spec.values) {
          if (v < min || v > max) {
            throw new Error(`cycle value ${v} is outside the param range [${min}, ${max}]`);
          }
        }
        list = spec.values;
      } else if (param.type === "int") {
        const steps: number[] = [];
        for (let v = Math.ceil(lo); v <= Math.floor(hi); v++) steps.push(v);
        if (steps.length === 0) throw new Error(`no integer steps inside [${lo}, ${hi}]`);
        list = steps;
      } else {
        throw new Error("cycle on a float param needs an explicit values list");
      }
      const ord = spec.order;
      let last = -1;
      let step = ord === "reverse" ? 0 : -1;
      let dir = 1;
      return (f) => {
        const idx = Math.floor(advance(f));
        if (idx > last) {
          last = idx;
          if (ord === "random") step = Math.floor(Math.random() * list.length);
          else if (ord === "forward") step = (step + 1) % list.length;
          else if (ord === "reverse") step = (step - 1 + list.length) % list.length;
          else if (list.length > 1) {
            if (step + dir < 0 || step + dir >= list.length) dir = -dir;
            step += dir;
          } else step = 0;
        }
        return list[Math.max(step, 0)]!;
      };
    }
    case "audio": {
      const audio = bus.audio!;
      const src = spec.band === "rms" ? audio.rms : audio.band(spec.band);
      const smoothed = lagSignal(src, spec.smooth);
      return (f) => map(Math.min(1, Math.max(0, smoothed.get(f))));
    }
  }
}
