# Architecture refactor — render-path phases (deferred from PR #16)

**Status:** proposed (deferred) · Captured: 2026-06-14 · Context: PR #16

PR #16 landed five phases of an architecture refactor (lint, typed paths, state
schema, console-logic extraction, and — pre-merge — a handleRequest split). Two
phases were **deferred** because they touch the **never-go-black render path**,
which can't be validated in the cloud sandbox (the Playwright Chromium download
is blocked and GitHub Actions doesn't run on this repo). They should be done on
a machine where `pnpm validate` runs on a real GPU.

See `DECISIONS.md` (the "Architecture refactor — Phase N" entries) for the full
rationale and the analysis behind each item.

## Phase 3 — decompose `main.ts`

`packages/engine-app/src/main.ts` is a ~1000-line module-scoped script with ~57
top-level bindings holding ~7 responsibilities (renderer/bus construction, the
MIDI-permission dance, persistence, MIDI→param routing, the fixtures
record + deterministic offline-shots, projects, panic-instance management, state
loading, the frame loop, and the `window.__loom` debug surface). Almost none of
it is unit-tested — only the screenshot validators exercise it — and the boot
sequence is implicit in statement order.

**Goal:** extract testable units, leaving `main.ts` a thin composition root.

- **`EngineCore` / `RenderService`** — owns `{ renderer, session, stage,
  compositor }` + the frame loop. The `frameTick` **ordering constraints**
  (cull → render → mirror → screenshot → preview; bind the destination RT before
  passes) move here, documented, with a test asserting the order.
- **`FixtureService`** — record + the ~110-line deterministic offline-shots
  (`screenshot { frames }`). Isolated and unit-tested against a mock renderer.
- **`PanicController`** — the warm-instance management (`tryBuildPanic`,
  `setPanicInstance`, `panicSceneInfo`, `panicInstanceId`).
- **`MidiRouter`** — the `writeParam` / `setModEnabled` / `onCc` routing.
- **`DebugSurface`** — the `window.__loom` rebuild, now **throttled** (folds in
  the per-frame allocation cleanup: `[...session.entries.values()].map(...)`
  with nested `.list()`/`.map()` runs every frame today for a surface validators
  read occasionally).
- **`ProjectsController`** — the `main.ts`-side glue over the existing tested
  `ProjectStore`.
- An explicit, ordered **boot sequence** replacing the implicit statement order.

**Risk:** highest of the refactor — this is the swap/HMR/render path. Mitigate by
extracting incrementally (one unit per commit), preserving the three never-go-black
containment layers, and running `pnpm validate:m0` + `validate:m1` after **every**
extraction, not just at the end.

## Phase 6 — TSL adapter seam

The kernel welds directly to `three/tsl` + `three/webgpu` across `texnode`,
`instance`, `buildctx`, `chain`, `layer`, `palette`, and `geo`, yet `three` is
pinned **exact** (a flagged upgrade risk). A `three` major bump touches all of
those at once with no insulating layer.

**Goal (minimal version):** route the kernel's TSL primitives (`uniform`,
`texture`, `mix`, `vec4`, the node types) through one `tsl.ts` adapter module so
the coupling surface is visible and swappable in one file. A full abstraction
layer is **not** proposed — its payoff only lands on an actual upgrade and it
risks over-engineering. Verify with the full `pnpm validate` (it touches the
render-bearing kernel).

## Note — Phase 4 was superseded by the merge

Phase 4 (splitting `engine-api.ts`'s `handleRequest` switch into per-command
methods) was reverted during the PR #16 ↔ `main` merge: `main` actively develops
that file as a `switch` (it added `set_params` / `batch` / `set_preview` there),
so the method-extraction fought the grain and re-conflicted on every `main`
change. The merge kept `main`'s switch form and re-applied Phase 1's path
helpers. If the per-handler structure is still wanted, it should be re-proposed
against the current switch — but the switch is the form being maintained, so
this is **not** recommended as a standalone refactor.
