# Param Modulators Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run-time attachable param modulators (sine/triangle/ramp/square/random/drift/cycle/audio) per `(instance, paramPath)`, driven from Console and MCP with zero code edits, per `feature-requests/param-modulators.md`.

**Architecture:** Modulator math + per-instance `ModulatorHost` state machine live in `@loom/runtime` (pure, fake-clock-testable). The engine stores one host per `SessionStore` entry, ticks all hosts each non-held frame *before* compositing, and writes values through `Manifest.get(path).set()` (clamping/int-rounding/uniform liveness free — FR-2). Protocol gains `modulate_param`/`clear_modulation` (agent-allowed, no arming); spec validation happens engine-side via the runtime zod schema. Console gets a ∿ button + popover per param row.

**Tech Stack:** TypeScript, zod 4, vitest (fake clock via `test/helpers.ts`), MCP SDK, Playwright validator.

**Key design refinements vs the feature-request sketch** (log in DECISIONS.md):
- Evaluators advance phase by `f.dt` per call (beats mode converts `periodBeats → seconds` from live BPM each frame). PANIC = engine stops calling = phase frozen; RESUME continues with no catch-up — FR-10 is structural, no pause bookkeeping. BPM/tap retunes immediately — FR-5.
- `ModulatorBus` is `{ bpm(): number; audio?: AudioBusLike }` (not a beats Signal) for exactly that reason.
- `ModulatorHost` (attach/clear/tick/reattach + FR-9 containment) lives in runtime so FR-4/FR-9 are unit-tested; the engine only schedules and stores (NFR-2).
- Validator is `validate:modulators` (m-numbering stays reserved for milestones). `validate-m4`'s expected MCP tool list grows by the two new tools (its intent — no `set_audio` for agents — is preserved).
- `cycle` on int accepts an optional explicit `values` list too (the 4→8→16→32 slices case); without it, lo..hi unit steps.

---

### Task 1: Runtime modulator kernel (`modulator.ts`)

**Files:**
- Create: `packages/runtime/src/modulator.ts`
- Test: `packages/runtime/test/modulator.test.ts`

- [ ] **Step 1: Write failing tests** (schema/validation, clocked carriers, interval types, audio)

