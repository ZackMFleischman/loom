# MIDI Button Bindings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bindings gain a `mode` (absolute/set/cycle) with rising-edge semantics so controller buttons can radio-select, cycle, and toggle params — plus an `"actions"` pseudo-scene whose `live.next`/`live.prev` paths step the live output through ok-status tiles.

**Architecture:** Button semantics live on the persisted `Binding` (runtime `BindingStore`), which detects rising edges and dispatches through three host callbacks; the host (`main.ts`) owns the param math and routes the `"actions"` pseudo-scene into the existing stage/commit pipeline as a human gesture. Console: floats keep one-click absolute learn; bools/ints get a mode popover; the stage strip gets two action learn chips.

**Tech Stack:** TypeScript, zod, vitest, React+MUI (Console), Playwright validator (`validate-m5.mjs`). Spec: `docs/superpowers/specs/2026-06-11-midi-button-bindings-design.md`.

**Conventions that bind every task:** run everything from `loom/`; never touch the three containment layers (this plan never touches HMR/swap/render); `content/CATALOG.md` is generated; commit after each green task.

---

### Task 0: Commit the pending MIDI-monitor work

The working tree already contains a verified, unrelated feature (raw-MIDI monitor: `midi.recent` + Console dialog). Land it as its own commit so this plan starts clean.

**Files (already modified, just committing):**
- `packages/runtime/src/inputbus/midi.ts`, `packages/runtime/src/index.ts`, `packages/runtime/test/midi.test.ts`
- `packages/sidecar/src/protocol.ts`
- `packages/engine-app/src/engine-api.ts`, `packages/engine-app/src/main.ts`
- `packages/engine-app/src/ui/console/MidiMonitorDialog.tsx`, `packages/engine-app/src/ui/console/Header.tsx`
- `DECISIONS.md`

- [ ] **Step 0.1: Verify green, then commit**

Run: `pnpm test` then `pnpm typecheck` — Expected: all suites PASS, tsc clean (they were when this was built; re-verify).

```bash
git add packages/runtime/src/inputbus/midi.ts packages/runtime/src/index.ts packages/runtime/test/midi.test.ts packages/sidecar/src/protocol.ts packages/engine-app/src/engine-api.ts packages/engine-app/src/main.ts packages/engine-app/src/ui/console/MidiMonitorDialog.tsx packages/engine-app/src/ui/console/Header.tsx DECISIONS.md
git commit -m "midi: raw-message monitor (midi.recent + Console dialog)

The engine acts on CC only and dropped everything else silently, making a
controller in a DAW mode undiagnosable. MidiBus keeps the last 16 raw
messages (incl. ignored kinds, minus realtime keepalives), surfaced as
midi.recent in the session snapshot and a live dialog behind the header's
MIDI status."
```

Do NOT commit `content/state/bindings.json` (engine-written tuned state, changes with use).

---

### Task 1: `Param.step()` (runtime)

One button press: ints advance and wrap, bools flip, floats/colors hold. Lives next to `setNormalized` — same "honest range" contract.

**Files:**
- Modify: `packages/runtime/src/param.ts` (after `setNormalized`, ~line 85)
- Test: `packages/runtime/test/bindings.test.ts` (the `Param.setNormalized` describe block is here)

- [ ] **Step 1.1: Write the failing tests** — add to `packages/runtime/test/bindings.test.ts` after the `Param.setNormalized` describe:

```ts
describe("Param.step", () => {
  it("advances an int and wraps max back to min", () => {
    const m = new Manifest();
    const p = m.int("source", { default: 1, min: 0, max: 2 });
    p.step();
    expect(p.value).toBe(2);
    p.step();
    expect(p.value).toBe(0); // wrap
  });

  it("flips bools", () => {
    const m = new Manifest();
    const p = m.bool("on", { default: false });
    p.step();
    expect(p.value).toBe(true);
    p.step();
    expect(p.value).toBe(false);
  });

  it("holds floats (cycle has no honest float semantics)", () => {
    const m = new Manifest();
    const p = m.float("punch", { default: 1.2, min: 0, max: 3 });
    p.step();
    expect(p.value).toBe(1.2);
  });
});
```

- [ ] **Step 1.2: Run to verify failure**

Run: `pnpm --filter "@loom/runtime" exec vitest run test/bindings.test.ts`
Expected: FAIL — `p.step is not a function`.

- [ ] **Step 1.3: Implement** — in `packages/runtime/src/param.ts`, add to `class Param<T>` directly below `setNormalized`:

```ts
  /**
   * One button press (cycle-mode bindings): ints advance and wrap max→min,
   * bools flip, floats/colors hold — a float has no honest "next" value.
   */
  step(): void {
    if (this.type === "bool") {
      this.set(!(this.v as boolean) as unknown as T);
      return;
    }
    if (this.type !== "int") return;
    const min = this.meta.min as number;
    const max = this.meta.max as number;
    const next = (this.v as number) + 1;
    this.set((next > max ? min : next) as unknown as T);
  }
```

- [ ] **Step 1.4: Run to verify pass**

Run: `pnpm --filter "@loom/runtime" exec vitest run test/bindings.test.ts`
Expected: PASS (all, including pre-existing).

- [ ] **Step 1.5: Commit**

```bash
git add packages/runtime/src/param.ts packages/runtime/test/bindings.test.ts
git commit -m "runtime: Param.step() — int wrap / bool flip for button cycling"
```

---

### Task 2: Binding schema gains `mode` + `value`; back-compat load

**Files:**
- Modify: `packages/runtime/src/bindings.ts:10-21` (schema + `LearnTarget`)
- Test: `packages/runtime/test/bindings.test.ts`

- [ ] **Step 2.1: Write/adjust the failing tests.** In the `BindingStore` describe, REPLACE the existing `"round-trips through JSON and ignores malformed entries"` test with:

```ts
  it("round-trips through JSON, defaults mode, and ignores malformed entries", () => {
    const store = new BindingStore();
    store.load([
      { cc: 21, ch: 0, scene: "pulse", path: "punch" }, // pre-mode file entry
      { cc: 32, ch: 0, scene: "lava", path: "palette.source", mode: "set", value: 1 },
      { cc: 33, ch: null, scene: "globals", path: "inputs.kick.enabled", mode: "cycle" },
      { nope: true },
      "garbage",
    ]);
    expect(store.bindings).toEqual([
      { cc: 21, ch: 0, scene: "pulse", path: "punch", mode: "absolute" },
      { cc: 32, ch: 0, scene: "lava", path: "palette.source", mode: "set", value: 1 },
      { cc: 33, ch: null, scene: "globals", path: "inputs.kick.enabled", mode: "cycle" },
    ]);
    expect(JSON.parse(JSON.stringify(store.toJSON()))).toEqual(store.bindings);
  });
```

