# Stdlib tests & robustness — design spec

Date: 2026-06-11. Roadmap item "Stdlib tests & robustness (M)" — the only block before
the M6 chains half. Built autonomously on branch `claude/loom-stdlib-tests` per Zack's
"build out the next items in the roadmap up to but not including the effects chain".

## Problem

`pnpm test` covers `runtime` and `sidecar`; `content/modules/` (22 modules) ships with
zero tests and is about to grow (M11). Convention violations and NaN-producing params are
currently caught by eyes on the Output window, not by the gate.

## Design

### Headless harness — REAL BuildCtx, mock buses

The roadmap asked for a "mock BuildCtx"; inspection shows the real `BuildCtx` is already
GPU-free (its only three import is `uniform` from `three/tsl`, pure JS), so the harness
uses the **real BuildCtx** with mock/real buses — strictly stronger than a mock:

- `ProbeCtx extends BuildCtx`: overrides `uniformOf` to record every uniform it hands
  out. After ticking the updaters across frames, the recorded `.value`s are the complete
  set of CPU-side signal outputs — `Number.isFinite` over them is the NaN detector.
- Buses: `FakeAudioBus` (settable rms/band levels, deterministic queued onsets), real
  `TimeBus`, real `InputRegistry` defined from the actual `content/inputs.ts` rack, real
  `PaletteRegistry`. Modules build exactly as they do in the engine.
- Environment: vitest project at the workspace root (`loom/vitest.config.ts`) with
  `happy-dom` (TextureLoader needs a DOM `Image` at build time) and the same
  `@loom/runtime` alias the engine's Vite config uses.
- Module discovery: `import.meta.glob` over `content/modules/**` (eager) finds every
  `defineModule` export automatically — a new module is swept by tier 1/2 the moment the
  file exists; a per-module opts registry (`cases.ts`) supplies required opts, and a
  completeness test fails if a discovered module has no case (mechanically enforcing the
  "new modules merge with their tests" rule).

### Tier 1 — metadata/contract (per module, automatic)

- `meta` parses (defineModule already throws; assert shape) and `meta.kind` matches the
  folder (`control/` ↔ control, `sources/` ↔ source, `effects/` ↔ effect).
- Build succeeds with the registry's minimal opts.
- Output shape by kind: source/effect → TexNode (`color` node present, `passes` array);
  control → Signal (pullable number).
- **Pass ordering**: effects are built with a marker-pass input and must return the
  input's passes as a *prefix, in order* (`[...input.passes, ...own]` — stateless effects
  add none).
- **Manifest honesty**: every ranged param has `min < max` and default inside (zod
  enforces `min <= max`; the tests reject degenerate `min == max` knobs too).

### Tier 2 — robustness (per module, automatic)

- Param-extremes sweep: build, then for each manifest param set **min**, tick 60 frames,
  assert every probed uniform is finite and no throw; repeat at **max**; restore default.
  Bool params sweep both states; color params skipped (no numeric path).
- Effects additionally build against a black constant input ("zero-size input" — TexNodes
  are resolution-free expressions, so black-constant is the degenerate input).
- Control modules: pull the returned Signal across the sweep, assert finite.

### Golden patterns (source-scan + runtime)

- **No local re-detection**: no module or scene source may call `audio.onset(` — onset
  detection is owned by `content/inputs.ts` named channels (R6.4). Raw-source scan via
  `import.meta.glob(..., { query: "?raw" })`, with an explicit allowlist for any
  documented exception (expected: none).
- **Sources normalize to vec4 once**: every source/effect `color` is a TSL node
  (`isNode`) whose resolved node type is `vec4` where the API exposes it.
- **Stateful effects own pass ordering**: covered by the tier-1 marker-pass check.

### Ship-gate: broken modules are caught by tests

`harness.test.ts` defines deliberately broken inline modules and asserts the harness
checks flag them: (a) a NaN-producing param extreme → tier-2 sweep fails; (b) an effect
that drops its input's passes → tier-1 ordering fails; (c) invalid metadata →
defineModule throws.

### Tier 3 — smoke render (`pnpm validate:stdlib`)

`scripts/validate-stdlib.mjs` rides the existing validator infrastructure (vite boot,
headless Chromium, live.scene pin): for each module it writes a generated sandbox scene
into `live.scene.ts` (sources render directly; effects wrap an `osc` source; controls
drive an `osc` param; asset modules use real `content/assets/` files), waits for the HMR
swap, asserts **non-black pixels** and **no console errors**, then restores the original
scene. Wired into `pnpm validate` after `validate:modulators`.

### Wiring

- `pnpm test` → existing package tests **plus** `pnpm test:content` (the new root).
- `pnpm validate` gains `validate:stdlib` at the end.
- New devDependency: `happy-dom` (root). No engine/runtime behavior changes — the only
  runtime-adjacent code is test-only.

## Out of scope

M6 chains half and beyond; CI pipeline changes beyond what `pnpm test` already gates;
visual-regression goldens (smoke = non-black + clean console, not pixel-perfect).

## Testing the tests

Gates: `pnpm typecheck`, `pnpm test` (now including content), full `pnpm validate`
including the new `validate:stdlib`. The harness self-test doubles as the roadmap's
"deliberately broken module is caught" acceptance.