```ts
// packages/runtime/test/modulator.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { Events } from "../src/events";
import type { AudioBusLike } from "../src/inputbus/audio";
import { createModulator, ModulatorSpec, type ModulatorBus } from "../src/modulator";
import { Signal } from "../src/signal";
import { F, frames } from "./helpers";

const FLOAT01 = { type: "float" as const, min: 0, max: 1, value: 0.5 };
const bus = (bpm = 120, audio?: AudioBusLike): ModulatorBus => ({ bpm: () => bpm, audio });
const make = (spec: unknown, param = FLOAT01, b: ModulatorBus = bus()) =>
  createModulator(ModulatorSpec.parse(spec), param, b);
const run = (fn: ReturnType<typeof make>, n: number, dt = 1 / 60) =>
  frames(n, dt).map((f) => fn(f));

afterEach(() => vi.restoreAllMocks());

describe("spec validation", () => {
  it("rejects unknown keys and unknown types", () => {
    expect(() => ModulatorSpec.parse({ type: "sine", periodSeconds: 1, duty: 0.5 })).toThrow();
    expect(() => ModulatorSpec.parse({ type: "wobble" })).toThrow();
  });
  it("requires exactly one of periodSeconds/periodBeats on clocked types", () => {
    expect(() => make({ type: "sine" })).toThrow(/exactly one/);
    expect(() => make({ type: "sine", periodSeconds: 1, periodBeats: 4 })).toThrow(/exactly one/);
  });
  it("audio takes no period (strict schema rejects it)", () => {
    expect(() => ModulatorSpec.parse({ type: "audio", periodSeconds: 1 })).toThrow();
  });
  it("enforces min <= lo <= hi <= max (FR-6)", () => {
    expect(() => make({ type: "sine", periodSeconds: 1, lo: -0.1 })).toThrow(/min . lo . hi . max/);
    expect(() => make({ type: "sine", periodSeconds: 1, lo: 0.8, hi: 0.4 })).toThrow();
    expect(() => make({ type: "sine", periodSeconds: 1, hi: 1.5 })).toThrow();
  });
  it("restricts bool params to square/random/cycle, without lo/hi", () => {
    const boolParam = { type: "bool" as const, value: false };
    expect(() => make({ type: "sine", periodSeconds: 1 }, boolParam)).toThrow(/bool/);
    expect(() => make({ type: "square", periodSeconds: 1, lo: 0 }, boolParam)).toThrow(/lo\/hi/);
    expect(() => make({ type: "square", periodSeconds: 1 }, boolParam)).not.toThrow();
  });
  it("cycle on float requires an explicit values list, validated against the range", () => {
    expect(() => make({ type: "cycle", periodSeconds: 1 })).toThrow(/values/);
    expect(() => make({ type: "cycle", periodSeconds: 1, values: [0.2, 9] })).toThrow(/outside/);
  });
});

describe("clocked carriers", () => {
  it("sine bounces lo..hi (lo at phase 0, hi at half period)", () => {
    const v = run(make({ type: "sine", periodSeconds: 1, lo: 0.5, hi: 0.9 }), 31) as number[];
    expect(v[0]).toBeCloseTo(0.5, 6);
    expect(v[15]).toBeCloseTo(0.7, 6);
    expect(v[30]).toBeCloseTo(0.9, 6);
  });
  it("triangle is linear", () => {
    const v = run(make({ type: "triangle", periodSeconds: 1 }), 31) as number[];
    expect(v[15]).toBeCloseTo(0.5, 6);
    expect(v[30]).toBeCloseTo(1, 6);
  });
  it("ramp rises (up) or falls (down)", () => {
    const up = run(make({ type: "ramp", periodSeconds: 1 }), 20) as number[];
    expect(up[10]).toBeGreaterThan(up[1]);
    const dn = run(make({ type: "ramp", periodSeconds: 1, direction: "down" }), 20) as number[];
    expect(dn[10]).toBeLessThan(dn[1]);
  });
  it("square alternates hi/lo by duty; bool variant returns booleans", () => {
    const v = run(make({ type: "square", periodSeconds: 1, duty: 0.25 }), 31) as number[];
    expect(v[5]).toBe(1);
    expect(v[20]).toBe(0);
    const b = run(make({ type: "square", periodSeconds: 1, duty: 0.5 }, { type: "bool", value: false }), 40) as boolean[];
    expect(b[5]).toBe(true);
    expect(b[35]).toBe(false);
  });
  it("phase offset shifts the start", () => {
    const fn = make({ type: "sine", periodSeconds: 1, phase: 0.5 });
    expect(fn(F(0))).toBeCloseTo(1, 6);
  });
  it("periodBeats follows live BPM changes (FR-5)", () => {
    let bpm = 120;
    const fn = make({ type: "sine", periodBeats: 1 }, FLOAT01, { bpm: () => bpm });
    const fs = frames(80, 0.01);
    const v: number[] = [];
    for (let i = 0; i <= 50; i++) v.push(fn(fs[i]!) as number); // 0.5 s period
    expect(v[25]).toBeCloseTo(1, 6);
    expect(v[50]).toBeCloseTo(0, 6);
    bpm = 240; // period halves to 0.25 s
    for (let i = 51; i < 80; i++) v.push(fn(fs[i]!) as number);
    expect(v[75]).toBeCloseTo(0, 6); // exactly one extra full cycle in 25 steps
  });
  it("pauses without catch-up: phase advances only when evaluated (FR-10)", () => {
    const fn = make({ type: "sine", periodSeconds: 1 });
    for (const f of frames(30)) fn(f); // 0.5 s in
    // wall clock jumps 500 s; next evaluation advances by one dt only
    expect(fn(F(1000, 500, 1 / 60))).toBeCloseTo(1, 3);
  });
});

describe("interval modulators", () => {
  it("random samples-and-holds per interval", () => {
    const r = vi.spyOn(Math, "random").mockReturnValueOnce(0.25).mockReturnValueOnce(0.75);
    const v = run(make({ type: "random", periodSeconds: 1 }), 61) as number[];
    expect(v[0]).toBeCloseTo(0.25, 6);
    expect(v[59]).toBeCloseTo(0.25, 6);
    expect(v[60]).toBeCloseTo(0.75, 6);
    expect(r).toHaveBeenCalledTimes(2);
  });
  it("random on bool flips a coin per interval", () => {
    vi.spyOn(Math, "random").mockReturnValueOnce(0.2).mockReturnValueOnce(0.8);
    const fn = make({ type: "random", periodSeconds: 1 }, { type: "bool", value: false });
    expect(fn(F(0))).toBe(true);
    const f2 = frames(61)[60]!;
    for (const f of frames(61).slice(1, 60)) fn(f);
    expect(fn(f2)).toBe(false);
  });
  it("drift starts at the current value and chases random targets", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.1);
    const fn = make({ type: "drift", periodSeconds: 1, smooth: 0.001 }, { ...FLOAT01, value: 0.9 });
    const v = run(fn, 10) as number[];
    expect(v[0]).toBeLessThan(0.9); // already moving toward 0.1
    expect(v[9]).toBeCloseTo(0.1, 2);
  });
  it("cycle steps int ranges in every order", () => {
    const intP = { type: "int" as const, min: 0, max: 10, value: 0 };
    const seq = (spec: object) => run(make({ ...spec, periodSeconds: 1, lo: 0, hi: 3 }, intP), 10, 0.5) as number[];
    expect(seq({ type: "cycle" })).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 0, 0]);
    expect(seq({ type: "cycle", order: "reverse" })).toEqual([3, 3, 2, 2, 1, 1, 0, 0, 3, 3]);
    expect(seq({ type: "cycle", order: "pingpong" })).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 2, 2]);
  });
  it("cycle uses explicit values for floats (and ints when given)", () => {
    const v = run(make({ type: "cycle", periodSeconds: 1, values: [0.1, 0.5, 0.9] }), 8, 0.5) as number[];
    expect(v).toEqual([0.1, 0.1, 0.5, 0.5, 0.9, 0.9, 0.1, 0.1]);
    const intP = { type: "int" as const, min: 0, max: 64, value: 4 };
    const s = run(make({ type: "cycle", periodSeconds: 1, values: [4, 8, 16, 32] }, intP), 8, 1) as number[];
    expect(s).toEqual([4, 8, 16, 32, 4, 8, 16, 32]);
  });
  it("cycle toggles bools", () => {
    const b = run(make({ type: "cycle", periodSeconds: 1 }, { type: "bool", value: false }), 4, 1) as boolean[];
    expect(b).toEqual([false, true, false, true]);
  });
});

describe("audio follower", () => {
  const fakeAudio: AudioBusLike = {
    rms: new Signal(() => 0.5),
    band: (name) => new Signal(() => (name === "bass" ? 0.25 : 0)),
    onset: () => new Events(() => []),
  };
  it("maps a band into lo..hi (smooth 0 = passthrough)", () => {
    const fn = make({ type: "audio", band: "bass", smooth: 0 }, FLOAT01, bus(120, fakeAudio));
    expect(fn(F(0))).toBeCloseTo(0.25, 6);
    const rms = make({ type: "audio", smooth: 0, lo: 0.2, hi: 0.6 }, FLOAT01, bus(120, fakeAudio));
    expect(rms(F(1))).toBeCloseTo(0.4, 6);
  });
  it("requires an audio bus", () => {
    expect(() => make({ type: "audio" }, FLOAT01, bus(120))).toThrow(/audio bus/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @loom/runtime exec vitest run test/modulator.test.ts`
Expected: FAIL — cannot resolve `../src/modulator`.

- [ ] **Step 3: Implement `packages/runtime/src/modulator.ts`**

```ts
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
  z.strictObject({ type: z.literal("drift"), smooth: z.number().positive().optional(), ...Rate, ...Range }),
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
  min?: number;
  max?: number;
  /** Current value — drift starts here so attaching never jumps. */
  value?: number | boolean;
}

/** World hooks: live BPM for beat-synced rates, audio for the follower. */
export interface ModulatorBus {
  bpm(): number;
  audio?: AudioBusLike;
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
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --filter @loom/runtime exec vitest run test/modulator.test.ts`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/modulator.ts packages/runtime/test/modulator.test.ts
git commit -m "feat(runtime): modulator kernel — spec schema + 8 evaluator types"
```

---

### Task 2: Runtime `ModulatorHost` (per-instance state, containment, reattach)

**Files:**
- Create: `packages/runtime/src/modulator-host.ts`
- Modify: `packages/runtime/src/index.ts`
- Test: `packages/runtime/test/modulator-host.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// packages/runtime/test/modulator-host.test.ts
import { describe, expect, it } from "vitest";
import { ModulatorHost, type ManifestLike } from "../src/modulator-host";
import { Manifest } from "../src/param";
import { F } from "./helpers";