- [ ] **Step 2.2: Run to verify failure**

Run: `pnpm --filter "@loom/runtime" exec vitest run test/bindings.test.ts`
Expected: FAIL — loaded entries lack `mode` / set-entry's `value` is stripped.

- [ ] **Step 2.3: Implement schema.** In `packages/runtime/src/bindings.ts` replace `BindingSchema` and `LearnTarget`:

```ts
export const BindingMode = z.enum(["absolute", "set", "cycle"]);
export type BindingMode = z.infer<typeof BindingMode>;

export const BindingSchema = z.object({
  cc: z.number().int().min(0).max(127),
  ch: z.number().int().min(0).max(15).nullable(),
  scene: z.string().min(1),
  path: z.string().min(1),
  /**
   * What a CC event does to the target: "absolute" follows the control
   * continuously (setNormalized); "set"/"cycle" fire on rising edges only —
   * button semantics. Pre-mode persisted entries parse as "absolute".
   */
  mode: BindingMode.default("absolute"),
  /** set-mode target (real param value). Missing on a set param-binding = inert; actions ignore it. */
  value: z.number().optional(),
});
export type Binding = z.infer<typeof BindingSchema>;

export interface LearnTarget {
  scene: string;
  path: string;
  mode?: BindingMode;
  value?: number;
}
```

Also export the new names from `packages/runtime/src/index.ts` — extend the existing line:

```ts
export { BindingStore, BindingSchema, BindingMode, type Binding, type LearnTarget } from "./bindings";
```

(`zod` may flag the omitted-key vs `value: undefined` distinction under `exactOptionalPropertyTypes`; if `tsc` complains anywhere a `Binding` is constructed literally, build the object with a conditional spread — `...(value !== undefined ? { value } : {})` — never `value: undefined`.)

- [ ] **Step 2.4: Run tests + typecheck**

