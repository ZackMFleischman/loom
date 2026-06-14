# Audit & consolidate validator tests

Status: requested (2026-06-13) · Owner: unassigned

## Summary

The acceptance validators (`scripts/validate-*.mjs`, run via `pnpm validate`) are
LOOM's slowest test layer — `docs/architecture.md:271` quotes **~6 min** for the
full run, against ~5 s for unit tests and ~3 s for stdlib content tests. The cost
is structural, not algorithmic: **17 suites, each a standalone Node script that
boots its own Vite dev server, spawns its own MCP/WS sidecar, and launches its own
headless-Chromium browser** — three cold starts × 17, serially, because the chain
stops on first failure. The actual assertions are fast; the boots dominate.

This request audits that layer and proposes consolidation that **cuts the number
of cold boots without losing a single check**. The two big levers are a shared
harness (one set of helpers instead of 17 copies of `check`/`waitFor`/`avgColor`/
the spawn+teardown dance) and a shared **fixture** that boots the engine + sidecar
+ browser **once** and runs several suites against it. Coverage is sacred: per the
architecture doc and [[validator-authoring]], checks move with behavior, never get
deleted or weakened to go green. See also [[frontend-tests-coverage-gate]] (the
coverage-gate side of the same "make our test story faster + tighter" effort),
[[console-performance-stability]], and [[app-instrumentation]].

## Current-state inventory

Enumerated from `scripts/` (line counts via `wc -l`). The `validate` chain in
`package.json:15` runs these **17** suites in order:

| Suite | Lines | Boots | What it asserts (one line) |
|---|---|---|---|
| `validate-m0.mjs` | 214 | Vite + browser | HMR / never-go-black containment (no MCP) |
| `validate-m1.mjs` | 289 | Vite + browser | signals / audio-reactivity / 3 containment modes (no MCP) |
| `validate-m2.mjs` | 304 | full stack | MCP agent loop e2e: get_session/manifest, set_param latency, screenshot |
| `validate-m3.mjs` | 397 | full stack | stage/commit/PANIC loop via MCP + Console; MCP tool-list |
| `validate-m4.mjs` | 327 | full stack | pure output, cover scaling, set_audio, staging UX; tool-list |
| `validate-m5.mjs` | 524 | full stack | input rack, globals manifest, persistence, MIDI-learn; tool-list |
| `validate-m6.mjs` | 419 | full stack | palettes retint live + per-instance chains (reference shape) |
| `validate-layers.mjs` | 351 | full stack | `ctx.layer` nodes, rig rides w/ no rebuild, per-node chains |
| `validate-projects.mjs` | 306 | full stack | set-list save/load round-trip, audience-safe load, deferred cull |
| `validate-m9.mjs` | 292 | full stack | video play/freeze/scrub/loop live, media middleware (Range/roots) |
| `validate-fixtures.mjs` | 221 | full stack | record/replay traces, byte-identical `screenshot({frames})` (reference) |
| `validate-m7.mjs` | 305 | full stack | geo: gltf/FBX models, orbitCam, render3d bridge, frame-time HUD |
| `validate-m8.mjs` | 310 | full stack | particles off mesh surfaces, turbulence, chain commit, fixture determinism |
| `validate-m11.mjs` | 275 | full stack | catalog columns, hot-register a module mid-run, parallel sandboxes |
| `validate-modulators.mjs` | 389 | full stack | modulator attach/clear via MCP, FR-4/5/7/10 behavior; tool-list |
| `validate-panic.mjs` | 351 | full stack | PANIC arm/hold/scene paths (split out of the m3 family); tool-list |
| `validate-stdlib.mjs` | 321 | full stack | tier-3 smoke render: every module hot-swapped in, non-black + clean console |

Plus the one **shared** module: `scripts/_browser.mjs` (58 lines) — GL-flag
selection (`glArgs`), the WebGPU-hiding `forceWebGL2`, and `resQuery`. That's the
*entire* shared surface today.

Totals: **~5,200 lines** of validator code; **17 Vite boots, 15 sidecar spawns
(m0/m1 are browser-only), 17 Chromium launches** per `pnpm validate`.

Note: `m11` and `panic` are in the chain but were omitted from the Commands list
in `CLAUDE.md` — a doc drift worth fixing alongside this work (open question Q6).

### What's copy-pasted across suites (verified)