const bus = { bpm: () => 120 };
const manifest = () => {
  const m = new Manifest();
  m.float("trail", { default: 0.8, min: 0.5, max: 0.97 });
  m.bool("flash", { default: false });
  return m;
};

describe("ModulatorHost", () => {
  it("attaches, replaces, clears, reports", () => {
    const host = new ModulatorHost(bus);
    const m = manifest();
    const spec = host.attach(m, "trail", { type: "square", periodSeconds: 1 });
    expect(spec.type).toBe("square");
    expect(host.active("trail")).toBe(true);
    host.attach(m, "trail", { type: "sine", periodSeconds: 2 }); // replace (FR-1)
    expect(host.get("trail")?.spec.type).toBe("sine");
    expect(host.list()).toHaveLength(1);
    expect(host.clear("trail")).toBe(true);
    expect(host.clear("trail")).toBe(false); // no-op success
    expect(host.active("trail")).toBe(false);
  });

  it("rejects unknown params and bad specs with clear errors", () => {
    const host = new ModulatorHost(bus);
    expect(() => host.attach(manifest(), "nope", { type: "sine", periodSeconds: 1 })).toThrow(/unknown param/);
    expect(() => host.attach(manifest(), "flash", { type: "sine", periodSeconds: 1 })).toThrow(/bool/);
  });

  it("tick writes through the manifest (clamped set path, FR-2)", () => {
    const host = new ModulatorHost(bus);
    const m = manifest();
    host.attach(m, "trail", { type: "sine", periodSeconds: 1 });
    host.tick(m, F(0));
    expect(m.get("trail")!.value).toBeCloseTo(0.5, 6); // sine starts at lo = min
  });

  it("contains evaluation throws: detaches, flags, never propagates (FR-9)", () => {
    const host = new ModulatorHost(bus);
    let calls = 0;
    const booby: ManifestLike = {
      get: () => ({
        set: () => {
          calls++;
          throw new Error("boom");
        },
        toJSON: () => ({ type: "float", min: 0, max: 1, value: 0 }),
      }),
    };
    host.attach(booby, "trail", { type: "sine", periodSeconds: 1 });
    expect(() => host.tick(booby, F(0))).not.toThrow();
    expect(host.get("trail")?.error).toContain("boom");
    expect(host.active("trail")).toBe(false);
    host.tick(booby, F(1)); // errored slot is skipped
    expect(calls).toBe(1);
  });

  it("reattach survives rebuilds, orphans vanished params, recovers fixed ones (FR-4)", () => {
    const host = new ModulatorHost(bus);
    const m1 = manifest();
    host.attach(m1, "trail", { type: "sine", periodSeconds: 1 });
    const gone = new Manifest(); // rebuild renamed the param away
    host.reattach(gone);
    expect(host.get("trail")?.error).toMatch(/vanished/);
    host.reattach(manifest()); // param came back — recovers
    expect(host.active("trail")).toBe(true);
    const narrowed = new Manifest(); // rebuild narrowed the range under the spec
    narrowed.float("trail", { default: 0.8, min: 0.7, max: 0.97 });
    host.attach(manifest(), "trail", { type: "sine", periodSeconds: 1, lo: 0.5 });
    host.reattach(narrowed);
    expect(host.get("trail")?.error).toMatch(/min . lo/);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @loom/runtime exec vitest run test/modulator-host.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `packages/runtime/src/modulator-host.ts`**

```ts
import type { FrameCtx } from "./frame";
import {
  createModulator,
  ModulatorSpec,
  type ModulatorBus,
  type ModulatorEval,
  type ModulatorParamMeta,
} from "./modulator";
import type { ParamType } from "./param";

/** The slice of Param/Manifest a host needs (lets tests inject fakes). */
export interface ParamLike {
  set(v: unknown): void;
  toJSON(): Record<string, unknown>;
}
export interface ManifestLike {
  get(path: string): ParamLike | undefined;
}

export interface ModulatorInfo {
  path: string;
  spec: ModulatorSpec;
  /** Non-null = detached: evaluation threw, or the param vanished on rebuild. */
  error: string | null;
}

interface Slot {
  spec: ModulatorSpec;
  evaluate: ModulatorEval;
  error: string | null;
}

/**
 * Per-instance modulator registry: attach/replace/clear, the per-frame
 * write pass, and HMR re-attachment. Lives in the engine's SessionStore
 * entry (per instance, not per scene — FR-3); the engine only schedules.
 */
export class ModulatorHost {
  private readonly slots = new Map<string, Slot>();

  constructor(private readonly bus: ModulatorBus) {}

  /** Attach or replace (one modulator per param, FR-1). Throws on a bad spec. */
  attach(manifest: ManifestLike, path: string, raw: unknown): ModulatorSpec {
    const param = manifest.get(path);
    if (!param) throw new Error(`unknown param "${path}"`);
    const spec = ModulatorSpec.parse(raw);
    const evaluate = createModulator(spec, paramMeta(param), this.bus);
    this.slots.set(path, { spec, evaluate, error: null });
    return spec;
  }

  /** Detach. False when there was nothing to clear (callers treat as no-op success). */
  clear(path: string): boolean {
    return this.slots.delete(path);
  }

  get(path: string): ModulatorInfo | undefined {
    const s = this.slots.get(path);
    return s && { path, spec: s.spec, error: s.error };
  }

  /** True when the param is owned by a live (non-errored) modulator (FR-7). */
  active(path: string): boolean {
    const s = this.slots.get(path);
    return s != null && s.error == null;
  }

  list(): ModulatorInfo[] {
    return [...this.slots.entries()].map(([path, s]) => ({ path, spec: s.spec, error: s.error }));
  }

  /**
   * FR-9: evaluate every active modulator and write through the manifest.
   * A throw detaches that modulator (error recorded, param holds its last
   * value) and never reaches the render loop.
   */
  tick(manifest: ManifestLike, f: FrameCtx): void {
    for (const [path, s] of this.slots) {
      if (s.error != null) continue;
      try {
        const param = manifest.get(path);
        if (!param) throw new Error(`param "${path}" disappeared`);
        param.set(s.evaluate(f));
      } catch (err) {
        s.error = err instanceof Error ? err.message : String(err);
      }
    }
  }

  /**
   * FR-4: after an instance rebuild, re-attach each stored spec to the new
   * manifest (fresh evaluator; phase restarts). Orphans stay listed with
   * error set so get_session can report them; a later rebuild that brings
   * the param back recovers them.
   */
  reattach(manifest: ManifestLike): void {
    for (const [path, s] of this.slots) {
      const param = manifest.get(path);
      if (!param) {
        s.error = `param "${path}" vanished in rebuild`;
        continue;
      }
      try {
        s.evaluate = createModulator(s.spec, paramMeta(param), this.bus);
        s.error = null;
      } catch (err) {
        s.error = err instanceof Error ? err.message : String(err);
      }
    }
  }
}

function paramMeta(param: ParamLike): ModulatorParamMeta {
  const j = param.toJSON() as { type: ParamType; min?: number; max?: number; value?: number | boolean };
  return { type: j.type, min: j.min, max: j.max, value: j.value };
}
```

- [ ] **Step 4: Export from `packages/runtime/src/index.ts`** (append):

```ts
export {
  createModulator,
  ModulatorSpec,
  type ModulatorBus,
  type ModulatorEval,
  type ModulatorParamMeta,
  type ModulatorType,
} from "./modulator";
export { ModulatorHost, type ManifestLike, type ModulatorInfo, type ParamLike } from "./modulator-host";
```

- [ ] **Step 5: Run** `pnpm --filter @loom/runtime exec vitest run` → all runtime tests PASS; `pnpm typecheck` → green.

- [ ] **Step 6: Commit** — `git commit -m "feat(runtime): ModulatorHost — per-instance attach/tick/reattach with FR-9 containment"`

---

### Task 3: Protocol + sidecar MCP tools

**Files:**
- Modify: `packages/sidecar/src/protocol.ts`
- Modify: `packages/sidecar/src/index.ts`
- Test: `packages/sidecar/test/protocol.test.ts` (append)

- [ ] **Step 1: Failing tests** (append to `protocol.test.ts`):

```ts
import { ClearModulationArgs, ModulateParamArgs, RequestType } from "../src/protocol";

describe("modulator args", () => {
  it("modulate_param/clear_modulation are request types", () => {
    expect(RequestType.options).toContain("modulate_param");
    expect(RequestType.options).toContain("clear_modulation");
  });
  it("ModulateParamArgs defaults instance to live and passes the spec through", () => {
    const a = ModulateParamArgs.parse({ path: "trail", modulator: { type: "sine", periodSeconds: 2 } });
    expect(a.instance).toBe("live");
    expect(a.modulator.type).toBe("sine");
    expect(() => ModulateParamArgs.parse({ path: "trail" })).toThrow();
  });
  it("ClearModulationArgs requires a path", () => {
    expect(ClearModulationArgs.parse({ path: "trail" }).instance).toBe("live");
    expect(() => ClearModulationArgs.parse({})).toThrow();
  });
});
```

(match the file's existing import style for `describe/expect/it`.)

- [ ] **Step 2: Run** `pnpm --filter @loom/sidecar exec vitest run test/protocol.test.ts` → FAIL.

- [ ] **Step 3: Implement protocol additions.** In `RequestType`, after `"set_param"`, add `"modulate_param", "clear_modulation"`. After `SetParamArgs` add:

```ts
export const ModulateParamArgs = z.object({
  instance: z.string().default("live"),
  path: z.string().min(1),
  /** Spec JSON — validated engine-side against @loom/runtime's ModulatorSpec (FR-11). */
  modulator: z.record(z.string(), z.unknown()),
});
export type ModulateParamArgs = z.infer<typeof ModulateParamArgs>;

export const ClearModulationArgs = z.object({
  instance: z.string().default("live"),
  path: z.string().min(1),
});
export type ClearModulationArgs = z.infer<typeof ClearModulationArgs>;
```

In results: add before `InstanceInfo`:

```ts
export const ModulatorSummary = z.object({
  path: z.string(),
  type: z.string(),
  /** Non-null = detached: eval threw or the param vanished on rebuild. */
  error: z.string().nullable(),
});
export type ModulatorSummary = z.infer<typeof ModulatorSummary>;
```

`InstanceInfo` gains `modulators: z.array(ModulatorSummary),`. `ParamDescriptor` gains `modulator: z.record(z.string(), z.unknown()).nullable().optional(),`. After `SetParamResult` add:

```ts
export const ModulateParamResult = z.object({
  instance: z.string(),
  path: z.string(),
  modulator: z.record(z.string(), z.unknown()),
});
export type ModulateParamResult = z.infer<typeof ModulateParamResult>;

export const ClearModulationResult = z.object({
  instance: z.string(),
  path: z.string(),
  cleared: z.boolean(),
});
export type ClearModulationResult = z.infer<typeof ClearModulationResult>;
```

- [ ] **Step 4: Add the two MCP tools in `packages/sidecar/src/index.ts`.** Import `ClearModulationArgs, ModulateParamArgs` from `./protocol`. Append to `TOOLS` after `set_param`:

```ts
  {
    name: "modulate_param",
    description:
      "Attach (or replace) a modulator on a param: the engine animates it every frame between " +
      "lo..hi (defaults to the param's declared range; can never escape it). Same trust tier as " +
      "set_param — no arming needed, allowed on live. While modulated, set_param on that path " +
      "errors; clear_modulation takes back manual control. Clocked types need exactly one of " +
      "periodSeconds | periodBeats (beats track BPM live; phase 0..1 staggers).",
    inputSchema: {
      type: "object",
      properties: {
        ...INSTANCE_PROP,
        path: { type: "string", description: "Param path as listed in the manifest." },
        modulator: {
          type: "object",
          description:
            "sine|triangle: smooth lo↔hi bounce. ramp: saw (direction up|down). square: lo/hi " +
            "alternation (duty 0..1; works on bools). random: new value per interval (bools: coin " +
            "flip). drift: smoothed random walk (smooth seconds). cycle: step through values per " +
            "interval (order forward|reverse|pingpong|random; floats need values[]; ints default " +
            "to lo..hi steps; bools toggle). audio: follow a band (band bass|mid|treble|rms, " +
            "smooth seconds; takes no period).",
          properties: {
            type: {
              type: "string",
              enum: ["sine", "triangle", "ramp", "square", "random", "drift", "cycle", "audio"],
            },
            periodSeconds: { type: "number", description: "Cycle/interval length in seconds." },
            periodBeats: { type: "number", description: "Cycle/interval length in beats (tracks BPM)." },
            phase: { type: "number", description: "0..1 start offset." },
            lo: { type: "number", description: "Range low; defaults to the param's min." },
            hi: { type: "number", description: "Range high; defaults to the param's max." },
            direction: { type: "string", enum: ["up", "down"], description: "ramp only." },
            duty: { type: "number", description: "square only: fraction of the period at hi." },
            smooth: { type: "number", description: "drift/audio smoothing, seconds." },
            order: {
              type: "string",
              enum: ["forward", "reverse", "pingpong", "random"],
              description: "cycle only.",
            },
            values: { type: "array", items: { type: "number" }, description: "cycle: explicit step list." },
            band: { type: "string", enum: ["bass", "mid", "treble", "rms"], description: "audio only." },
          },
          required: ["type"],
        },
      },
      required: ["path", "modulator"],
    },
  },
  {
    name: "clear_modulation",
    description:
      "Detach the modulator from a param (no-op success if none). The param holds its last value.",
    inputSchema: {
      type: "object",
      properties: {
        ...INSTANCE_PROP,
        path: { type: "string", description: "Param path to release." },
      },
      required: ["path"],
    },
  },
```

And in the `CallToolRequestSchema` switch, after the `set_param` case:

```ts
      case "modulate_param": {
        const result = await broker.request("modulate_param", { ...ModulateParamArgs.parse(args) });
        return textResult(result);
      }
      case "clear_modulation": {
        const result = await broker.request("clear_modulation", { ...ClearModulationArgs.parse(args) });
        return textResult(result);
      }
```

- [ ] **Step 5: Run** `pnpm --filter @loom/sidecar exec vitest run` → PASS; `pnpm typecheck` → green.
- [ ] **Step 6: Commit** — `git commit -m "feat(sidecar): modulate_param + clear_modulation tools and wire contract"`

---

### Task 4: Engine — storage, per-frame tick, dispatch, payloads

**Files:**
- Modify: `packages/engine-app/src/session.ts`
- Modify: `packages/engine-app/src/engine-api.ts`
- Modify: `packages/engine-app/src/main.ts`
- Modify: `scripts/validate-m4.mjs` (expected MCP tool list)

(No unit tests — engine-app has none; covered by the Task 6 validator + typecheck.)

- [ ] **Step 1: `session.ts`.** Import `ModulatorHost` and `FrameCtx` from `@loom/runtime`. `Entry` gains `readonly modulators: ModulatorHost;`. In `create()` add to the entry literal:

```ts
      modulators: new ModulatorHost({ bpm: () => this.buses.time.bpm, audio: this.buses.audio }),
```

In `rebuild()` success path (after `e.lastUpdateRejected = false;`): `e.modulators.reattach(e.instance.manifest);` (FR-4). Add method:

```ts
  /** Per-frame modulator write pass; the engine skips it while held (FR-10). */
  tickModulators(f: FrameCtx): void {
    for (const e of this.entries.values()) e.modulators.tick(e.instance.manifest, f);
  }
```

- [ ] **Step 2: `main.ts`.** In the render loop, after `lastDirectiveHold = ...` and before `compositor.render(...)`:

```ts
  // Modulators write CPU-side before any leg renders; PANIC holds them too (FR-10).
  if (directive.mode !== "hold") session.tickModulators(f);
```

Extend the `__loom` instances type + assignment with `modulators: Array<{ path: string; type: string; error: string | null }>`, mapped via `e.modulators.list().map((m) => ({ path: m.path, type: m.spec.type, error: m.error }))`.

- [ ] **Step 3: `engine-api.ts`.** Import `ClearModulationArgs, ModulateParamArgs` from the protocol. Add cases after `set_param`:

```ts
      case "modulate_param": {
        const { instance, path, modulator } = ModulateParamArgs.parse(req.args);
        const e = session.require(this.resolveId(instance));
        if (!e.instance.manifest.get(path)) {
          const have = e.instance.manifest.paths().join(", ") || "(none)";
          throw new Error(`unknown param "${path}" on "${e.id}" — manifest has: ${have}`);
        }
        const spec = e.modulators.attach(e.instance.manifest, path, modulator);
        return { instance: e.id, path, modulator: spec };
      }
      case "clear_modulation": {
        const { instance, path } = ClearModulationArgs.parse(req.args);
        const e = session.require(this.resolveId(instance));
        return { instance: e.id, path, cleared: e.modulators.clear(path) };
      }
```

In the `set_param` case, after the unknown-param check and before `param.set(value)` (FR-7):

```ts
        const mod = e.modulators.get(path);
        if (mod != null && mod.error == null) {
          throw new Error(
            `"${path}" on "${e.id}" is modulated (${mod.spec.type}) — call clear_modulation ` +
              "(or hit ∿ Detach in the Console) to take manual control",
          );
        }
```

Add a private helper and use it in both `get_manifest` and `consoleState()` (FR-8):

```ts
  /** Manifest JSON with each param's active modulator config (or null) — FR-8. */
  private manifestJson(e: Entry): Record<string, unknown> {
    const params = e.instance.manifest.toJSON() as Record<string, Record<string, unknown>>;
    for (const path of Object.keys(params)) {
      const m = e.modulators.get(path);
      params[path]!.modulator = m != null && m.error == null ? m.spec : null;
    }
    return params;
  }
```

`get_manifest` returns `{ instance: e.id, params: this.manifestJson(e) }`; `consoleState()` uses `manifests[e.id] = this.manifestJson(e);`. In `snapshot()`'s instances map add:

```ts
        modulators: e.modulators.list().map((m) => ({ path: m.path, type: m.spec.type, error: m.error })),
```

- [ ] **Step 4: `scripts/validate-m4.mjs`** — expected tool list becomes (sorted):

```js
      JSON.stringify([
        "clear_modulation", "commit", "create_instance", "destroy_instance", "get_manifest",
        "get_session", "modulate_param", "screenshot", "set_param", "stage",
      ]),
```

(check name/intent — *no set_audio for agents* — unchanged.)

- [ ] **Step 5: Run** `pnpm typecheck` → green. **Commit** — `git commit -m "feat(engine): modulator storage + per-frame tick + dispatch (FR-2/3/4/7/8/9/10)"`

---

### Task 5: Console UI (∿ button, popover, live read-only thumb)

**Files:**
- Modify: `packages/engine-app/src/console.ts`
- Modify: `packages/engine-app/console.html` (CSS only)

- [ ] **Step 1: `console.ts`.** `ParamDesc` gains `modulator?: Record<string, unknown> | null;`. Add the descriptor table (NFR-3) near the top:

```ts
type ModField =
  | { key: string; label: string; kind: "number"; step: number; min?: number; max?: number }
  | { key: string; label: string; kind: "select"; options: string[] }
  | { key: string; label: string; kind: "values" };

const MOD_TYPES: Array<{ type: string; bool: boolean; clocked: boolean; fields: ModField[] }> = [
  { type: "sine", bool: false, clocked: true, fields: [] },
  { type: "triangle", bool: false, clocked: true, fields: [] },
  { type: "ramp", bool: false, clocked: true, fields: [{ key: "direction", label: "direction", kind: "select", options: ["up", "down"] }] },
  { type: "square", bool: true, clocked: true, fields: [{ key: "duty", label: "duty", kind: "number", step: 0.05, min: 0, max: 1 }] },
  { type: "random", bool: true, clocked: true, fields: [] },
  { type: "drift", bool: false, clocked: true, fields: [{ key: "smooth", label: "smooth s", kind: "number", step: 0.1, min: 0 }] },
  {
    type: "cycle", bool: true, clocked: true,
    fields: [
      { key: "order", label: "order", kind: "select", options: ["forward", "reverse", "pingpong", "random"] },
      { key: "values", label: "values", kind: "values" },
    ],
  },
  {
    type: "audio", bool: false, clocked: false,
    fields: [
      { key: "band", label: "band", kind: "select", options: ["rms", "bass", "mid", "treble"] },
      { key: "smooth", label: "smooth s", kind: "number", step: 0.01, min: 0 },
    ],
  },
];
```

In `makeWidget`, give the label a ∿ button (before the value span):

```ts
  label.innerHTML =
    `<span>${path}</span><button class="modbtn" data-modbtn="${path}" title="attach a modulator">∿</button>` +
    `<span class="pvalue" data-value="${path}">${formatValue(p)}</span>`;
```

Append a hidden popover per widget after the input (full function below), and wire the button:

```ts
  const pop = makeModPopover(path, p);
  div.appendChild(pop);
  label.querySelector(".modbtn")!.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = !pop.classList.contains("open");
    widgetsEl.querySelectorAll(".modpop.open").forEach((el) => el.classList.remove("open"));
    if (open) {
      fillModPopover(pop, path, currentDesc(path) ?? p);
      pop.classList.add("open");
    }
  });
```

with helpers:

```ts
function currentDesc(path: string): ParamDesc | undefined {
  return selected != null ? state?.manifests[selected]?.[path] : undefined;
}

function makeModPopover(path: string, p: ParamDesc): HTMLElement {
  const pop = document.createElement("div");
  pop.className = "modpop";
  const isBool = p.type === "bool";
  const types = MOD_TYPES.filter((d) => !isBool || d.bool);
  pop.innerHTML = `
    <div class="modrow"><span>type</span><select class="modtype">${types
      .map((d) => `<option value="${d.type}">${d.type}</option>`)
      .join("")}</select></div>
    <div class="modrow modrate-row"><span>every</span>
      <input class="modrate" type="number" min="0.05" step="0.25" value="4">
      <select class="modunit"><option value="beats">beats</option><option value="seconds">seconds</option></select>
      <span>phase</span><input class="modphase" type="number" min="0" max="1" step="0.05" value="0">
    </div>
    ${isBool ? "" : `<div class="modrow modrange-row"><span>range</span>
      <div class="dualrange"><input type="range" class="dlo"><input type="range" class="dhi"></div>
      <span class="dvals"></span></div>`}
    <div class="modfields"></div>
    <div class="moderr"></div>
    <div class="modrow modactions">
      <button class="modattach">attach</button>
      <button class="modretrig" title="restart the wave at lo">⟲ retrigger</button>
      <button class="moddetach">detach</button>
    </div>`;

  if (!isBool) {
    const min = p.min ?? 0;
    const max = p.max ?? 1;
    const step = p.type === "int" ? 1 : (max - min) / 200;
    for (const cls of ["dlo", "dhi"] as const) {
      const r = pop.querySelector<HTMLInputElement>(`.${cls}`)!;
      r.min = String(min);
      r.max = String(max);
      r.step = String(step);
      r.value = cls === "dlo" ? String(min) : String(max);
    }
    const dlo = pop.querySelector<HTMLInputElement>(".dlo")!;
    const dhi = pop.querySelector<HTMLInputElement>(".dhi")!;
    const sync = () => {
      if (Number(dlo.value) > Number(dhi.value)) {
        // the dragged thumb pushes the other
        if (document.activeElement === dlo) dhi.value = dlo.value;
        else dlo.value = dhi.value;
      }
      pop.querySelector(".dvals")!.textContent = `${Number(dlo.value).toFixed(2)}–${Number(dhi.value).toFixed(2)}`;
    };
    dlo.addEventListener("input", sync);
    dhi.addEventListener("input", sync);
    sync();
  }

  const typeSel = pop.querySelector<HTMLSelectElement>(".modtype")!;
  const renderFields = () => {
    const desc = MOD_TYPES.find((d) => d.type === typeSel.value)!;
    pop.querySelector<HTMLElement>(".modrate-row")!.style.display = desc.clocked ? "" : "none";
    pop.querySelector(".modfields")!.replaceChildren(
      ...desc.fields.map((fd) => {
        const row = document.createElement("div");
        row.className = "modrow";
        if (fd.kind === "select") {
          row.innerHTML = `<span>${fd.label}</span><select data-mf="${fd.key}">${fd.options
            .map((o) => `<option>${o}</option>`)
            .join("")}</select>`;
        } else if (fd.kind === "values") {
          row.innerHTML = `<span>${fd.label}</span><input data-mf="${fd.key}" type="text" placeholder="0.2, 0.5, 0.8">`;
        } else {
          row.innerHTML = `<span>${fd.label}</span><input data-mf="${fd.key}" type="number" step="${fd.step}"${
            fd.min !== undefined ? ` min="${fd.min}"` : ""}${fd.max !== undefined ? ` max="${fd.max}"` : ""}>`;
        }
        return row;
      }),
    );
  };
  typeSel.addEventListener("change", renderFields);
  renderFields();

  const send = (spec: Record<string, unknown>) => {
    if (!selected) return;
    pop.querySelector(".moderr")!.textContent = "";
    void req("modulate_param", { instance: selected, path, modulator: spec }).catch((err) => {
      pop.querySelector(".moderr")!.textContent = String(err.message ?? err);
    });
  };
  pop.querySelector(".modattach")!.addEventListener("click", () => send(buildModSpec(pop, p)));
  pop.querySelector(".modretrig")!.addEventListener("click", () => {
    const active = currentDesc(path)?.modulator;
    send((active as Record<string, unknown>) ?? buildModSpec(pop, p));
  });
  pop.querySelector(".moddetach")!.addEventListener("click", () => {
    if (!selected) return;
    void req("clear_modulation", { instance: selected, path }).catch(fail);
    pop.classList.remove("open");
  });
  return pop;
}

function buildModSpec(pop: HTMLElement, p: ParamDesc): Record<string, unknown> {
  const type = pop.querySelector<HTMLSelectElement>(".modtype")!.value;
  const desc = MOD_TYPES.find((d) => d.type === type)!;
  const spec: Record<string, unknown> = { type };
  if (desc.clocked) {
    const rate = Number(pop.querySelector<HTMLInputElement>(".modrate")!.value) || 4;
    spec[pop.querySelector<HTMLSelectElement>(".modunit")!.value === "beats" ? "periodBeats" : "periodSeconds"] = rate;
    const phase = Number(pop.querySelector<HTMLInputElement>(".modphase")!.value);
    if (phase > 0) spec.phase = Math.min(phase, 1);
  }
  if (p.type !== "bool") {
    spec.lo = Number(pop.querySelector<HTMLInputElement>(".dlo")!.value);
    spec.hi = Number(pop.querySelector<HTMLInputElement>(".dhi")!.value);
  }
  for (const fd of desc.fields) {
    const el = pop.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-mf="${fd.key}"]`);
    if (!el || el.value === "") continue;
    if (fd.kind === "values") {
      const nums = el.value.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
      if (nums.length > 0) spec[fd.key] = nums;
    } else if (fd.kind === "number") spec[fd.key] = Number(el.value);
    else spec[fd.key] = el.value;
  }
  return spec;
}

function fillModPopover(pop: HTMLElement, _path: string, p: ParamDesc): void {
  const mod = (p.modulator ?? null) as Record<string, unknown> | null;
  pop.querySelector(".moderr")!.textContent = "";
  pop.querySelector<HTMLButtonElement>(".modretrig")!.style.display = mod ? "" : "none";
  pop.querySelector<HTMLButtonElement>(".moddetach")!.style.display = mod ? "" : "none";
  pop.querySelector<HTMLButtonElement>(".modattach")!.textContent = mod ? "update" : "attach";
  if (!mod) return;
  const typeSel = pop.querySelector<HTMLSelectElement>(".modtype")!;
  typeSel.value = String(mod.type);
  typeSel.dispatchEvent(new Event("change"));
  if (mod.periodBeats != null || mod.periodSeconds != null) {
    pop.querySelector<HTMLInputElement>(".modrate")!.value = String(mod.periodBeats ?? mod.periodSeconds);
    pop.querySelector<HTMLSelectElement>(".modunit")!.value = mod.periodBeats != null ? "beats" : "seconds";
  }
  if (typeof mod.phase === "number") pop.querySelector<HTMLInputElement>(".modphase")!.value = String(mod.phase);
  const dlo = pop.querySelector<HTMLInputElement>(".dlo");
  const dhi = pop.querySelector<HTMLInputElement>(".dhi");
  if (dlo && mod.lo != null) { dlo.value = String(mod.lo); dlo.dispatchEvent(new Event("input")); }
  if (dhi && mod.hi != null) { dhi.value = String(mod.hi); dhi.dispatchEvent(new Event("input")); }
  for (const el of pop.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-mf]")) {
    const v = mod[el.dataset.mf!];
    if (v == null) continue;
    el.value = Array.isArray(v) ? v.join(", ") : String(v);
  }
}
```

In `renderPanel`'s refresh loop (after the `valueEl` update), reflect modulation state (FR-8 indicator + read-only animated thumb):

```ts
    const active = p.modulator != null;
    const widget = input.closest(".widget");
    widget?.classList.toggle("modulated", active);
    input.disabled = active; // engine rejects writes anyway (FR-7); this kills the drag
    input.title = active ? "modulated — detach to take over" : "";
    const modBtn = widgetsEl.querySelector<HTMLButtonElement>(`[data-modbtn="${cssEscape(path)}"]`);
    if (modBtn) {
      modBtn.classList.toggle("on", active);
      modBtn.title = active
        ? `modulated: ${(p.modulator as { type?: string }).type}`
        : "attach a modulator";
    }
```

- [ ] **Step 2: `console.html`** — append to the `<style>` block (match existing palette/var usage):

```css
.modbtn { background: none; border: none; color: #5a647a; cursor: pointer; font-size: 14px; padding: 0 4px; }
.modbtn.on { color: #8ab4ff; text-shadow: 0 0 6px #8ab4ff66; }
.widget.modulated input[type="range"] { accent-color: #8ab4ff; opacity: 1; }
.modpop { display: none; margin-top: 6px; padding: 8px; border: 1px solid #2a3142; border-radius: 6px; background: #11141c; }
.modpop.open { display: block; }
.modrow { display: flex; align-items: center; gap: 6px; margin: 4px 0; font-size: 11px; color: #8a93a8; }
.modrow input[type="number"] { width: 56px; }
.modrow input[type="text"] { flex: 1; }
.moderr { color: #ff7878; font-size: 11px; min-height: 0; }
.modactions button { font-size: 11px; }
.dualrange { position: relative; flex: 1; height: 18px; }
.dualrange input[type="range"] {
  position: absolute; inset: 0; width: 100%; margin: 0; background: none;
  pointer-events: none; -webkit-appearance: none; appearance: none;
}
.dualrange input[type="range"]::-webkit-slider-runnable-track { height: 3px; background: #2a3142; border-radius: 2px; }
.dualrange input[type="range"]::-webkit-slider-thumb {
  pointer-events: auto; -webkit-appearance: none; appearance: none; width: 11px; height: 11px;
  border-radius: 50%; background: #8ab4ff; margin-top: -4px; cursor: ew-resize;
}
.dualrange input[type="range"]::-moz-range-track { height: 3px; background: #2a3142; }
.dualrange input[type="range"]::-moz-range-thumb {
  pointer-events: auto; width: 11px; height: 11px; border: none; border-radius: 50%;
  background: #8ab4ff; cursor: ew-resize;
}
.dvals { min-width: 70px; text-align: right; }
```

- [ ] **Step 3: Run** `pnpm typecheck` → green. Manual smoke via `pnpm dev` if convenient. **Commit** — `git commit -m "feat(console): ∿ modulator popover, live read-only thumbs, dual-range"`

---

### Task 6: Acceptance script `validate:modulators`

**Files:**
- Create: `scripts/validate-modulators.mjs` (modeled on `validate-m4.mjs` scaffolding: pulse pin, vite spawn w/ early-exit guard, MCP client, finally-cleanup)
- Modify: `package.json` (add `"validate:modulators": "node scripts/validate-modulators.mjs"`)

Ports: `PORT = 5202`, `WS_PORT = 7345`. Reuse m4's helpers (`check/waitFor/waitForFps/pageLum/toolJson/callOk/loomState`). Scratch scene for the HMR checks:

```js
const SCRATCH = join(ROOT, "content", "scenes", "modtest.scene.ts");
const scratchSrc = (paths) => `import { defineScene, texNode } from "@loom/runtime";
import { vec4 } from "three/tsl";

export default defineScene({
  name: "modtest",
  description: "modulator validation scratch scene",
  build(ctx) {
${paths.map((p) => `    ctx.float(${JSON.stringify(p)}, { default: 0.5, min: 0, max: 1 });`).join("\n")}
    return texNode(vec4(0.3, 0.2, 0.6, 1));
  },
});
`;
```

Checks (each a `check(...)`):
1. **Tool surface**: `listTools` = the 10 names (incl. `modulate_param`, `clear_modulation`, still no `set_audio`).
2. **Sine animates a param within range**: `modulate_param {path:"trail", modulator:{type:"sine",periodSeconds:2}}` on boot (pulse) → sample `get_manifest` trail 8×/150 ms: ≥3 distinct values, all within `[0.5, 0.97]`, ≥1 direction change. `get_session` boot instance reports `modulators: [{path:"trail", type:"sine", error:null}]`.
3. **Pixels respond**: replace with `{type:"square", periodSeconds:4, lo:0.5, hi:0.97}`; `pageLum` ~1.6 s into the hi half vs ~1.6 s into the lo half → `lumHi > lumLo` (save both PNGs to artifacts as `mod-hi.png`/`mod-lo.png`).
4. **FR-7**: `set_param trail` → `isError` true, message contains "modulated"; `clear_modulation` → `{cleared:true}`; `set_param` then succeeds; second `clear_modulation` → `{cleared:false}` (no-op success).
5. **FR-4 survive + orphan**: write scratch scene with params `a`,`b`; wait for `modtest` in `availableScenes`; `create_instance modtest`; attach sine(2 s) to both; rewrite scratch without `b`; wait until the instance's `paramPaths` lacks `b`; `get_session` → modulator on `a` has `error:null` (and its value still changes), `b` has `error` matching `/vanished/`; `window.__loom.frame` still advancing (loop alive).
6. **FR-10 PANIC/RESUME**: attach sine(8 s) to boot trail; `panic` via output-page BroadcastChannel post (`{kind:"req",type:"panic",args:{}}`, human source); wait `__loom.panicked`; sample trail twice 600 ms apart → identical (frozen); `resume`; 250 ms later → `|v − frozen| < 0.1·span` (no jump); 1 s later → value moved (continues).
7. **FR-5 BPM retune**: attach sine `periodBeats:2` to modtest `a`; count direction changes over 1.5 s @100 ms; `set_transport {bpm: 240}` via channel post; recount → strictly more changes.

`finally`: restore `live.scene.ts`, `rmSync(SCRATCH, {force:true})`, close client/browser, kill vite (taskkill on win32).

- [ ] Write the script; run `pnpm validate:modulators` → all checks PASS (artifacts under `artifacts/`).
- [ ] Commit — `git commit -m "test: validate:modulators acceptance script"`

---

### Task 7: Docs + full gates

- [ ] `DECISIONS.md`: append the design-refinement entry (dt-accumulator phase ⇒ FR-10 structural; `ModulatorBus.bpm()` not a beats Signal; `ModulatorHost` in runtime for unit-testability; `validate:modulators` naming; validate-m4 tool-list update rationale).
- [ ] `feature-requests/param-modulators.md`: Status line → `implemented (2026-06-10)`.
- [ ] `loom/.claude/CLAUDE.md`: add `modulate_param` / `clear_modulation` bullets to "Your eyes and hands".
- [ ] Root `CLAUDE.md`: "8 tools" → "10 tools: …, `modulate_param`, `clear_modulation`"; add `pnpm validate:modulators` to the commands block.
- [ ] `agent-updates.md`: dated ship entry with gate results.
- [ ] Full gate run: `pnpm typecheck && pnpm test && pnpm validate:m0 && pnpm validate:m1 && pnpm validate:m2 && pnpm validate:m3 && pnpm validate:m4 && pnpm validate:modulators` — all green.
- [ ] Commit — `git commit -m "docs: param modulators shipped — decisions, agent guide, progress log"`

---

## Self-review notes

- **Spec coverage**: FR-1 (Task 2 attach/replace + Task 4 dispatch + Task 5 UI), FR-2 (host writes via `manifest.get().set()`), FR-3 (host on Entry, not Instance), FR-4 (reattach + validator #5), FR-5 (periodBeats per-frame BPM conversion + validator #7), FR-6 (createModulator range check), FR-7 (set_param gate + disabled slider), FR-8 (manifestJson + snapshot modulators + ∿ badge/animated thumb), FR-9 (host.tick containment, unit-tested), FR-10 (dt-accumulator + hold skip + validator #6), FR-11 (plain JSON specs, zod at engine dispatch). NFR-1 (closure per modulator, no per-frame allocation), NFR-2 (math in runtime, fake-clock tests, reuses lagSignal), NFR-3 (one zod variant + one MOD_TYPES row per new type).
- **Out of scope honored**: no bool thresholds for sine/triangle/ramp/drift/audio, no depth mode, no presets, no persistence.
- Types consistent: `ModulatorSpec`/`ModulatorBus`/`ModulatorEval`/`ModulatorParamMeta` (runtime), `ModulatorSummary` (protocol — distinct name from runtime's `ModulatorInfo` on purpose).
