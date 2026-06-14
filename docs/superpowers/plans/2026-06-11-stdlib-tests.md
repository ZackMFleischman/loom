# Stdlib Tests & Robustness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per `docs/superpowers/specs/2026-06-11-stdlib-tests-design.md` — a headless test root for `content/` (real BuildCtx + mock buses), tier-1/2 sweeps over every module, golden-pattern scans, a broken-module self-test, and a tier-3 smoke-render validator.

**Architecture:** New `loom/vitest.config.ts` root (happy-dom + `@loom/runtime` alias) running `content/test/**`; `import.meta.glob` discovery so coverage is automatic; `scripts/validate-stdlib.mjs` rides the live.scene-pin validator pattern.

**Tech stack:** vitest 4, happy-dom, Playwright (existing), no runtime changes.

### Task 1: vitest root + wiring
**Files:** Create `loom/vitest.config.ts`, `content/test/vite-env.d.ts`; modify `loom/package.json` (happy-dom devDep, `test:content`, `test` chain, `validate:stdlib`, `validate` chain).
- [ ] config: include `content/test/**/*.test.ts`, environment happy-dom, aliases for `@loom/runtime` (+ `@loom/sidecar/protocol`).
- [ ] `pnpm install` for happy-dom; empty smoke test runs.

### Task 2: harness
**Files:** Create `content/test/harness.ts`, `content/test/cases.ts`.
- [ ] `FakeAudioBus` (settable levels, queued onsets), `ProbeCtx` (uniform probes), `makeCtx()` assembling real TimeBus/InputRegistry(content rack)/PaletteRegistry.
- [ ] `discoverModules()` via eager glob (exports with `.meta`), folder→kind mapping.
- [ ] `cases.ts`: per-module required opts (input/url/urls/overlay/cols/rows) with `markerInput()` and asset URLs via `new URL`.
- [ ] `tickFrames(ctx, n)` advancing TimeBus + updaters; `probeValues(ctx)`.

### Task 3: tier-1 `contract.test.ts`
- [ ] discovery non-empty (≥ 20), every module has a case, kind↔folder, meta shape.
- [ ] build per case; TexNode/Signal shape per kind; marker-pass prefix order for effects; manifest honesty (min < max, default inside, descriptions non-empty).

### Task 4: tier-2 `robustness.test.ts`
- [ ] per module: extremes sweep (min/max per ranged param, both bool states), 60-frame tick, all probes finite, no throw; effects also against black input; control signals pulled finite.

### Task 5: golden patterns + self-test
**Files:** `content/test/golden-patterns.test.ts`, `content/test/harness.test.ts`.
- [ ] raw-source scan: no `audio.onset(` in modules or scenes (allowlist const, expected empty); `color.isNode` on all sources/effects.
- [ ] self-test: NaN-extreme module fails tier-2 helper; pass-dropping effect fails tier-1 helper; bad meta throws.

### Task 6: tier-3 `scripts/validate-stdlib.mjs`
- [ ] vite boot + headless Chromium per validator pattern (own port pair); for each module write a generated sandbox scene into `live.scene.ts` (effects wrap osc, controls drive osc, assets from content/assets), wait for swap (`__loom.sceneName`), assert center-crop non-black + zero page errors; restore scene in `finally`.
- [ ] `pnpm validate:stdlib` script; append to `pnpm validate`.

### Task 7: gates + docs
- [ ] `pnpm typecheck`, `pnpm test`, full `pnpm validate` green.
- [ ] DECISIONS entry; roadmap: move item to Shipped; commit per task; push branch.

## Self-review
Spec coverage: harness (T2), tier1 (T3), tier2 (T4), golden+gate (T5), tier3 (T6), wiring (T1), docs (T7). ✓ No placeholders; code detail lives in the harness files themselves (single-author inline execution). Types named consistently (ProbeCtx, FakeAudioBus, markerInput, discoverModules).