Every suite reimplements the same scaffolding inline. `function check(name, ok`
appears in **all 17** files; the full-stack suites additionally each carry their
own copies of:

- `check(name, ok, detail)` → results array → final `n/total passed` + `exit 1`
  (`validate-m6.mjs:32-35`, `:417-419`).
- `waitForServer(url, timeoutMs)` polling `fetch` (`validate-m6.mjs:37-47`).
- `toolJson(res)` / `callOk(client, name, args)` MCP unwrap helpers
  (`validate-m6.mjs:49-58`).
- `waitFor(fn, timeoutMs, label)` / `waitForFps(page)` poll loops
  (`validate-m6.mjs:60-75`).
- `avgColor(res)` + `dist(a, b)` pixel helpers (`validate-m6.mjs:77-89`) —
  re-derived in nearly every full-stack suite.
- The **boot block**: pin `live.scene.ts`, snapshot `content/state/`, spawn Vite
  with `--strictPort`, race `waitForServer` against early exit, connect the
  `StdioClientTransport` sidecar on `LOOM_WS_PORT`, `chromium.launch({ glArgs })`,
  `forceWebGL2`, `goto`, `waitForFps`, wait for engine↔sidecar handshake
  (`validate-m6.mjs:91-158`).
- The **teardown `finally`**: close client/browser, `taskkill /T /F` the Vite tree
  on win32 (`SIGTERM` elsewhere), restore scene, restore state, regen catalog
  (`validate-m6.mjs:397-415`).

The copy-paste has already drifted: `validate-modulators.mjs:29` carries a
mojibake em-dash (`â€"`) the other copies don't — a textbook symptom of N divergent
forks of one helper.

### Overlapping assertions (verified)

- **MCP tool-surface lists**: m3, m4, m5, m11, modulators, and panic each
  re-assert the exact expected tool set (`validate-m3.mjs:145-153` —
  `client.listTools()...every(...)` plus a negative `!tools.includes("set_audio")`).
  [[validator-authoring]] explicitly flags these as a maintenance hotspot: a new
  tool forces edits in all of them.
- **Boot smoke** — "engine reaches FPS, get_session reflects the live scene, a
  screenshot is non-black" — is implicitly re-proven at the top of every
  full-stack suite before its real work begins.
- **Chains** are exercised in m6 *and* touched by layers (per-node chains) and
  projects (chains persisted in the set list) — same `set_chain` plumbing, three
  entry points.

## Cost analysis

The expensive part is the **cold boot**, and it scales linearly with file count:

```
cost(pnpm validate) ≈ Σ over 17 files [ vite_boot + sidecar_spawn + chromium_launch
                                        + handshake_wait + actual_checks ]
```

`actual_checks` is small (MCP round-trips are sub-100 ms by M2's own latency
assertion); the boot terms dominate. So **# full boots == # files == 17**, and
the headline lever is reducing that count. Two independent multipliers make boots
worse on CI: software WebGL2 (SwiftShader, `_browser.mjs:7-13`) renders LOOM's
heavy scenes slowly, and `LOOM_RES` downscaling (`_browser.mjs:52-58`) exists
precisely because first frames otherwise time out.

The suites are **serial-only today by construction**: ports are hand-assigned and
*collide* across suites that never run concurrently — m0 and m2 both use Vite port
`5199`; m3 and panic share `5200`/`7343`; m6 and modulators share `5203`/`7346`
(`validate-m2.mjs:19`, `validate-panic.mjs:22-23`, `validate-modulators.mjs:20-21`).
The chain's `&&` ordering is what keeps them from clashing. This is a finding, not
a bug — but it means **parallelization requires a port-allocation fix first**.

## Requirements

### Functional

- **FR-1 No coverage loss.** Every assertion that exists today still runs and
  still fails the build on regression. Consolidation merges *boots and helpers*,
  not *checks*. Net check count is conserved or grows.
- **FR-2 Shared harness module.** One `scripts/_harness.mjs` (sibling to
  `_browser.mjs`) exports the copy-pasted primitives: `check`/results/exit,
  `waitForServer`, `toolJson`, `callOk`, `waitFor`, `waitForFps`,
  `avgColor`/`dist`, and a single `bootStack({ port, wsPort, url, stateMode })`
  that returns `{ vite, client, browser, context, output, teardown }` — the
  boot block and `finally` teardown become one call each.