Run: `pnpm --filter "@loom/runtime" exec vitest run test/bindings.test.ts` — Expected: the round-trip test PASSES; the learn tests now FAIL on missing `mode: "absolute"` in `learned` equality — that's Task 3's work, but fix the two existing learn-test expectations now (they describe behavior that hasn't changed semantically):

In `"learn arms a target; the next CC becomes its binding"` change the assertion to:

```ts
    expect(r.learned).toEqual({ cc: 21, ch: 0, scene: "pulse", path: "punch", mode: "absolute" });
```

In `"re-learning a target replaces its previous binding"` change the assertion to:

```ts
    expect(store.bindings).toEqual([{ cc: 40, ch: 1, scene: "pulse", path: "punch", mode: "absolute" }]);
```

(These will only pass once Task 3's store changes land — if you want green-between-commits, fold Steps 2.x and 3.x into one commit at Step 3.6. Recommended: do exactly that — treat Task 2+3 as one commit boundary at 3.6, since the schema and store change together.)

---

### Task 3: `BindingStore` — ops callbacks, rising edges, radio replacement, scoped unbind

**Files:**
- Modify: `packages/runtime/src/bindings.ts` (class body)
- Test: `packages/runtime/test/bindings.test.ts`

- [ ] **Step 3.1: Update every existing `handleCc` call site in the test file** to the new ops shape, using this helper added at the top of the `BindingStore` describe:

```ts
  function recorder() {
    const writes: unknown[] = [];
    const sets: unknown[] = [];
    const steps: unknown[] = [];
    const ops = {
      write: (s: string, p: string, v: number) => void writes.push([s, p, v]),
      setValue: (s: string, p: string, v: number | undefined) => void sets.push([s, p, v]),
      step: (s: string, p: string) => void steps.push([s, p]),
    };
    return { ops, writes, sets, steps };
  }
```

Rewrite the three existing tests that call `handleCc` with a bare function so they pass `r.ops` and assert on `r.writes` (same expectations as today — absolute behavior is unchanged). Example, the first one:

```ts
  it("learn arms a target; the next CC becomes its binding", () => {
    const store = new BindingStore();
    store.startLearn({ scene: "pulse", path: "punch" });
    expect(store.learning).toEqual({ scene: "pulse", path: "punch", mode: "absolute" });
    const r = recorder();
    const res = store.handleCc({ cc: 21, ch: 0, value: 0.5 }, r.ops);
    expect(res.learned).toEqual({ cc: 21, ch: 0, scene: "pulse", path: "punch", mode: "absolute" });
    expect(store.learning).toBeNull();
    expect(r.writes).toEqual([["pulse", "punch", 0.5]]);
  });
```

(Note `store.learning` now carries the normalized `mode: "absolute"`.)

- [ ] **Step 3.2: Add the new behavior tests** to the `BindingStore` describe:

```ts
  it("set/cycle fire on rising edges only — release and repeats are inert", () => {
    const store = new BindingStore();
    store.load([
      { cc: 32, ch: 0, scene: "lava", path: "palette.source", mode: "set", value: 1 },
      { cc: 33, ch: 0, scene: "globals", path: "inputs.kick.enabled", mode: "cycle" },
    ]);
    const r = recorder();
    store.handleCc({ cc: 32, ch: 0, value: 1 }, r.ops); // press
    store.handleCc({ cc: 32, ch: 0, value: 0 }, r.ops); // release
    store.handleCc({ cc: 32, ch: 0, value: 1 }, r.ops); // press again
    expect(r.sets).toEqual([
      ["lava", "palette.source", 1],
      ["lava", "palette.source", 1],
    ]);
    store.handleCc({ cc: 33, ch: 0, value: 1 }, r.ops);
    store.handleCc({ cc: 33, ch: 0, value: 0 }, r.ops);
    expect(r.steps).toEqual([["globals", "inputs.kick.enabled"]]);
    expect(r.writes).toEqual([]); // button modes never write normalized values
  });

  it("tracks edges per (ch, cc): same cc on another channel has its own edge", () => {
    const store = new BindingStore();
    store.load([{ cc: 32, ch: null, scene: "lava", path: "palette.source", mode: "set", value: 2 }]);
    const r = recorder();
    store.handleCc({ cc: 32, ch: 0, value: 1 }, r.ops);
    store.handleCc({ cc: 32, ch: 1, value: 1 }, r.ops); // fresh edge on ch 1
    expect(r.sets).toHaveLength(2);
  });

  it("learning a set binding accumulates a radio group; same value replaces", () => {
    const store = new BindingStore();
    const r = recorder();
    store.startLearn({ scene: "lava", path: "palette.source", mode: "set", value: 0 });
    store.handleCc({ cc: 32, ch: 0, value: 1 }, r.ops);
    store.handleCc({ cc: 32, ch: 0, value: 0 }, r.ops);
    store.startLearn({ scene: "lava", path: "palette.source", mode: "set", value: 1 });
    store.handleCc({ cc: 33, ch: 0, value: 1 }, r.ops);
    store.handleCc({ cc: 33, ch: 0, value: 0 }, r.ops);
    store.startLearn({ scene: "lava", path: "palette.source", mode: "set", value: 1 }); // re-learn option 1
    store.handleCc({ cc: 34, ch: 0, value: 1 }, r.ops);
    expect(store.bindings).toEqual([
      { cc: 32, ch: 0, scene: "lava", path: "palette.source", mode: "set", value: 0 },
      { cc: 34, ch: 0, scene: "lava", path: "palette.source", mode: "set", value: 1 },
    ]);
  });

  it("learning absolute/cycle replaces non-set bindings but leaves the radio group", () => {
    const store = new BindingStore();
    store.load([
      { cc: 32, ch: 0, scene: "lava", path: "palette.source", mode: "set", value: 0 },
      { cc: 16, ch: 0, scene: "lava", path: "palette.source" }, // absolute knob
    ]);
    store.startLearn({ scene: "lava", path: "palette.source", mode: "cycle" });
    const r = recorder();
    store.handleCc({ cc: 40, ch: 0, value: 1 }, r.ops);
    expect(store.bindings).toEqual([
      { cc: 32, ch: 0, scene: "lava", path: "palette.source", mode: "set", value: 0 },
      { cc: 40, ch: 0, scene: "lava", path: "palette.source", mode: "cycle" },
    ]);
  });

  it("a button-mode learn completes on the rising edge, not on a release", () => {
    const store = new BindingStore();
    store.startLearn({ scene: "lava", path: "palette.source", mode: "cycle" });
    const r = recorder();
    store.handleCc({ cc: 40, ch: 0, value: 0 }, r.ops); // stray release: still armed
    expect(store.learning).not.toBeNull();
    store.handleCc({ cc: 40, ch: 0, value: 1 }, r.ops);
    expect(store.learning).toBeNull();
    expect(store.bindings).toHaveLength(1);
  });

  it("unbind scopes: value → one radio option; mode → that mode; bare → everything", () => {
    const store = new BindingStore();
    const all = [
      { cc: 32, ch: 0, scene: "lava", path: "palette.source", mode: "set", value: 0 },
      { cc: 33, ch: 0, scene: "lava", path: "palette.source", mode: "set", value: 1 },
      { cc: 16, ch: 0, scene: "lava", path: "palette.source", mode: "absolute" },
    ];
    store.load(all);
    expect(store.unbind({ scene: "lava", path: "palette.source", value: 1 })).toBe(true);
    expect(store.bindings.map((b) => b.cc)).toEqual([32, 16]);
    expect(store.unbind({ scene: "lava", path: "palette.source", mode: "absolute" })).toBe(true);
    expect(store.bindings.map((b) => b.cc)).toEqual([32]);
    store.load(all);
    expect(store.unbind({ scene: "lava", path: "palette.source" })).toBe(true);
    expect(store.bindings).toEqual([]);
  });

  it("startLearn toggle-cancels only the exact same target (mode+value included)", () => {
    const store = new BindingStore();
    store.startLearn({ scene: "lava", path: "palette.source", mode: "set", value: 0 });
    store.startLearn({ scene: "lava", path: "palette.source", mode: "set", value: 1 }); // re-arm, not cancel
    expect(store.learning).toEqual({ scene: "lava", path: "palette.source", mode: "set", value: 1 });
    store.startLearn({ scene: "lava", path: "palette.source", mode: "set", value: 1 }); // exact repeat = cancel
    expect(store.learning).toBeNull();
  });
```

- [ ] **Step 3.3: Run to verify failure**

Run: `pnpm --filter "@loom/runtime" exec vitest run test/bindings.test.ts`
Expected: FAIL — `handleCc` signature, `learning` normalization, unbind scoping all missing.

- [ ] **Step 3.4: Implement the store.** Replace the `BindingStore` class body in `packages/runtime/src/bindings.ts` (keep `load`/`toJSON` as they are — zod does the new fields):

```ts
/** Host callbacks: the store decides WHAT fires; the host owns the param math. */
export interface BindingOps {
  /** absolute — continuous normalized write (Param.setNormalized). */
  write(scene: string, path: string, value01: number): void;
  /** set — rising edge; value is the binding's target (undefined = inert on params). */
  setValue(scene: string, path: string, value: number | undefined): void;
  /** cycle — rising edge (Param.step / action dispatch). */
  step(scene: string, path: string): void;
}

type ArmedTarget = { scene: string; path: string; mode: BindingMode; value?: number };

export class BindingStore {
  bindings: Binding[] = [];
  learning: ArmedTarget | null = null;

  /** Last value01 per physical (ch,cc) — rising-edge detection for button modes. */
  private readonly last = new Map<string, number>();

  /** Arm learn for a target; arming the exact same target again cancels (toggle). */
  startLearn(target: LearnTarget): void {
    const t: ArmedTarget = {
      scene: target.scene,
      path: target.path,
      mode: target.mode ?? "absolute",
      ...(target.value !== undefined ? { value: target.value } : {}),
    };
    const l = this.learning;
    if (l && l.scene === t.scene && l.path === t.path && l.mode === t.mode && l.value === t.value) {
      this.learning = null;
      return;
    }
    this.learning = t;
  }

  cancelLearn(): void {
    this.learning = null;
  }

  /**
   * Route one CC event: complete a pending learn (button modes complete on a
   * rising edge only, so the release tail of the arming press is ignored),
   * then dispatch to every matching binding. Absolute bindings follow the
   * value continuously; set/cycle fire once per press.
   */
  handleCc(e: CcEvent, ops: BindingOps): { learned: Binding | null } {
    const key = `${e.ch}:${e.cc}`;
    const prev = this.last.get(key) ?? 0;
    this.last.set(key, e.value);
    const rising = prev < 0.5 && e.value >= 0.5;

    let learned: Binding | null = null;
    if (this.learning && (this.learning.mode === "absolute" || rising)) {
      const t = this.learning;
      this.learning = null;
      this.replaceFor(t);
      learned = {
        cc: e.cc,
        ch: e.ch,
        scene: t.scene,
        path: t.path,
        mode: t.mode,
        ...(t.value !== undefined ? { value: t.value } : {}),
      };
      this.bindings.push(learned);
    }

    for (const b of this.bindings) {
      if (b.cc !== e.cc || (b.ch !== null && b.ch !== e.ch)) continue;
      if (b.mode === "absolute") ops.write(b.scene, b.path, e.value);
      else if (rising) {
        if (b.mode === "set") ops.setValue(b.scene, b.path, b.value);
        else ops.step(b.scene, b.path);
      }
    }
    return { learned };
  }

  /**
   * Learn replacement: a set learn evicts only the same (scene, path, value)
   * radio option; absolute/cycle learns evict the path's non-set bindings —
   * so a knob (absolute) and a button radio group can coexist on one param.
   */
  private replaceFor(t: ArmedTarget): void {
    this.bindings = this.bindings.filter((b) => {
      if (b.scene !== t.scene || b.path !== t.path) return true;
      if (t.mode === "set") return !(b.mode === "set" && b.value === t.value);
      return b.mode === "set";
    });
  }

  /**
   * Remove bindings on a path. value → that radio option only; mode → that
   * mode's bindings; neither → everything on the path (the float widgets'
   * one-click unbind).
   */
  unbind(target: { scene: string; path: string; mode?: BindingMode; value?: number }): boolean {
    const before = this.bindings.length;
    this.bindings = this.bindings.filter((b) => {
      if (b.scene !== target.scene || b.path !== target.path) return true;
      if (target.value !== undefined) return !(b.mode === "set" && b.value === target.value);
      if (target.mode !== undefined) return b.mode !== target.mode;
      return false;
    });
    return this.bindings.length < before;
  }

  /** Replace contents from persisted JSON; malformed entries are dropped. */
  load(raw: unknown): void {
    this.bindings = [];
    if (!Array.isArray(raw)) return;
    for (const item of raw) {
      const r = BindingSchema.safeParse(item);
      if (r.success) this.bindings.push(r.data);
    }
  }

  toJSON(): Binding[] {
    return [...this.bindings];
  }
}
```

- [ ] **Step 3.5: Run all runtime tests**

Run: `pnpm --filter "@loom/runtime" exec vitest run`
Expected: PASS — including `inputs.test.ts` (check it: if it calls `handleCc` with the old callback shape, update it the same way as Step 3.1).

- [ ] **Step 3.6: Commit Tasks 2+3 together**

```bash
git add packages/runtime/src/bindings.ts packages/runtime/src/index.ts packages/runtime/test/bindings.test.ts packages/runtime/test/inputs.test.ts
git commit -m "runtime: binding modes (absolute/set/cycle) with rising-edge button semantics

set accumulates radio groups (same-value learn replaces); absolute/cycle
learns leave radio groups intact so a knob and buttons can share a param;
unbind scopes by value, mode, or path. Pre-mode bindings.json parses as
absolute."
```

---

### Task 4: Protocol — mode/value on targets, bindings, and learn state

**Files:**
- Modify: `packages/sidecar/src/protocol.ts` (`MidiTargetArgs` ~line 121, `MidiBinding` ~line 136, `MidiStatus.learning` ~line 149)
- Test: existing `packages/sidecar/test/protocol.test.ts` (no new cases needed — fields are optional/defaulted)

- [ ] **Step 4.1: Implement schema changes**

```ts
export const BindingModeZ = z.enum(["absolute", "set", "cycle"]);
export type BindingModeZ = z.infer<typeof BindingModeZ>;

/**
 * MIDI-learn target: a param path on an instance (resolved to its scene
 * engine-side — bindings are durable across instance churn), on "globals",
 * or on the "actions" pseudo-instance (live.next / live.prev). mode/value
 * choose the binding semantics; omitted = absolute.
 */
export const MidiTargetArgs = z.object({
  instance: z.string().default("live"),
  path: z.string().min(1),
  mode: BindingModeZ.optional(),
  value: z.number().optional(),
});
export type MidiTargetArgs = z.infer<typeof MidiTargetArgs>;
```

```ts
/** A persisted MIDI binding (shape mirrors @loom/runtime's BindingSchema). */
export const MidiBinding = z.object({
  cc: z.number(),
  ch: z.number().nullable(),
  scene: z.string(),
  path: z.string(),
  mode: BindingModeZ.default("absolute"),
  value: z.number().optional(),
});
```

In `MidiStatus`, replace the `learning` line:

```ts
  /** Armed MIDI-learn target, or null. */
  learning: z
    .object({
      scene: z.string(),
      path: z.string(),
      mode: BindingModeZ.optional(),
      value: z.number().optional(),
    })
    .nullable(),
```

- [ ] **Step 4.2: Run sidecar tests + typecheck**

Run: `pnpm --filter "@loom/sidecar" exec vitest run` — Expected: PASS (optional/defaulted fields keep old fixtures parsing).
Run: `pnpm typecheck` — Expected: clean. If engine-app fails on `bindings.handleCc` (signature changed in Task 3), that's Task 5 — proceed there before committing; Tasks 4+5 commit together at Step 5.5.

---

### Task 5: Engine — router ops, `liveStep`, actions learn target

**Files:**
- Modify: `packages/engine-app/src/main.ts:160-180` (CC router) and after `const api = ...` (~line 345)
- Modify: `packages/engine-app/src/engine-api.ts` (`resolveMidiTarget`, `midi_unbind`, `rename_instance`, new `liveStep`)

- [ ] **Step 5.1: Rewrite the CC router in `main.ts`.** Replace the block at lines 160–180 (`// MIDI routing: ...` through `});`) with:

```ts
// MIDI routing: a CC completes a pending learn, then drives its bindings.
// Absolute writes ride the same Manifest path as set_param; button modes
// (set/cycle) fire per press; the "actions" pseudo-scene steps LIVE through
// the tiles (wired to the EngineApi below once it exists — CCs can arrive
// during the boot awaits, hence the late-bound holder).
const ACTIONS = "actions";
let onAction: (path: string) => void = () => {};

function writeParam(scene: string, path: string, apply: (p: Param<unknown>) => void): void {
  if (scene === "globals") {
    const isPalette = path.startsWith("palette.");
    const param = (isPalette ? palettes.manifest : inputs.manifest).get(path);
    if (!param) return;
    apply(param);
    if (isPalette) persist.palettes();
    else persist.globals();
    return;
  }
  let touched = false;
  for (const entry of session.entries.values()) {
    if (entry.sceneName !== scene) continue;
    const param = entry.instance.manifest.get(path);
    if (param) {
      apply(param);
      touched = true;
    }
  }
  if (touched) persist.scene(scene);
}

midi.onCc((e) => {
  const { learned } = bindings.handleCc(e, {
    write: (scene, path, v01) => writeParam(scene, path, (p) => p.setNormalized(v01)),
    setValue: (scene, path, value) => {
      if (scene === ACTIONS) return onAction(path);
      if (value === undefined) return; // a set binding without a target is inert
      writeParam(scene, path, (p) => p.set(value));
    },
    step: (scene, path) => {
      if (scene === ACTIONS) return onAction(path);
      writeParam(scene, path, (p) => p.step());
    },
  });
  if (learned) persist.bindings();
});
```

Add `Param` to the existing `@loom/runtime` type imports at the top of `main.ts` (`import { ..., type Param } from "@loom/runtime";` — match however the runtime imports are currently grouped there).

`writeParam` is a hoisted function declaration referencing `session`/`palettes`/`inputs`/`persist` consts that exist before any CC can fire — same pattern as the code it replaces.

- [ ] **Step 5.2: Wire the action holder after `api` is constructed.** Directly after the `const api = new EngineApi({...})` statement closes, add:

```ts
// MIDI action bindings step LIVE through the tiles — a physical button press
// is a human gesture, so this rides the human trust tier (no agent arming).
onAction = (path) => {
  if (path === "live.next") api.liveStep(1);
  else if (path === "live.prev") api.liveStep(-1);
};
```

- [ ] **Step 5.3: Add `liveStep` to `EngineApi`** (in `packages/engine-app/src/engine-api.ts`, after the `snapshot()` method):

```ts
  /**
   * MIDI action: crossfade LIVE to the next/prev ok-status tile, wrapping in
   * tile (insertion) order. Mash-safe: ignored mid-fade, under PANIC, or with
   * fewer than two healthy tiles — a stuck button can never throw.
   */
  liveStep(dir: 1 | -1): void {
    const { session, stage } = this.deps;
    if (stage.panicked || stage.fading) return;
    const ids = [...session.entries.values()]
      .filter((e) => entryStatus(e) === "ok")
      .map((e) => e.id);
    const live = stage.live;
    if (live == null || ids.length < 2) return;
    const cur = ids.indexOf(live);
    const next = ids[(cur + dir + ids.length) % ids.length]!;
    if (next === live) return;
    stage.stage(next); // deliberately clobbers a pending staged candidate — performer wins
    stage.commit(this.deps.latestFrame(), 60);
  }
```

(`entryStatus` is already imported at the top of engine-api.ts. `cur === -1` — live tile not ok — resolves to a valid neighbor via the modulo.)

- [ ] **Step 5.4: Teach `resolveMidiTarget` the actions pseudo-instance and thread mode/value.** In `engine-api.ts`:

Add next to the `GLOBALS` const:

```ts
/** Pseudo-instance for MIDI action bindings (stage navigation). */
const ACTIONS = "actions";
const ACTION_PATHS: ReadonlySet<string> = new Set(["live.next", "live.prev"]);
```

Replace `resolveMidiTarget`:

```ts
  /**
   * MIDI targets address a SCENE (durable across instance churn): an instance
   * arg resolves to its scene name; "globals" and "actions" pass through.
   * Param paths must exist on the target manifest right now — fail loud at
   * learn time, not silently on the first knob twist. Action bindings are
   * always edge-triggered ("set" semantics, no value).
   */
  private resolveMidiTarget(args: unknown): {
    scene: string;
    path: string;
    mode?: "absolute" | "set" | "cycle";
    value?: number;
  } {
    const { instance, path, mode, value } = MidiTargetArgs.parse(args);
    const rest = {
      ...(mode !== undefined ? { mode } : {}),
      ...(value !== undefined ? { value } : {}),
    };
    if (instance === ACTIONS) {
      if (!ACTION_PATHS.has(path)) {
        throw new Error(`unknown action "${path}" — actions: ${[...ACTION_PATHS].join(", ")}`);
      }
      return { scene: ACTIONS, path, mode: "set" };
    }
    if (instance === GLOBALS) {
      this.requireParam(this.globalsManifest(path), path, GLOBALS);
      return { scene: GLOBALS, path, ...rest };
    }
    const e = this.deps.session.require(this.resolveId(instance));
    this.requireParam(e.instance.manifest, path, e.id);
    return { scene: e.sceneName, path, ...rest };
  }
```

`midi_learn` and `midi_unbind` cases pass the resolved target through unchanged — the Task 3 store accepts the extra fields on both. Also extend the reserved-name check in `case "rename_instance"`:

```ts
        if (to === "live" || to === "globals" || to === "actions") {
          throw new Error(`"${to}" is a reserved name`);
        }
```

- [ ] **Step 5.5: Typecheck + unit tests, commit with Task 4**

Run: `pnpm typecheck` — Expected: clean.
Run: `pnpm test` — Expected: PASS.

```bash
git add packages/sidecar/src/protocol.ts packages/engine-app/src/main.ts packages/engine-app/src/engine-api.ts
git commit -m "engine: binding-mode routing + actions pseudo-scene (live.next/live.prev)

CC router dispatches write/setValue/step; actions step LIVE through
ok-status tiles via the existing stage/commit pipeline as a human gesture,
mash-safe (ignored mid-fade/PANIC). 'actions' joins the reserved names."
```

---

### Task 6: Console — `BindPopover` for bool/int params

**Files:**
- Create: `packages/engine-app/src/ui/console/BindPopover.tsx`
- Modify: `packages/engine-app/src/ui/console/ParamWidget.tsx`

- [ ] **Step 6.1: Create `BindPopover.tsx`:**

```tsx
import { Box, Button, Popover, Stack, Typography } from "@mui/material";
import type { MidiBinding, SessionSnapshot } from "@loom/sidecar/protocol";
import type { ParamDesc } from "../engine-link";
import { useEngine } from "../hooks";
import { fail } from "../util";

type Mode = "absolute" | "set" | "cycle";

type Props = {
  instance: string;
  path: string;
  p: ParamDesc;
  /** This param's bindings (scene-resolved by the caller). */
  bindings: MidiBinding[];
  learning: SessionSnapshot["midi"]["learning"];
  anchorEl: HTMLElement | null;
  onClose: () => void;
};

/**
 * Pick HOW a control drives this param, then arm learn: absolute follows a
 * knob, cycle/toggle steps per button press, set <option> builds a radio
 * group (one button per option — S/M/R rows). Existing bindings list with
 * per-binding unbind, which radio groups need.
 */
export function BindPopover({ instance, path, p, bindings, learning, anchorEl, onClose }: Props) {
  const link = useEngine();
  const isBool = p.type === "bool";
  const min = typeof p.min === "number" ? p.min : 0;
  const labels = Array.isArray(p.labels) ? p.labels : null;

  const armed = (mode: Mode, value?: number) =>
    learning != null &&
    learning.path === path &&
    (learning.mode ?? "absolute") === mode &&
    learning.value === value;

  const arm = (mode: Mode, value?: number) =>
    void link
      .req("midi_learn", { instance, path, mode, ...(value !== undefined ? { value } : {}) })
      .catch(fail);

  const row = (label: string, mode: Mode, value?: number) => (
    <Button
      key={`${mode}:${value ?? ""}`}
      data-bindmode={value !== undefined ? `${mode}:${value}` : mode}
      onClick={() => arm(mode, value)}
      sx={{
        justifyContent: "flex-start",
        fontSize: 12,
        py: 0.25,
        ...(armed(mode, value)
          ? { bgcolor: "warning.main", color: "#000", animation: "learnpulse 0.9s infinite alternate" }
          : {}),
      }}
    >
      {armed(mode, value) ? `${label} — move a control…` : label}
    </Button>
  );

  const describeBinding = (b: MidiBinding) =>
    b.mode === "set"
      ? `set ${labels?.[(b.value ?? 0) - min] ?? b.value}`
      : b.mode === "cycle" && isBool
        ? "toggle"
        : b.mode;

  return (
    <Popover
      open={anchorEl != null}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
      transformOrigin={{ vertical: "top", horizontal: "right" }}
    >
      <Stack className="bindpop" sx={{ p: 1, width: 250 }}>
        {row("absolute — follow a knob", "absolute")}
        {row(isBool ? "toggle — button flips it" : "cycle — button steps, wraps", "cycle")}
        {labels?.map((l, i) => row(`set: ${l}`, "set", i + min))}
        {bindings.length > 0 && (
          <Box sx={{ borderTop: 1, borderColor: "divider", mt: 0.5, pt: 0.5 }}>
            {bindings.map((b) => (
              <Stack
                key={`${b.cc}:${b.mode}:${b.value ?? ""}`}
                direction="row"
                alignItems="center"
                spacing={0.5}
              >
                <Typography variant="caption" sx={{ flex: 1 }}>
                  cc{b.cc} → {describeBinding(b)}
                </Typography>
                <Button
                  size="small"
                  data-unbind={`${b.cc}:${b.mode}:${b.value ?? ""}`}
                  sx={{ minWidth: 0, px: 0.5, color: "text.secondary" }}
                  onClick={() =>
                    void link
                      .req("midi_unbind", {
                        instance,
                        path,
                        mode: b.mode,
                        ...(b.mode === "set" && b.value !== undefined ? { value: b.value } : {}),
                      })
                      .catch(fail)
                  }
                >
                  ✕
                </Button>
              </Stack>
            ))}
          </Box>
        )}
      </Stack>
    </Popover>
  );
}
```

(Check `ParamDesc` in `packages/engine-app/src/ui/engine-link.ts` declares `labels?: string[]` — ParamWidget already reads `p.labels`, so it should. If absent, add it there.)

- [ ] **Step 6.2: Wire into `ParamWidget.tsx`.** Changes, keeping the DOM contract (`data-learn`, exact `"M"` / `"···"` / `"cc<N>"` text for single bindings):

1. Import: `import { BindPopover } from "./BindPopover";`
2. Add state next to `modAnchor`: `const [bindAnchor, setBindAnchor] = useState<HTMLElement | null>(null);`
3. Replace the single-binding lookup with a plural one:

```tsx
  const bindingsFor =
    scene != null
      ? (session?.bindings.filter((b) => b.scene === scene && b.path === path) ?? [])
      : [];
  const binding = bindingsFor[0] ?? null;
  // Bools and ints have button semantics (toggle/cycle/radio) — M opens the
  // mode popover. Floats keep the one-click absolute learn.
  const hasModes = p.type === "bool" || p.type === "int";
```

4. Replace `onLearn`:

```tsx
  const onLearn = (e: MouseEvent) => {
    e.stopPropagation();
    // No MIDI access yet? This click IS the user gesture — pop the prompt here.
    if (session?.midi.status !== "ready") primeMidiPermission();
    if (hasModes) {
      setBindAnchor((a) => (a ? null : (e.currentTarget as HTMLElement)));
      return;
    }
    // bound → unbind; learning → cancel (engine toggles); unbound → arm
    const action = binding != null && !learning ? "midi_unbind" : "midi_learn";
    void link.req(action, { instance, path }).catch(fail);
  };
```

5. Chip label + title — replace the learn `<Button>`'s `title` and text child:

```tsx
          title={
            learning
              ? "move a controller… (click to cancel)"
              : bindingsFor.length > 0
                ? `${bindingsFor.map((b) => `cc${b.cc} ${b.mode}${b.mode === "set" ? ` ${b.value}` : ""}`).join(" · ")}${hasModes ? " — click to edit" : " — click to unbind"}`
                : hasModes
                  ? "MIDI-learn: click to choose absolute / cycle / set"
                  : "MIDI-learn: click, then move a knob"
          }
```

```tsx
          {learning ? "···" : bindingsFor.length > 1 ? `cc×${bindingsFor.length}` : binding ? `cc${binding.cc}` : "M"}
```

6. Render the popover next to `ModPopover` at the bottom (note: also for `"globals"` — bools live in the rack):

```tsx
      {hasModes && (
        <BindPopover
          instance={instance}
          path={path}
          p={p}
          bindings={bindingsFor}
          learning={session?.midi.learning ?? null}
          anchorEl={bindAnchor}
          onClose={() => setBindAnchor(null)}
        />
      )}
```

- [ ] **Step 6.3: Typecheck**

Run: `pnpm typecheck` — Expected: clean.

- [ ] **Step 6.4: Commit**

```bash
git add packages/engine-app/src/ui/console/BindPopover.tsx packages/engine-app/src/ui/console/ParamWidget.tsx
git commit -m "console: bind-mode popover for bool/int params (absolute/cycle/set radio)"
```

---

### Task 7: Console — stage-strip action chips

**Files:**
- Modify: `packages/engine-app/src/ui/console/StageStrip.tsx`

- [ ] **Step 7.1: Add the chips.** Add this component at the bottom of `StageStrip.tsx`:

```tsx
/** MIDI-learn chip for a stage action (live.prev / live.next): press a
 * controller button to step LIVE through the ok tiles. Same visual contract
 * as ParamWidget's learn button (data-learn, M/···/ccN). */
function ActionChip({ s, path, label }: { s: SessionSnapshot; path: "live.prev" | "live.next"; label: string }) {
  const link = useEngine();
  const binding = s.bindings.find((b) => b.scene === "actions" && b.path === path) ?? null;
  const learning =
    s.midi.learning != null && s.midi.learning.scene === "actions" && s.midi.learning.path === path;
  return (
    <Button
      data-learn={path}
      title={
        learning
          ? "press a controller button… (click to cancel)"
          : binding
            ? `bound to cc${binding.cc} — click to unbind`
            : `MIDI-learn: click, then press a button — ${label} steps LIVE through the tiles`
      }
      onClick={() => {
        const action = binding != null && !learning ? "midi_unbind" : "midi_learn";
        void link.req(action, { instance: "actions", path }).catch(fail);
      }}
      sx={{
        minWidth: 0,
        px: 0.75,
        py: 0,
        fontSize: 11,
        lineHeight: "18px",
        ...(learning
          ? { bgcolor: "warning.main", color: "#000", animation: "learnpulse 0.9s infinite alternate" }
          : binding
            ? { color: "primary.main", borderColor: "primary.main" }
            : { color: "text.secondary" }),
      }}
    >
      {label} {learning ? "···" : binding ? `cc${binding.cc}` : "M"}
    </Button>
  );
}
```

In the `StageStrip` JSX, insert after the `#fadeinfo` Typography (before `<Box sx={{ flex: 1 }} />`):

```tsx
      <ActionChip s={s} path="live.prev" label="◀ live" />
      <ActionChip s={s} path="live.next" label="live ▶" />
```

- [ ] **Step 7.2: Typecheck**

Run: `pnpm typecheck` — Expected: clean.

- [ ] **Step 7.3: Commit**

```bash
git add packages/engine-app/src/ui/console/StageStrip.tsx
git commit -m "console: stage-strip MIDI-learn chips for live.prev/live.next"
```

---

### Task 8: Acceptance — extend `validate-m5.mjs`

**Files:**
- Modify: `scripts/validate-m5.mjs` — insert the new sections immediately BEFORE the final "MCP tool surface unchanged" check (search for `"MCP tool surface unchanged"` and insert above the block that computes it).

Context for whoever lands here cold: the validator drives a real headless engine. `midi_learn` is HUMAN_ONLY, so it cannot be called over MCP — the existing suite arms learn by clicking Console widgets. For mode-learn we post requests on the page's `BroadcastChannel("loom")` (exactly what the Console does); the engine replies on the same channel. `window.__loom.midiInject(cc, ch, value01)` feeds the real CC path. Helpers already in the file: `callOk(client, tool, args)`, `toolJson(res)`, `waitFor(fn, ms, what)`, `check(name, ok, info?)`, `sleep(ms)`, pages `output` and `consolePage`.

- [ ] **Step 8.1: Add a channel-request helper** near the other helpers at the top of the run function (it needs `output`):

```js
  // Human-tier requests (midi_learn/unbind are HUMAN_ONLY): post on the
  // page's BroadcastChannel exactly like the Console does.
  let chanSeq = 0;
  const humanReq = (type, args) =>
    output.evaluate(
      ([t, a, id]) =>
        new Promise((resolve, reject) => {
          const ch = new BroadcastChannel("loom");
          const timer = setTimeout(() => {
            ch.close();
            reject(new Error(`no response to ${t}`));
          }, 5000);
          ch.onmessage = (e) => {
            const m = e.data;
            if (m?.kind !== "res" || m.id !== id) return;
            clearTimeout(timer);
            ch.close();
            m.ok ? resolve(m.result) : reject(new Error(m.error));
          };
          ch.postMessage({ id, kind: "req", type: t, args: a });
        }),
      [type, args, `vm5-${++chanSeq}`],
    );
```

(Verify the response shape against `packages/engine-app/src/console-channel.ts` — the request/response `kind`/`id`/`ok` fields must match what the console channel actually speaks. Adjust field names to match before running.)

- [ ] **Step 8.2: Add the new checks** (insert before the tool-surface check):

```js
  // 11. Button modes — set builds a radio group on a param; rising edge only.
  await humanReq("midi_learn", { instance: "boot", path: "punch", mode: "set", value: 3 });
  await output.evaluate(() => window.__loom.midiInject(34, 0, 1)); // press learns + fires
  await output.evaluate(() => window.__loom.midiInject(34, 0, 0)); // release inert
  await humanReq("midi_learn", { instance: "boot", path: "punch", mode: "set", value: 0.75 });
  await output.evaluate(() => window.__loom.midiInject(35, 0, 1));
  await output.evaluate(() => window.__loom.midiInject(35, 0, 0));
  const radio = await waitFor(async () => {
    const s = toolJson(await callOk(client, "get_session", {}));
    const ours = s.bindings.filter((b) => b.path === "punch" && b.mode === "set");
    return ours.length === 2 ? s : null;
  }, 5_000, "radio group to land");
  check("set-mode learns accumulate a radio group", true, JSON.stringify(radio.bindings));
  const punchSet = toolJson(await callOk(client, "get_manifest", { instance: "boot" })).params.punch.value;
  check("set binding fired on the learning press", punchSet === 0.75, `punch=${punchSet}`);
  await output.evaluate(() => window.__loom.midiInject(34, 0, 1)); // radio: back to 3
  const punch3 = await waitFor(async () => {
    const v = toolJson(await callOk(client, "get_manifest", { instance: "boot" })).params.punch.value;
    return v === 3 ? v : null;
  }, 5_000, "radio press to set 3");
  check("radio press sets its option value", punch3 === 3);
  await output.evaluate(() => window.__loom.midiInject(34, 0, 0)); // release
  await sleep(300);
  const punchStill = toolJson(await callOk(client, "get_manifest", { instance: "boot" })).params.punch.value;
  check("release is inert (rising edge only)", punchStill === 3, `punch=${punchStill}`);

  // 12. Cycle on a globals bool — button toggles, release inert.
  await humanReq("midi_learn", { instance: "globals", path: "inputs.kick.enabled", mode: "cycle" });
  const before = toolJson(await callOk(client, "get_manifest", { instance: "globals" }))
    .params["inputs.kick.enabled"].value;
  await output.evaluate(() => window.__loom.midiInject(36, 0, 1)); // learn + flip
  const flipped = await waitFor(async () => {
    const v = toolJson(await callOk(client, "get_manifest", { instance: "globals" }))
      .params["inputs.kick.enabled"].value;
    return v === !before ? v : null;
  }, 5_000, "cycle to flip the bool");
  check("cycle flips a globals bool", flipped === !before);
  await output.evaluate(() => window.__loom.midiInject(36, 0, 0)); // release
  await output.evaluate(() => window.__loom.midiInject(36, 0, 1)); // flip back
  const restored = await waitFor(async () => {
    const v = toolJson(await callOk(client, "get_manifest", { instance: "globals" }))
      .params["inputs.kick.enabled"].value;
    return v === before ? v : null;
  }, 5_000, "second press to flip back");
  check("second press flips back (edge per press)", restored === before);

  // 13. Actions: live.next / live.prev crossfade between ok tiles.
  await callOk(client, "create_instance", { scene: "pulse", id: "deck2" });
  await humanReq("midi_learn", { instance: "actions", path: "live.next" });
  await output.evaluate(() => window.__loom.midiInject(44, 0, 1)); // learn + step
  const live2 = await waitFor(async () => {
    const s = toolJson(await callOk(client, "get_session", {}));
    return s.live === "deck2" ? s : null;
  }, 10_000, "live.next to switch live to deck2");
  check("live.next steps LIVE to the next ok tile", live2.live === "deck2");
  await output.evaluate(() => window.__loom.midiInject(44, 0, 0));
  await waitFor(async () => {
    const s = toolJson(await callOk(client, "get_session", {}));
    return s.mix == null ? true : null; // fade finished
  }, 10_000, "crossfade to finish");
  await output.evaluate(() => window.__loom.midiInject(44, 0, 1)); // wrap back
  const liveBack = await waitFor(async () => {
    const s = toolJson(await callOk(client, "get_session", {}));
    return s.live === "boot" ? s : null;
  }, 10_000, "live.next to wrap back to boot");
  check("live.next wraps around the tile ring", liveBack.live === "boot");
  await output.evaluate(() => window.__loom.midiInject(44, 0, 0));
  const stripChip = await consolePage.$eval('[data-learn="live.next"]', (b) => b.textContent);
  check("stage strip shows the action binding", /cc44/.test(stripChip ?? ""), stripChip);

  // 14. Mode/value persist to bindings.json.
  await sleep(800); // debounced write
  const bindingsJson2 = JSON.parse(readFileSync(join(STATE_DIR, "bindings.json"), "utf8"));
  check(
    "bindings.json carries mode/value and the action binding",
    bindingsJson2.some((b) => b.mode === "set" && b.value === 3) &&
      bindingsJson2.some((b) => b.scene === "actions" && b.path === "live.next"),
    JSON.stringify(bindingsJson2),
  );
```

NOTE for the implementer: section 8 of the existing suite unbinds punch's cc21 before this point, and earlier sections may leave learn state clean — but if any earlier check left a binding on `punch`, the radio assertions (`ours.length === 2`) may need `b.cc === 34 || b.cc === 35` instead. Prefer that filter if flaky. Also confirm `create_instance` accepts an `id` arg (`CreateInstanceArgs`) — if not, read the returned `instance` id and use it instead of `"deck2"` throughout section 13.

- [ ] **Step 8.3: Run the suite**

Run: `pnpm validate:m5`
Expected: all existing 24 checks + the ~9 new ones PASS. Debug loop: the suite prints FAIL lines with info; the engine's console messages stream through the `[vite]` prefix.

- [ ] **Step 8.4: Commit**

```bash
git add scripts/validate-m5.mjs
git commit -m "validate-m5: button binding modes + live.next/prev acceptance"
```

---

### Task 9: Full gates + bookkeeping

- [ ] **Step 9.1: Full validation**

Run, in order: `pnpm typecheck` → `pnpm test` → `pnpm validate`
Expected: everything green. `pnpm validate` runs m0…m6 + modulators; this work must not regress any of them (most likely regression point: m3's stage/commit checks — `liveStep` reuses the same pipeline and shouldn't disturb it, but verify).

- [ ] **Step 9.2: DECISIONS.md entry** — append:

```markdown
## 2026-06-11 — SHIPPED: MIDI button bindings (modes + actions pseudo-scene)

Bindings carry mode absolute/set/cycle (rising-edge for buttons): set
accumulates radio groups, cycle wraps ints / flips bools (Param.step), and
pseudo-scene "actions" (live.next/live.prev) steps LIVE through ok tiles via
stage/commit as a human gesture (mash-safe; clobbers a pending staged
candidate by design). Gates: typecheck, unit, full pnpm validate. Spec:
docs/superpowers/specs/2026-06-11-midi-button-bindings-design.md.
```

- [ ] **Step 9.3: Final commit**

```bash
git add DECISIONS.md
git commit -m "housekeeping: SHIPPED entry for MIDI button bindings"
```

---

## Self-review notes (already applied)

- Spec §1–§5 each map to Tasks 2–3 / 5 / 6–7 / 4 / 8 respectively; Task 1 backs §2's `step`.
- The learn-completion edge case (button-mode learn ignores the arming press's release) is spec'd in §1 "rising edge" and tested in Task 3.
- `unbind` grew a `mode` scope beyond the spec's `value` scope — required so the popover's per-binding ✕ can remove an absolute binding without nuking a coexisting radio group (spec's intent, surfaced during planning).
- Two flagged verification points for the implementer: BroadcastChannel message field names (Step 8.1) and `CreateInstanceArgs` id support (Step 8.2) — both verified against source before running, per the notes inline.
