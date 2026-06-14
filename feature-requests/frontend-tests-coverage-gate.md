# Feature request: frontend tests + a coverage gate scoped to `packages/`

Status: requested · Requested: 2026-06-13 · Owner: unassigned

## Summary

Two asks bundled together: (1) add a **code-coverage gate**, and (2) add **frontend
tests** for the Console — its React components, hooks, and the state logic behind them.
The hard constraint frames both: the gate must scope to **`packages/`** (engine code,
human-reviewed) and **never touch `content/`** (agent territory, where visuals get built
FAST). Tests for visuals stay an *optional, later* add-on that must never sit between an
agent and a saved scene. This doc audits what's already tested, confirms the Console's
actual stack (it's React — RTL applies), recommends what's worth testing vs. not, and
makes the "never slow the creative session" boundary concrete in terms of which scripts
gate and which don't.

## Current state (grounded)

**Test layers today** (`docs/architecture.md` §"Testing & validation", lines 213–293):
1. typecheck — the contract gate (`pnpm typecheck`).
2. package unit tests (`pnpm -r test`) — runtime / sidecar / engine-app, plain vitest.
3. stdlib content tests (`pnpm test:content`) — tier-1/2 + golden patterns, happy-dom.
4. acceptance validators (`pnpm validate`) — Playwright + headless Chromium, the eyes-on
   layer; deliberately **not** run in CI (`.github/workflows/ci.yml` lines 18–21).

**The Console IS React.** `packages/engine-app/package.json` (lines 10–25) pulls
`react@^19`, `react-dom@^19`, `@mui/material@^7`, `@emotion/*`, `@dnd-kit/*`. The cockpit
is 24 `.tsx` files under `packages/engine-app/src/ui/` (`ConsoleApp.tsx`, `TileGrid.tsx`,
`ParamPanel.tsx`, `FxChain.tsx`, `Rack.tsx`, `Palettes.tsx`, popovers, …). So the ask's
phrasing — "React tests and hook tests" — is on target: **RTL + `@testing-library/react`
is the right tool**, and there is a real hooks file (`src/ui/hooks.ts`) to cover.
*(Correction to any assumption that the Console is vanilla DOM: it is not — that was true
of an earlier prototype and is still implied in `console-screenshot.md` lines 32–33, which
should be re-read sceptically when that work lands.)*

**What's already tested in engine-app** (`packages/engine-app/test/`, 11 files):
`console-logic.test.ts`, `engine-api.test.ts`, `engine-link.test.ts`,
`debug-surface.test.ts`, `fixture-service.test.ts`, `fps-meter.test.ts`,
`midi-router.test.ts`, `panic-controller.test.ts`, `projects(-controller).test.ts`,
`render-service.test.ts`. Vitest root is `environment: "node"`
(`packages/engine-app/vitest.config.ts` line 5) — **no DOM, no component rendering**.

**The existing house pattern is "extract logic, test it headless."** `console-logic.test.ts`
imports from `src/ui/console/chain-ops.ts` (90 LOC) and `src/ui/console/param-groups.ts`
(84 LOC) — pure functions (`groupParams`, `splitRig`, `chainSteps`, `insertStep`, …)
deliberately lifted *out* of the `.tsx` so they can be unit-tested with plain vitest and no
React. `engine-link.test.ts` drives `EngineLink` (`src/ui/engine-link.ts`, 232 LOC) through
an injectable `ChannelLike` + `schedule`/`now` (lines 39–53) — the store is already
test-shaped (it powers the `useSyncExternalStore` hooks in `src/ui/hooks.ts`). **The
component layer itself — the `.tsx` render output, MUI interactions, the hooks wired to
React — has zero tests.** That's the gap.

**No coverage tooling exists.** No `@vitest/coverage-*` in any `package.json`, no
`coverage` key in any vitest config (root, runtime, sidecar, engine-app, or
`vitest.scripts.config.ts`), no CI coverage step.

**No git hooks.** No `.husky/`, no `.git/hooks/pre-commit` — nothing runs tests on save or
on commit. The live session is gated only by what an agent chooses to run. This matters: it
means the constraint is *already mostly satisfied by construction* — there is no machinery
forcing tests during content work today, and the job is to keep it that way when adding a
gate. See [[validator-test-consolidation]] for the sibling effort on the slow validator
layer.

## The gating policy (the load-bearing part)

The non-negotiable: **building visuals stays a single round-trip — write scene, save,
screenshot — with no test step in the loop, ever.** Make that concrete:

- **The coverage gate scopes to `packages/` only.** `content/` is excluded from coverage
  entirely — never measured, never thresholded. An agent adding a scene or module can drop
  coverage of `content/` to zero and no gate cares, because there is no gate over
  `content/`. The biome lint config already draws this packages-vs-content line
  (`biome.json` lines 9–16); coverage should mirror it.
- **`content/`'s existing quality bar is unchanged and is NOT a coverage gate.** Content
  already has a *completeness* contract — a new module without a `content/test/cases.ts`
  entry fails (`.claude/CLAUDE.md` line 57; architecture lines 248–251). That's a
  per-module merge contract, not a percentage, and it's enforced by `pnpm test:content`,
  which is **not** something an agent runs mid-session. Leave it exactly as is. Coverage
  thresholds apply to engine code only.
- **Nothing the agent runs during a session changes.** The session loop is the MCP tools
  (`save` → `get_session` → `screenshot`) plus `pnpm typecheck` at most (CLAUDE.md line 28,
  rule 3). None of these invoke the coverage gate. The gate lives in `pnpm test` / CI, which
  are merge-time concerns over `packages/`, not session-time concerns over `content/`.
- **Visual tests are opt-in and out-of-band.** If a human later wants a regression test for
  a specific scene, that's the *validator* layer (`scripts/validate-*.mjs`) or a fixture
  (`record_fixture` + byte-identical `screenshot`), authored deliberately — never required
  to ship a scene, never run inside the creative loop.

Concretely, which scripts gate and which don't:

| Script | Scope | Gates a merge? | Runs in a live session? |
|---|---|---|---|
| MCP tools (`save`/`screenshot`/…) | `content/` | no | yes — the creative loop |
| `pnpm typecheck` | `packages/*` + `content/` | yes (contract) | optional, agent's choice |
| `pnpm test` (+ proposed `--coverage`) | `packages/` | **yes — new coverage gate here** | no |
| `pnpm test:content` | `content/` | yes (completeness, not %) | no |
| `pnpm validate*` | end-to-end | local-only, not CI | no |

## Requirements

### Functional

- **FR-1 — Coverage tooling.** Add `@vitest/coverage-v8` (matching `vitest@^4.1.8`) as a
  root dev-dep. Wire a `coverage` block into the **package** vitest configs (or a shared
  base) — `runtime`, `sidecar`, `engine-app`. Provider `v8`, reporters `text` + `lcov`
  (lcov for CI artifacts/PR annotation later).
- **FR-2 — Coverage scope excludes `content/`.** The coverage `include` is
  `packages/*/src/**`; `content/**` is explicitly excluded (and `**/test/**`, `**/*.config.*`,
  generated/barrel files). The threshold gate must be *physically incapable* of measuring
  `content/`, not merely lenient about it.
- **FR-3 — Threshold gate.** Per-package (or global, see open questions) line/branch/function
  thresholds that fail `pnpm test --coverage`. **Start at a ratchet floor = current measured
  coverage** (do not invent a round number), so the gate can't regress what exists; raise
  deliberately as tests land. A green build today must stay green the moment the gate turns on.
- **FR-4 — RTL frontend tests.** Add `@testing-library/react`, `@testing-library/dom`,
  `@testing-library/user-event`, `@testing-library/jest-dom`, and a DOM environment to a
  **dedicated engine-app UI vitest project** (see FR-6). React 19 is supported by current
  RTL. Tests render real components against a fake `EngineLink` (the existing `ChannelLike`
  seam makes this clean — no real BroadcastChannel needed).
- **FR-5 — Hook tests.** Cover `src/ui/hooks.ts` (`useEngineState`, `useThumb`,
  `usePreviewFrame` — all `useSyncExternalStore` over `EngineLink`) with RTL's `renderHook`,
  driving the fake link's `subscribe`/`getSnapshot` and asserting re-render on push. These
  are the literal "hook tests" the ask names.
- **FR-6 — Two vitest environments in engine-app, kept separate.** The existing
  `environment: "node"` root must stay node (its tests — `engine-api`, `render-service`,
  modulators — are pure logic and faster without a DOM). Component/hook tests need
  `happy-dom` (or `jsdom`). Use **vitest projects/workspace** so one
  `pnpm --filter @loom/engine-app test` runs both the node suite and the UI suite under one
  command, each with its own environment. Don't flip the whole package to a DOM env.

### Non-functional

- **NFR-1 — Session latency untouched.** No new dependency, config, or hook may add a step
  to the content-creation loop. Verify by inspection: the agent loop is MCP + optional
  `typecheck`; none of FR-1..FR-6 wire into either.
- **NFR-2 — Coverage stays cheap.** v8 coverage on the package suites (~5 s today) should add
  little; if it noticeably slows `pnpm test`, gate coverage behind a `pnpm test:coverage`
  variant used in CI, with plain `pnpm test` staying fast for local dev.
- **NFR-3 — RTL deps don't reach the engine bundle.** Testing-library + DOM env are
  `devDependencies` of `@loom/engine-app` only; they must never enter the production Vite
  build (`vite build`, CI line 43 / 73–74).
- **NFR-4 — Pin like the rest.** New deps follow repo convention; nothing that ships into the
  performance browser, but pin the coverage provider to the vitest major to avoid drift.

## Test audit — what's worth building (and what isn't)

Ranked by value-per-effort, grounded in the actual files:

**Tier A — high value, build first.**
- **Hooks** (`src/ui/hooks.ts`) — small, pure-ish, central to every panel; `renderHook` +
  fake link. (FR-5.) The cleanest first win.
- **`EngineLink` edge behavior** (`src/ui/engine-link.ts`) — already has
  `engine-link.test.ts`, but coverage will show the gaps: presence/hello timeout (`HELLO_MS`,
  `STALE_MS`, lines 55–58), request timeout/correlation (`REQ_TIMEOUT_MS`), write coalescing
  via `schedule`. Pure logic, no React — extend the existing node suite, not RTL.
- **Param / chain logic** (`chain-ops.ts`, `param-groups.ts`) — already covered by
  `console-logic.test.ts`; coverage will quantify it. Keep extracting logic here as the
  preferred pattern over rendering components.

**Tier B — real value, component-level (RTL).**
- **`ParamWidget.tsx` / `ParamPanel.tsx`** — the human's mixing board; assert a slider edit
  emits the right `set_param` against the fake link, that `hidden`/advanced params toggle,
  that `labels`/`swatches` render selectors vs. sliders (the `ParamDesc` shape,
  `engine-link.ts` lines 4–29). High behavioral payoff.
- **`FxChain.tsx` + `chain-ops`** — add/remove/reorder/insert wired through the UI; the logic
  is tested, the wiring isn't.
- **`Tile.tsx` / `StageStrip.tsx` / `StageDropZone.tsx`** — staged/live badges and the
  stage interaction; ties directly to [[params-panel-alignment]] and [[console-ui-refactor]],
  which will churn this surface.

**Tier C — defer or skip.**
- **dnd-kit drag choreography** (`TileGrid.tsx` reordering) — RTL + dnd-kit drag simulation
  is brittle; assert the *reorder callback/state*, not the pointer dance. Drag fidelity
  belongs to a validator if anywhere.
- **Pixel/visual correctness of the Output window** — that's the validator layer's job
  (`pnpm validate*`), not RTL; explicitly out of scope here.
- **`content/` scenes & modules** — out of scope by the gating policy; their bar is the
  existing tier-1/2/golden suite.
- **MUI internals / theme** (`theme.ts`) — don't test the library.

## Phased plan

### Phase 1 — coverage gate over `packages/`, no new tests
1. Add `@vitest/coverage-v8`; add a shared `coverage` config (include `packages/*/src/**`,
   exclude `content/**`, tests, configs, generated barrels). (FR-1, FR-2.)
2. Measure current coverage; set thresholds to that floor (the ratchet). (FR-3.)
3. Add `pnpm test:coverage` and decide CI wiring (open question). Confirm `content/` is
   absent from the report. **This phase ships value with zero behavioral test churn** and
   proves the boundary.

### Phase 2 — hooks + extend the node suite (no RTL yet)
1. Add the engine-app UI vitest project with a DOM env (FR-6), but start with `renderHook`
   coverage of `src/ui/hooks.ts` (FR-5).
2. Push `EngineLink` coverage up via the existing node suite (timeouts, correlation,
   coalescing — Tier A).

### Phase 3 — RTL component tests (Tier B)
1. A fake-`EngineLink` test helper + `EngineProvider` wrapper for RTL renders.
2. `ParamWidget`/`ParamPanel`, then `FxChain`, then tile/stage components.
3. Ratchet thresholds up as each lands.

### Phase 4 — CI wiring & docs
1. Add the coverage step to `.github/workflows/ci.yml` (the `checks` job, after `pnpm test`).
2. Document the new layer + the packages-only boundary in `docs/architecture.md`
   §"Testing & validation" and the gating policy in `CLAUDE.md` so future agents/humans
   know the gate never touches a live session.

## Open questions

1. **Threshold numbers & granularity.** Per-package vs. one global threshold? Line-only vs.
   line+branch+function? Recommendation: per-package line+function at the measured floor,
   ratchet manually — but the starting numbers must come from a real measurement run, not
   this doc. *(Unverified: current actual % — needs Phase 1 step 2.)*
2. **CI coverage: enforce vs. report-only at first.** Land as report-only (annotation, no
   fail) for a sprint to surface the real numbers, then flip to a failing gate? Or gate from
   day one at the ratchet floor (safe, since floor = current)? The floor approach lets it
   gate immediately without risk.
3. **`jsdom` vs `happy-dom`.** The repo already depends on `happy-dom` (root, line 39) for
   content tests; reusing it keeps deps lean, but MUI/emotion are sometimes happier under
   `jsdom`. Try `happy-dom` first; fall back to `jsdom` only if MUI components misbehave.
4. **vitest projects vs. a second config file.** vitest 4 "projects" (workspace) is the
   clean way to run a node suite + a DOM suite under one `test` command (FR-6) — confirm the
   shape against vitest 4's API and the existing `vitest.scripts.config.ts` precedent.
5. **Does coverage belong in the fast `pnpm test` or a separate `test:coverage`?** Depends on
   the measured overhead (NFR-2). Default to a separate script for CI if it slows local runs.
6. **Lcov artifact / PR annotation.** Worth wiring a coverage comment in CI (like the preview
   comment, ci.yml lines 113–123), or is `text` output in the log enough for v1?
7. **Interaction with [[console-ui-refactor]] and [[params-panel-alignment]].** Both will
   reshape the `.tsx` Tier-B targets. Sequence the RTL component tests *after* (or alongside)
   those refactors so tests aren't written against soon-dead markup — or write them
   behaviorally enough to survive the refactor.

## Out of scope

- Any coverage measurement or threshold over `content/` (the whole point).
- Tests required to ship a visual, or any test step inside the agent's creative loop.
- Pixel/render correctness (validator layer; see [[validator-test-consolidation]]).
- E2E browser tests of the full Console (that's Playwright/validators, not RTL).
- Console performance assertions — see [[console-performance-stability]].