- **FR-3 Shared fixture for multi-suite runs.** A grouping mechanism that boots
  the stack **once** and runs several suites' checks against that one engine +
  sidecar + browser, isolating each suite's content/state side-effects so a
  shared boot doesn't leak (scene-pin, state snapshot, temp-file cleanup honored
  per group, per [[validator-authoring]]'s isolation contract).
- **FR-4 Isolation contract preserved.** Whatever the grouping, the
  [[validator-authoring]] non-negotiables hold: own ports, `?embed=0` consoles,
  `state=off` unless persistence is under test, full `content/state/` backup +
  restore when state is written, temp content deleted + catalog regenerated.
- **FR-5 Single tool-surface check.** The MCP tool-list assertion lives in **one**
  place (the boot-smoke group), not six. A new tool updates one list.
- **FR-6 First-failure behavior retained at the group level.** The chain still
  stops the run on first failure; within a shared-boot group, a failing check
  still reports and fails the run (it need not abort sibling checks in the same
  boot — that's a per-group choice, see Q3).

### Non-functional

- **NFR-1 Faster wall-clock.** Target: meaningfully fewer than 17 cold boots.
  Merging the boot-smoke + tool-surface checks into one group, and grouping the
  small kin suites (below), plausibly takes the boot count from 17 toward
  ~8–10 without touching coverage. Quantify in Phase 0.
- **NFR-2 No new flakiness.** A shared browser/engine across suites raises
  state-bleed risk; the harness must reset between suites (fresh sandbox tiles,
  `destroy_instance` cleanup, scene re-pin). Net flake rate must not rise — this
  is the primary risk (see Risks).
- **NFR-3 Readability.** A consolidated suite must stay legible — one giant
  500-line `try` block is worse than two. Prefer named check-groups (functions
  taking the shared `{ client, output, context }`) over inlining everything.
- **NFR-4 Portability unchanged.** Still passes on a fresh clone (asset-gated
  checks `SKIP` per [[validator-authoring]]) and on SwiftShader CI.

## Phased consolidation plan

### Phase 0 — measure (do this first, no code change to suites)

Instrument the real cost before optimizing: time each suite's **boot** vs.
**checks** separately (wrap `bootStack` and the check phase with timestamps; print
`[timing] boot=Xs checks=Ys`). This produces the actual boot/check split per suite
and the true # of seconds a saved boot buys. Output: a table that turns NFR-1's
"~8–10" estimate into a measured target. (Pairs with [[app-instrumentation]].)

### Phase 1 — shared harness (`scripts/_harness.mjs`), zero behavior change

Extract the verified-duplicated helpers (FR-2) into one module; rewrite each suite
to import them. Pure DRY: same boots, same checks, same ports — but ~5,200 lines
drop toward ~3,000, the mojibake-style drift becomes impossible, and every later
phase edits one harness instead of 17 files. Low risk, high leverage; land it
alone and confirm `pnpm validate` is still green before anything structural.

### Phase 2 — merge the boot-smoke + tool-surface group

Create one suite (e.g. `validate-core.mjs`) that boots once and runs: the boot
smoke (FPS + get_session + non-black screenshot) **and** the single canonical MCP
tool-list check (FR-5), absorbing the tool-list assertions currently duplicated in
m3/m4/m5/m11/modulators/panic. Each of those suites loses its tool-list check (now
covered) but keeps everything else. Removes 5 redundant tool-list assertions and
folds N boot-smokes into 1.

### Phase 3 — group kindred suites under one boot via the fixture (FR-3)

Candidate groups (all full-stack, share the same engine capabilities, modest
check counts) — exact grouping confirmed by Phase 0 timings:

- **stage/commit/PANIC family**: m3 + panic (panic was split out of m3; they share
  ports `5200`/`7343` today, a strong signal they're one boot's worth of work).
- **chains/layers/projects**: m6 (chain half) + layers (per-node chains) + projects
  (persisted chains) all drive `set_chain`; one boot, three check-groups.
- **modulators + m6 palette half**: already share ports `5203`/`7346`.

Each group = one `bootStack`, suites become `runGroupX(harness)` functions, state
reset between them. Coverage identical; boots drop by the group sizes.

### Phase 4 — optional: drop checks genuinely covered by cheaper layers

Audit each acceptance check against layers 1–3 (`docs/architecture.md:219-269`).
Anything an acceptance check proves that a unit/stdlib test *already* proves
pixel-free is a candidate to drop **from acceptance only** (the expensive layer),
keeping it in the cheap layer. Conservative by default — only drop with an
explicit "covered by `<test>`" note in the same PR. Most acceptance checks are
pixel/integration truths no unit test can see, so this is a small trim, not a
purge. (This is the seam with [[frontend-tests-coverage-gate]]: push assertions
down to the cheapest layer that can hold them.)

### Phase 5 — optional: parallelize independent groups

Only after Phase 3, and only if Phase 0 says it's worth it. Requires a real
port-allocator (kill the hand-assigned colliding constants) so groups get unique
Vite+WS pairs, then run independent groups concurrently (bounded pool — each is a
full browser + Vite + sidecar, RAM-heavy). Biggest risk surface (resource
contention can *cause* the frame-timeout flakes `LOOM_RES` was added to fight), so
it's last and gated on measurement. First-failure semantics get fuzzier under
parallelism — decide whether the chain fails fast or runs all groups and
aggregates (Q4).

## Risks & mitigations

- **State bleed across a shared boot (top risk).** One engine running multiple
  suites can leak instances, staged pointers, tuned state. *Mitigation*: the
  fixture resets between suites — destroy all sandbox tiles, unstage, re-pin the
  scene, restore state; assert a clean baseline (`get_session` shows only boot)
  before each group starts. If a group needs a pristine engine, it stays its own
  boot — grouping is opt-in, not forced.
- **Lost coverage masquerading as consolidation.** The whole point is *not* to
  lose checks. *Mitigation*: Phase 1 is behavior-preserving; Phases 2–4 require a
  before/after check-count diff in the PR and an explicit coverage note for any
  removed assertion. FR-1 is the gate.
- **New flakiness (NFR-2).** Longer-lived browsers/engines accumulate more chances
  to race. *Mitigation*: keep the flake-proof patterns from [[validator-authoring]]
  (poll never read-once, swallow transient screenshot races, `builds`-counter for
  "no rebuild"); a shared boot must not weaken any poll into a single read.
- **Harder triage.** A merged 500-line suite obscures which milestone broke.
  *Mitigation*: named check-groups + group-tagged `check()` output (`[m3] …`,
  `[panic] …`) so a failure still names its origin; NFR-3.
- **Parallelism resource contention** (Phase 5): can *introduce* the exact
  frame-timeout flakes `_browser.mjs:52-58` works around. *Mitigation*: bounded
  concurrency, measure first, keep it optional and last.
- **Reduced isolation defeats the "safe while live" property.** Validators are
  designed to run during a live performance (isolated ports). A port-allocator
  (Phase 5) must keep choosing isolated ports, never the default `7341`.

## Open questions

- **Q1** What's the *measured* boot vs. check split (Phase 0)? The whole plan's ROI
  hinges on it; the ~6 min figure (`architecture.md:271`) is a total, not a
  breakdown. (Unverified until Phase 0 runs.)
- **Q2** Can the **sidecar** be shared across suites within one boot, or must each
  suite get a fresh MCP client even against one engine? (The WS bridge connects to
  the engine page; a fresh `Client` over the same sidecar is likely cheap — but
  unverified.)
- **Q3** Within a shared-boot group, does a failing check abort the group or just
  record-and-continue? (Today each *file* aborts the *run*; finer granularity is
  now a choice.)
- **Q4** Under Phase 5 parallelism, does the run still fail fast, or run all groups
  and aggregate failures? (Fail-fast saves time; aggregate gives a full picture.)
- **Q5** Should m0/m1 (browser-only, no sidecar) stay separate, or share the Vite
  boot with a full-stack group that simply ignores the MCP client? (They're the two
  cheapest boots already — maybe not worth merging.)
- **Q6** Fix the `CLAUDE.md` Commands list to include `validate:m11` and
  `validate:panic` (both in the chain, both omitted from the doc) as part of this
  work?
- **Q7** Is a thin test runner (a tiny harness that discovers `runGroup*` exports)
  worth it over plain `node` scripts, or does that reintroduce framework weight the
  validators deliberately avoid?

## Out of scope

- Rewriting validators onto Playwright Test or any third-party runner — the
  hand-rolled scripts are deliberate (full control over boot/teardown/isolation).
  This request consolidates them in place.
- Touching the cheaper layers (unit / stdlib content tests) beyond Phase 4's
  push-down audit — their speed is already fine.
- Changing what any milestone *means* to validate; coverage is conserved (FR-1).
