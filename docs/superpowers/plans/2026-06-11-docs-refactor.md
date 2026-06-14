# LOOM Docs & Agent-Context Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure LOOM's docs so each agent audience loads only what it needs — visuals agents get `loom/.claude/` only, builder agents get a slim CLAUDE.md pointing into `loom/docs/` — and make `CATALOG.md` regenerate automatically during live sessions.

**Architecture:** Pure docs reorganization (moves, rewrites, archives) plus one small Vite plugin (`loom:catalog`) in `packages/engine-app/vite.config.ts`. Spec: `loom/docs/superpowers/specs/2026-06-11-docs-refactor-design.md`.

**Tech Stack:** Markdown, git mv, one TypeScript Vite plugin (child-process spawn of the existing `scripts/build-catalog.mjs`).

**Branch:** all work on `claude/loom-docs-refactor` off `main`. Do not merge to main; leave for human review.

**Coordination note:** the worktree `.claude/worktrees/m6-color-chains` carries in-flight M6 chains work whose plan appends to `agent-updates.md` and edits the old CLAUDE.md layout. After this refactor merges, that branch needs a rebase and its doc-update steps redirected (ship entry → DECISIONS.md per the new policy). Nothing in this plan blocks on it.

**Paths:** all relative to `loom/` unless prefixed `ROOT/` (= `ai-experiments/`).

---

### Task 1: Branch + gitignore artifacts

**Files:**
- Create: `.gitignore`
- Untrack: `artifacts/` (32 files stay on disk)

- [ ] **Step 1: Cut the branch**

```bash
git checkout -b claude/loom-docs-refactor main
```

- [ ] **Step 2: Create `loom/.gitignore`** (file does not exist today; `*.log` is already covered by `ROOT/.gitignore`)

```gitignore
# Validator screenshots/evidence — local scratch, regenerable by any validate:m* run.
artifacts/
```

- [ ] **Step 3: Untrack artifacts without deleting them**

Run from `loom/`: `git rm -r --cached artifacts`
Expected: 32 `rm 'loom/artifacts/...'` lines; `Get-ChildItem artifacts | Measure-Object` still counts the files on disk.

- [ ] **Step 4: Verify ignore works**

Run: `git status --short` → shows `D` entries for artifacts + new `.gitignore`, and **no** `??` entries for artifacts.
Run: `git check-ignore artifacts/m0-initial.png` (any artifact file) → prints the path (exit 0).

- [ ] **Step 5: Commit**

```bash
git add .gitignore
git commit -m "Docs refactor: artifacts/ is local scratch, not committed evidence"
```

---

### Task 2: Create `docs/architecture.md`

**Files:**
- Create: `docs/architecture.md`

Content is assembled from `ROOT/CLAUDE.md` §Architecture (lines 45–80), the kernel facts in `.claude/CLAUDE.md`, and durable DECISIONS rationale. It becomes the single source of truth; later tasks delete the originals.

- [ ] **Step 1: Write `docs/architecture.md` with exactly this content**

````markdown
# LOOM architecture

How LOOM is built. This is the single source of truth — the root `CLAUDE.md` and
`loom/.claude/CLAUDE.md` carry summaries that defer here. For *what* LOOM is, read
`docs/requirements-v1.md`; for what's next, `docs/roadmap.md`; for why a decision
was made, grep `DECISIONS.md`.

## Layout

- `packages/runtime` (`@loom/runtime`) — the kernel: Signal, Events, Param/Manifest
  (including the `color` param type), Module/Scene definitions, TexNode, BuildCtx,
  Instance, InputBus (TimeBus/AudioBus/MidiBus), the input rack (`defineInputs`/
  `InputRegistry` — named tunable channels on a globals Manifest, consumed late-bound
  via `ctx.input(name)` with auto trim params), `PaletteRegistry` (two global 5-stop
  palettes consumed via `ctx.palette`), `ModulatorHost`/`ModulatorSpec` (attachable
  param modulators), and `BindingStore` (MIDI-learn bindings keyed by scene name).
  Unit-tested in Node with a fake clock. **Changes here get human review.**
- `packages/engine-app` — the Vite app, three pages: the Output window at `/`
  (render loop, multi-instance `SessionStore`, `Compositor` for crossfades, HMR via
  the eager scenes barrel `scenes.ts`, sidecar bridge), the Console cockpit at
  `/console.html` and `/staged.html` (big preview of the staged instance) — both
  React 19 + MUI sibling pages talking to the engine over `BroadcastChannel("loom")`
  via the framework-free `EngineLink` client. The Output window itself stays vanilla
  (a pure projector surface): no overlay (`?hud=1` reveals the fps readout — the
  element stays in the DOM, validators gate on its text), fixed 1920×1080 internal
  render (`?res=WxH`) scaled with CSS `object-fit: cover` (never warped). One
  `EngineApi` dispatch serves agent (WS) and human (channel) commands, source-tagged:
  agent `commit` requires arming (Console toggle or `?agentCommit=1`);
  `panic`/`resume`/`set_audio`/`arm_agent_commit`/`midi_learn`/`midi_unbind` are
  human-only. The Console has instance tiles with drag-to-stage, a scene picker, an
  audio-source picker, the auto param panel (with per-param modulator popovers and
  MIDI-learn buttons), a rack drawer on `i`, and COMMIT/PANIC.
- `packages/runtime`'s `Stage` is the audience-safety core: LIVE changes only via
  `commit()` (frame-boundary crossfade; PANIC holds the last frame and cancels
  fades). Instances render exactly once per frame to a directive-chosen destination
  (canvas, crossfade leg, or preview target).
- `packages/sidecar` — agent surface: MCP server over stdio (11 tools: `get_session`,
  `get_manifest`, `set_param`, `modulate_param`, `clear_modulation`, `screenshot`,
  `create_instance`, `destroy_instance`, `stage`, `unstage`, `commit`) bridged to the
  engine over WebSocket (port 7341; `LOOM_WS_PORT` + `?ws=` override for isolation).
  The wire contract is `@loom/sidecar/protocol` (browser-safe, shared with the
  engine via tsconfig path + Vite alias). The sidecar's stdout belongs to MCP — log
  to stderr only. `loom/.mcp.json` registers it; `loom/.claude/` holds the in-engine
  agent rules and skills (start LOOM agent sessions from `loom/`).
- `content/` — scenes, modules, and `inputs.ts`. **This is agent territory.**
  `content/` lives outside any package; it imports `@loom/runtime` via tsconfig
  `paths` plus a matching Vite alias in `engine-app/vite.config.ts`. One root
  `tsconfig.json` drives typecheck for everything (no project references).
  `content/scenes/live.scene.ts` is a one-line re-export of the boot scene. Every
  scene file is HMR-watched through the barrel; instances rebuild only when their
  own scene's module identity changes.
- `content/CATALOG.md` — generated index of every module + scene
  (`scripts/build-catalog.mjs`, AST-extracted so Node never imports `three`).
  Regenerates automatically: the `loom:catalog` Vite plugin reruns it on any
  module/scene file change while the dev server runs, and `pnpm typecheck` reruns
  it as the offline gate (`pnpm catalog --check` exits 1 on staleness). Never edit
  by hand.
- `scripts/validate-m*.mjs` — screenshot-based acceptance checks. Their screenshots
  land in `artifacts/` (gitignored local scratch); the evidence of a milestone is
  the validator's pass/fail output.

## Instance ids

The boot instance (bound to `live.scene.ts`) is `"boot"`; created ones are
`"<scene>-<n>"`. `"live"` is an **alias** resolving at dispatch to whatever the
Stage routes to output. `"globals"` is a pseudo-instance serving the input rack's
tunings **and** the palette stops through the same `get_manifest`/`set_param` path
(routed by prefix: `palette.*` → palettes, else rack).

## The kernel (pull-based, frame-memoized)

`Signal.get(f)` / `Events.poll(f)` memoize on `f.frame` (the per-frame `FrameCtx`
from `Clock.tick`). Consequence — a documented contract, not a bug: **stateful ops
(lag, envelope, divide, quantize, onset detectors) must be pulled every frame or
they miss time.** Instances guarantee this because every CPU signal reaches the GPU
through a registered uniform updater that runs each frame (`BuildCtx.uniformOf`).

- Modules: `defineModule(meta, factory)` with zod-validated metadata (`name`,
  `kind: control|source|effect|geo|output`, `description`, `tags`, `example`).
  Factory signature: `(ctx: BuildCtx, opts) => TexNode | Signal`. Stdlib bar:
  ≤ ~150 lines, fully typed, one-line description + usage example — written as much
  for agents as for humans.
- `TexNode.color` is strictly TSL `Node<"vec4">` — sources normalize to vec4 once;
  looser unions fight `@types/three` overloads.
- Effects own pass ordering: a stateful effect (e.g. `feedback`) returns
  `[...input.passes, ownPass]`; the Instance just runs the list. No graph scheduler.
- `Param`/`Manifest`: zod-validated, clamped, serializable. Collected by `BuildCtx`
  at build time; written live through `set_param` (MCP), the Console's param panel,
  and MIDI bindings — all through `Manifest.get(path).set(value)`. The `color` type
  holds `"#rrggbb"`; its clamp **throws** on non-hex (state-restore paths try/catch
  each set), `setNormalized` is a no-op on it, and modulators reject color params at
  attach. Ranged specs may carry `labels` (value names) which the Console renders as
  a toggle group instead of a slider.
- InputBus: `TimeBus` (BPM is manual — `?bpm=` or tap `t`; beat tracking is
  post-v1), `AudioBus` (mic, or synthetic test audio via `?audio=test` — also the
  automatic fallback when getUserMedia fails; feeds the same AnalyserNode path as
  the mic), and `MidiBus` (WebMIDI CC state, hot-plug;
  `window.__loom.midiInject(cc, ch, v)` feeds the same path for mocked hardware).
- The input rack: channels are code-defined in `content/inputs.ts`
  (`level`/`onset`/`cc` kinds), advanced once per frame by the engine
  (`InputRegistry.update`) so meters work with zero consumers; scenes consume with
  `ctx.input(name)` (late-bound — retune/redefine never rebuilds). Trims, not
  overrides: a differently-detected kick is a new named channel. Redefinition
  carries tuned values and detector state forward by channel name+kind; a throwing
  `defineInputs` keeps the previous rack.
- Palettes: `primary`/`secondary` global 5-stop palettes on the globals manifest
  (`palette.primary.0` …). Scenes consume via `ctx.palette.color(i)` (vec3 stop
  uniform), `ctx.palette.ramp(t)` (256×1 DataTexture gradient), `ctx.palette.own()`
  (scene-default stops). Any use auto-declares a `palette.source` int param
  (0 primary · 1 secondary · 2 own, declared in `BuildCtx.finalize()`), resolved per
  frame — switching palettes is a plain `set_param`, **never a rebuild**. Stop roles
  (0 bg · 1 edge · 2/3 core · 4 accent) are convention, not kernel vocabulary.
- Modulators: `modulate_param` attaches a runtime LFO/stepper/follower to any
  non-color param (sine/triangle/ramp/square/random/drift/cycle/audio;
  `periodSeconds` or BPM-tracking `periodBeats`). Phase is a dt-accumulator ticked
  by the engine before compositing and skipped while the stage directive is `hold`,
  so PANIC pauses and RESUME continues without a jump. Rebuilds reattach; orphans
  are flagged in `get_session`. `set_param` on a modulated path errors —
  `clear_modulation` first.

## Never go black (the load-bearing invariant)

No agent action, compile error, or bad edit may interrupt the live output. Three
containment layers, all in place:

1. **Compile/parse errors**: Vite withholds the HMR update (previous module keeps
   running); the Vite error overlay is deliberately disabled
   (`server.hmr.overlay: false`) so nothing paints over the Output window.
2. **`build()` throws** (NFR-5 in `trySwap`, `engine-app/src/main.ts`): the next
   instance is built fully *before* the old one is disposed; a failed build never
   touches the running instance.
3. **Render-time throws** (NFR-2, `Instance`): the throwing instance freezes its
   output; the engine loop keeps ticking.

Preserve all three properties in any change to the swap/HMR/render path. The
invariant extends sideways: a throwing `defineInputs` keeps the previous rack, and
a failed rebuild (including future chain edits) keeps the previous pixels.

## State persistence

`content/state/` holds engine-written tuned state (`inputs.json`, `palettes.json`,
`bindings.json`, `values/<scene>.json`) served by the `loom:state` Vite middleware
(`GET/POST /loom/state/<name>`), saves debounced engine-side. Per-scene values
reapply on create/rebuild (NFR-5's "params reapplied from tuned state").
`?state=off` disables load+save — all validators boot with it except m5, which
tests persistence.

## Validation approach

Acceptance checks are screenshot-based (Playwright + pngjs): reading a
WebGL/WebGPU canvas via `drawImage` returns black without `preserveDrawingBuffer`,
so checks sample composited page screenshots. Headless Chromium has no WebGPU
adapter — automated runs exercise the WebGL2 fallback; WebGPU is verified manually
in desktop Chrome. Hard-won validator rules:

- Scripts fail fast if Vite exits early (port collision) — an orphaned server once
  caused a run to silently validate against a stale module graph.
- Validators pin `pulse` as their live scene (restoring the real one afterwards)
  and run their sidecars on isolated ports (`?ws=` + `LOOM_WS_PORT`) — safe to run
  while a live session is up. Ad-hoc debug pages must pass `?ws=<isolated>` too.
- Each session entry carries a `builds` counter (1 on create, ++ per successful
  rebuild) exposed in `get_session` and `window.__loom` — assert "no rebuild
  happened" against it.

## Conventions

- `three` is pinned **exact** (per-milestone risk mitigation) — don't bump it
  casually.
- `window.__loom` in the engine app is the debug surface validation scripts (and
  pre-MCP agent eyes) read from; keep it updated when adding engine state.
- New ideas outside v1 scope go to `DECISIONS.md` as post-v1 candidates (detail in
  `feature-requests/*.md`) — the requirements' §8 out-of-scope list is load-bearing.
- `DECISIONS.md` is the append-only institutional memory: add an entry when you
  make a non-obvious decision; when milestone-level work ships, append a ≤6-line
  **SHIPPED** entry (date, milestone, gates run, deviations, stumbles worth
  knowing).
````

- [ ] **Step 2: Commit**

```bash
git add docs/architecture.md
git commit -m "Docs refactor: docs/architecture.md is the single source of truth"
```

---

### Task 3: Archive old plan, write `docs/roadmap.md`

**Files:**
- Move: `implementation-plan-v1.md` → `docs/history/implementation-plan-v1.md`
- Create: `docs/roadmap.md`

- [ ] **Step 1: Archive the old plan verbatim**

```bash
mkdir -p docs/history
git mv implementation-plan-v1.md docs/history/implementation-plan-v1.md
```

- [ ] **Step 2: Write `docs/roadmap.md`**

Open `docs/history/implementation-plan-v1.md` for the verbatim sections referenced below. The new file:

````markdown
# LOOM roadmap

What's shipped, what's next. Supersedes `docs/history/implementation-plan-v1.md`
(the original M0–M9 plan, kept verbatim for the record); requirements live in
`docs/requirements-v1.md`. Rough size: S ≈ a weekend, M ≈ 2–3 weekends, L ≈ a
focused month of evenings.

## Standing stack decisions

- TypeScript everywhere, pnpm monorepo, Vite (dev server + HMR is the deploy
  mechanism); zod for metadata validation; `tsc --noEmit` as the contract gate.
- Three.js `WebGPURenderer` + TSL (WebGL2 fallback in headless validation); the
  TexNode layer compiles to fullscreen passes on top of it.
- Plain Chrome windows + a Node sidecar (WS bridge + MCP over stdio). No Electron
  in v1 — NDI is the first thing that would force a native shell, and it's out of
  scope.
- One `"globals"` pseudo-instance serves all global state (rack tunings, palettes)
  through the existing `get_manifest`/`set_param` path.
- Tuned state persists via the `loom:state` Vite middleware to `content/state/`
  (plain JSON in git).

## Shipped

| Milestone | Goal | Acceptance |
|---|---|---|
| M0 Pixels (2026-06-09) | edit→hot-render loop, never-go-black layer 1 | `validate:m0` |
| M1 Signals (2026-06-09) | pull-based kernel, InputBus, first 6 modules, NFR-2 | `validate:m1` |
| M2 Agent eyes & hands (2026-06-10) | sidecar + MCP tools, the magic-moment loop | `validate:m2` |
| M3 Stage & Console (2026-06-10) | multi-instance, human-gated commit, PANIC, cockpit | `validate:m3` |
| M4 Clean stage (2026-06-10) | pure Output, cover scaling, `set_audio`, staging UX | `validate:m4` |
| M5 Input rack (2026-06-10) | named channels, globals manifest, persistence, MIDI-learn | `validate:m5` |
| Param modulators (2026-06-10) | runtime LFO/follower attach on any param | `validate:modulators` |
| Console React+MUI rebuild (2026-06-11) | cockpit pages on React 19 + MUI 7, EngineLink | all validators |
| M6 Color & palettes — palette half (2026-06-11) | color param type, global palettes, `ctx.palette`, source switch with no rebuild | `validate:m6` |

Details: `DECISIONS.md` (rationale), `docs/history/agent-updates-m0-m6.md`
(build diary), git history.

## Remaining

### M6 — chains half (M)

Per-instance post-effect chains: `chain: ChainStep[]` (`{ id, effect, params }`,
stable step ids) as data on the session entry, folded after the scene build
(`tex = effect(ctx, { input: tex, … })` per step — effects already own pass
ordering). **Chain edit = rebuild via NFR-5** — a throwing step rejects the rebuild
and the previous pixels keep running. Effects declare chain knobs via optional
`meta.chainParams`; step params live at `fx.<stepId>.<param>` (stable across
reorder), values stored in the chain data and re-applied after every rebuild. One
new command + MCP tool: `set_chain { instance, steps }` (full-list semantics —
attach/detach/reorder in one idempotent verb). Humans may edit the LIVE chain
directly; **agents need the arming gate to touch the LIVE chain** (non-live is
ungated). Console: collapsible FX-chain section in the param panel — step cards
with drag-reorder, "+ effect" fed by an effects barrel, per-step widgets grouped by
prefix. Output types formalized: `ModuleOutput = TexNode | Signal | Events` and a
`ChainableEffect` alias; retrofit `glitch`/`feedback`/`levels` with `chainParams`.

**Shipped when:** the chain half of `validate:m6` — `set_chain` appending glitch
makes `fx.glitch-1.*` appear in the manifest and visibly changes the preview; a
throwing chain step leaves the instance running on previous pixels; reorder
preserves knob positions. m0–m5 green.
````

Then append, **verbatim from `docs/history/implementation-plan-v1.md`**:
- the `## M7 — Library & parallel build (M)` section (lines 111–121 of the archived file)
- the `## M8 — Depth: Geo & particles (L)` section (lines 123–132)
- the `## M9 — Gig hardening (M)` section (lines 134–143)
- the `## Cross-cutting rules` section (lines 147–151), **editing the third bullet** from "Keep a `DECISIONS.md` log; future-you and future-agents both read it." to "Log non-obvious decisions and ≤6-line SHIPPED entries in `DECISIONS.md`; grep it when touching an unfamiliar subsystem."
- the `## Risks & mitigations` table (lines 153–161) **minus the WebGPU/TSL row** (the WebGL2 fallback shipped in M0 — keep the pin-three mitigation, which already lives in Conventions) — keep the HMR, audio-latency, sprawling-code, and scope-creep rows.
- the `## Post-v1 horizon (ordered candidates)` list (lines 163–171), **appending** three entries that exist as feature requests: `PANIC safe-scene mode (feature-requests/panic-scene.md)`, `Console screenshot for agents (feature-requests/console-screenshot.md)`, and demote nothing else.

Change M7/M8/M9 headings from `## ` to `### ` so they nest under `## Remaining`.

- [ ] **Step 3: Sanity-check the result**

Run: `Select-String -Path docs/roadmap.md -Pattern "M7|M8|M9|set_chain|Cross-cutting"` → all present.

- [ ] **Step 4: Commit**

```bash
git add docs/roadmap.md docs/history/implementation-plan-v1.md
git commit -m "Docs refactor: roadmap.md (shipped table + remaining milestones); old plan archived"
```

---

### Task 4: Move requirements, archive agent-updates, rewrite README

**Files:**
- Move: `requirements-v1.md` → `docs/requirements-v1.md`
- Move: `agent-updates.md` → `docs/history/agent-updates-m0-m6.md`
- Rewrite: `README.md`

- [ ] **Step 1: Move the two files**

```bash
git mv requirements-v1.md docs/requirements-v1.md
git mv agent-updates.md docs/history/agent-updates-m0-m6.md
```

- [ ] **Step 2: Prepend an archive note to `docs/history/agent-updates-m0-m6.md`**

Replace its first two lines (`# Agent build log` and the blank line after) with:

```markdown
# Agent build log (archived 2026-06-11)

Build diary for M0 through M6-palettes. **Retired:** milestone ship entries now go
to `DECISIONS.md` as ≤6-line SHIPPED entries — one log, not two.

```

(Keep everything from `Append-only progress log…` down unchanged.)

- [ ] **Step 3: Rewrite `README.md` with exactly this content**

````markdown
# LOOM

LOOM is a live-visuals instrument where the primary way you build is by talking to
an AI: you describe a visual, a control, or a behavior; agents write typed
TypeScript into a repo; the engine hot-renders it the moment it's saved; you steer
with words, mouse, and MIDI until it feels right; you save it, and the library
grows.

**Status:** M0–M6 (palette half) shipped. Remaining to v1: M6 chains, M7 library
buildout, M8 geo/particles, M9 gig hardening — see [the roadmap](./docs/roadmap.md).

## Quickstart

```sh
pnpm install
pnpm dev          # Output window on http://localhost:5173/
```

- **Output** (`/`) — the projector surface. `?audio=test` for synthetic
  kick/hats when no mic is around (also the automatic fallback); `?hud=1` shows
  the fps readout; `?bpm=120` sets tempo (or tap `t`).
- **Console** (`/console.html`) — the human cockpit: instance tiles, param
  panel, input-rack drawer (`i`), MIDI-learn, COMMIT/PANIC.
- **Staged** (`/staged.html`) — big preview of the staged candidate, for a
  second display.
- **Agent session** — start Claude Code from `loom/` so `.mcp.json` loads the
  MCP sidecar; the agent gets eyes (`screenshot`, `get_session`) and hands
  (`set_param`, `create_instance`, `stage`, …). Commits to the live output stay
  human-gated unless armed in the Console.

`pnpm typecheck` is the contract gate (it also regenerates `content/CATALOG.md`);
`pnpm test` runs unit tests; `pnpm validate:m*` are the milestone acceptance
checks. The full command list is in the root `CLAUDE.md`.

## Documentation map

| Doc | What it answers |
|---|---|
| [docs/requirements-v1.md](./docs/requirements-v1.md) | What LOOM is — spirit, concepts, functional/non-functional requirements, the agent contract |
| [docs/architecture.md](./docs/architecture.md) | How it's built — layout, kernel contracts, never-go-black, validation approach |
| [docs/roadmap.md](./docs/roadmap.md) | What's shipped and what's next |
| [DECISIONS.md](./DECISIONS.md) | Why — append-only decision log; grep it when touching an unfamiliar subsystem |
| [.claude/CLAUDE.md](./.claude/CLAUDE.md) | The in-session visuals-agent guide (MCP tools, rules, workflow) |
| [content/CATALOG.md](./content/CATALOG.md) | Generated index of every module and scene |
| docs/history/ | Archived originals: the v1 implementation plan, the M0–M6 build diary |
````

- [ ] **Step 4: Commit**

```bash
git add README.md docs/requirements-v1.md docs/history/agent-updates-m0-m6.md
git commit -m "Docs refactor: real README; requirements into docs/; agent-updates archived and retired"
```

---

### Task 5: Slim `ROOT/CLAUDE.md`

**Files:**
- Rewrite: `ROOT/CLAUDE.md` (i.e. `ai-experiments/CLAUDE.md`)

- [ ] **Step 1: Replace the whole file with exactly this content**

````markdown
# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository

`ai-experiments` is an umbrella repo. The active project is **`loom/`** — LOOM, an AI-driven live-visuals instrument: you describe visuals in natural language, agents write typed TypeScript, and the engine hot-renders it the moment the file is saved.

Doc map (pull on demand, don't pre-read):
- `loom/docs/architecture.md` — how it's built: layout, kernel contracts, validation approach. **Read before changing `packages/`.**
- `loom/docs/requirements-v1.md` — what LOOM is; its §8 out-of-scope list is load-bearing.
- `loom/docs/roadmap.md` — what's shipped, what's next.
- `loom/DECISIONS.md` — append-only decision log. Grep it when touching an unfamiliar subsystem; add an entry for non-obvious decisions; when milestone-level work ships, append a ≤6-line SHIPPED entry (date, gates run, deviations, stumbles).
- `loom/.claude/CLAUDE.md` + skills — the in-session visuals-agent guide (content/ territory).

## Never go black

No agent action, compile error, or bad edit may interrupt the live output. Three containment layers: Vite withholds broken HMR updates (overlay disabled); a throwing `build()` never touches the running instance (NFR-5 `trySwap`); a render-time throw freezes that instance while the engine keeps ticking (NFR-2). **Preserve all three in any change to the swap/HMR/render path** — full detail in `loom/docs/architecture.md`.

## Commands

All commands run from `loom/` (pnpm workspace):

```
pnpm install            # install (uses pnpm workspaces)
pnpm dev                # start the engine app (Vite dev server, Output window)
pnpm sidecar            # start the MCP/WS sidecar standalone (Claude Code spawns it via .mcp.json)
pnpm typecheck          # regenerates content/CATALOG.md, then tsc --noEmit over packages/* and content/ — the contract gate
pnpm catalog            # regenerate content/CATALOG.md alone (--check exits 1 if stale)
pnpm test               # unit tests in all packages (vitest: runtime + sidecar)
pnpm validate:m0        # M0 acceptance: Playwright + headless Chromium HMR checks
pnpm validate:m1        # M1 acceptance: signals/audio-reactivity/containment checks
pnpm validate:m2        # M2 acceptance: MCP client e2e (agent tools + latency)
pnpm validate:m3        # M3 acceptance: stage/commit/PANIC loop via MCP + Console
pnpm validate:m4        # M4 acceptance: pure output, cover scaling, set_audio, staging UX
pnpm validate:m5        # M5 acceptance: input rack, globals manifest, persistence, MIDI-learn
pnpm validate:m6        # M6 acceptance: palettes retint live, source switch with no rebuild
pnpm validate:modulators # param-modulator acceptance: attach/clear via MCP, FR-4/5/7/10 behavior
```

Validators pin `pulse` as their live scene (restoring the real one afterwards) and run their sidecars on isolated ports — safe to run while a live session is up. Single test file: `pnpm --filter @loom/runtime exec vitest run test/signal.test.ts`.

Milestone work merges only with typecheck green, unit tests green, and all prior `validate:m*` scripts still passing.

## Conventions

- `loom/packages/*` changes get human review; `loom/content/` is agent territory.
- `three` is pinned **exact** — don't bump it casually.
- `window.__loom` is the engine debug surface validators read; keep it updated when adding engine state.
- `content/CATALOG.md` and validator screenshots (`loom/artifacts/`, gitignored) are generated — never hand-edit, never commit artifacts.
- New ideas outside v1 scope go to `DECISIONS.md` as post-v1 candidates (detail in `loom/feature-requests/`).
````

- [ ] **Step 2: Commit**

```bash
git add ../CLAUDE.md
git commit -m "Docs refactor: slim root CLAUDE.md to orientation + commands + invariant + doc map"
```

---

### Task 6: Update `.claude/CLAUDE.md` + both skills

**Files:**
- Modify: `.claude/CLAUDE.md` (two edits)
- Modify: `.claude/skills/module-authoring/SKILL.md` (two edits)
- Modify: `.claude/skills/scene-composition/SKILL.md` (one edit)

- [ ] **Step 1: `.claude/CLAUDE.md` — catalog line.** Replace:

```markdown
`CATALOG.md` regenerates automatically on `pnpm typecheck` (or `pnpm catalog`); never edit it by hand.
```

with:

```markdown
`CATALOG.md` regenerates automatically — the dev server rebuilds it on every module/scene save, and `pnpm typecheck` rebuilds it as the offline gate. Never edit it by hand; it is always current in a live session.
```

- [ ] **Step 2: `.claude/CLAUDE.md` — architecture-map pointer.** Replace the line:

```markdown
## Architecture map
```

with:

```markdown
## Architecture map (summary — full detail in `docs/architecture.md`)
```

- [ ] **Step 3: module-authoring — checklist item 1.** Replace:

```markdown
1. `pnpm typecheck` passes (it also regenerates `content/CATALOG.md` from module metadata).
2. Metadata complete (name/kind/description/tags/example) — the generated catalog is the library's search surface.
```

with:

```markdown
1. `pnpm typecheck` passes.
2. Metadata complete (name/kind/description/tags/example) — the generated catalog (auto-rebuilt on save by the dev server) is the library's search surface.
```

- [ ] **Step 4: module-authoring — add a gotchas section.** Insert before the `## Golden example (source)` heading:

```markdown
## Shader gotchas (hard-won — each of these cost a debugging session)

- **Never put a plain JS number as the FIRST argument of TSL math.** `mix(1.0, node, node)` or `step(0.0, node)` builds a shader that silently fails to compile — the instance reports ok but its render target never gets written (`screenshot` errors with "reading 'format'"). Wrap leading literals: `mix(float(1), …)`.
- **Derivative poisoning:** guarding invalid UV regions with a huge sentinel (mix to 1e6) collapses texture sampling to the lowest mip everywhere (giant mosaic). Guard by adding a SMALL node-first offset instead: `local.add(behind.mul(10))`.
- **Warping effects can't re-evaluate `input.color` at a shifted UV** — the input is a node graph, not a function of UV. Render the input into an owned RenderTarget, then sample `texture(rt.texture, warpedUv)`; `content/modules/effects/glitch.ts` is the reference.
```

Then delete the now-duplicated bullet from "The contract" list (the one beginning `- **Effects that displace or warp their input** (glitch, blur, kaleido) cannot re-evaluate` …) — its content moved into the gotchas section.

- [ ] **Step 5: scene-composition — catalog line.** Replace:

```markdown
- Check `content/CATALOG.md` (generated one-line index of every module + scene) before writing inline shader code — compose existing modules first; if the look you need isn't there, add a module rather than inlining it.
```

with:

```markdown
- Check `content/CATALOG.md` (generated one-line index of every module + scene, auto-rebuilt on every save while the dev server runs) before writing inline shader code — compose existing modules first; if the look you need isn't there, add a module rather than inlining it.
```

- [ ] **Step 6: Commit**

```bash
git add .claude
git commit -m "Docs refactor: skills gain shader gotchas; catalog described as auto-regenerating"
```

---

### Task 7: `loom:catalog` Vite plugin

**Files:**
- Modify: `packages/engine-app/vite.config.ts` (imports at lines 1–4, new plugin after `watchContent` at line 16, plugins array at line 73)

- [ ] **Step 1: Add imports.** Change line 1–2:

```ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
```

to:

```ts
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
```

- [ ] **Step 2: Add the plugin** directly after the `watchContent` const (after line 16):

```ts
// content/CATALOG.md is the library's search surface, but a live session edits
// modules/scenes via HMR and never runs `pnpm typecheck` — so the dev server
// regenerates the catalog itself. Failures are logged and swallowed: a
// half-written module must never break the dev server (never-go-black's cousin).
const catalogScript = fileURLToPath(new URL("../../scripts/build-catalog.mjs", import.meta.url));
const buildCatalog: Plugin = {
  name: "loom:catalog",
  configureServer(server) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const isCatalogSource = (file: string) => {
      const n = normalize(file);
      return (
        (n.includes(`${sep}content${sep}modules${sep}`) ||
          n.includes(`${sep}content${sep}scenes${sep}`)) &&
        n.endsWith(".ts")
      );
    };
    const schedule = (file: string) => {
      if (!isCatalogSource(file)) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        execFile(process.execPath, [catalogScript], (err) => {
          if (err) server.config.logger.warn(`loom:catalog regen failed: ${err.message}`);
          else server.config.logger.info("loom:catalog → content/CATALOG.md regenerated");
        });
      }, 300);
    };
    server.watcher.on("add", schedule);
    server.watcher.on("change", schedule);
    server.watcher.on("unlink", schedule);
  },
};
```

- [ ] **Step 3: Register it.** Change line 73:

```ts
  plugins: [watchContent, stateApi],
```

to:

```ts
  plugins: [watchContent, buildCatalog, stateApi],
```

(`watchContent` first is required — it adds `content/` to the watcher this plugin listens on.)

- [ ] **Step 4: Typecheck**

Run from `loom/`: `pnpm typecheck`
Expected: PASS (also proves the catalog script still runs standalone).

- [ ] **Step 5: Live verification with a probe module.** From `loom/`:

1. `pnpm dev` in the background; wait for the Vite "ready" line.
2. Create `content/modules/sources/_probe.ts`:
   ```ts
   // Catalog-watcher probe — deleted by the same task that creates it.
   defineModule(
     { name: "_probe", kind: "source", description: "catalog watcher probe", tags: ["probe"], example: "_probe(ctx)" },
     () => null,
   );
   ```
   (The generator is AST-based — the file never needs to import or typecheck; it is deleted two steps down.)
3. Wait ~2 s, then `Select-String -Path content/CATALOG.md -Pattern "_probe"` → **match found** (and the dev-server log shows `loom:catalog → … regenerated`).
4. Delete `content/modules/sources/_probe.ts`; wait ~2 s; same grep → **no match**.
5. Stop the dev server.
6. `pnpm catalog -- --check` → exit 0 (catalog not stale).

- [ ] **Step 6: Full validator suite** (the only code change in this refactor — run everything)

Run from `loom/`: `pnpm test`, then `pnpm validate:m0` … `validate:m6`, `validate:modulators`.
Expected: all green. (Validators spawn their own Vite servers, which now also carry the plugin — its only effect is regenerating the catalog when validators pin/restore `live.scene.ts`, which is idempotent.)

- [ ] **Step 7: Commit**

```bash
git add packages/engine-app/vite.config.ts
git commit -m "loom:catalog Vite plugin: CATALOG.md regenerates on every content save during dev"
```

---

### Task 8: DECISIONS pass + refactor entry

**Files:**
- Modify: `DECISIONS.md`

- [ ] **Step 1: Collapse the verbose feature-request entry.** Replace the entire `## 2026-06-11 — Feature request: Console screenshot for agents (post-v1 candidate)` section (heading + its four bullets, 16 lines) with:

```markdown
## 2026-06-11 — Feature request: Console screenshot for agents (post-v1 candidate)

- **`screenshot_console` MCP tool** — agent eyes on the cockpit UI itself. Existing `screenshot` can't reach a sibling tab; CDP attach is the likely winner. Full analysis + candidate approaches in `feature-requests/console-screenshot.md`.
```

(The param-modulators and panic-scene candidate entries are already one-liners pointing at their feature-request files — leave them.)

- [ ] **Step 2: Append the refactor entry** at the bottom of the file:

```markdown
## 2026-06-11 — Docs refactor: one source of truth per fact, one doc per audience

- **`docs/architecture.md` is now THE architecture doc**; root `CLAUDE.md` slimmed to orientation + commands + the never-go-black paragraph + a doc map (the old "read 4 docs before work" list cost ~88KB of context per session). `loom/.claude/` stays the complete, self-sufficient surface for visuals agents.
- **`implementation-plan-v1.md` → `docs/roadmap.md`** (shipped table + remaining milestones); original archived in `docs/history/`. `requirements-v1.md` moved to `docs/` unchanged.
- **`agent-updates.md` retired** (archived as `docs/history/agent-updates-m0-m6.md`): milestone ships are now ≤6-line SHIPPED entries here — one log, not two. Durable gotchas distilled into the skills.
- **`artifacts/` gitignored** — supersedes the M0 "validation artifacts committed as evidence" decision; the evidence is the validator's pass/fail output, screenshots are regenerable local scratch.
- **`loom:catalog` Vite plugin**: the dev server regenerates `content/CATALOG.md` on every module/scene save (debounced, failures logged and swallowed), closing the gap where live sessions never run `pnpm typecheck` and the library's search surface went stale exactly when agents needed it.
- Spec: `docs/superpowers/specs/2026-06-11-docs-refactor-design.md`. The in-flight `m6-color-chains` worktree predates this layout — on rebase, redirect its doc steps (ship entry → DECISIONS, guide edits → new paths).
```

- [ ] **Step 3: Commit**

```bash
git add DECISIONS.md
git commit -m "Docs refactor: DECISIONS entry; console-screenshot stub collapsed to pointer"
```

---

### Task 9: Cross-reference sweep + final gates

**Files:** none new — verification only (fix anything the sweep finds).

- [ ] **Step 1: Sweep for stale paths.** From `loom/`:

```powershell
Select-String -Path README.md, ..\CLAUDE.md, .claude\CLAUDE.md, .claude\skills\*\SKILL.md, docs\architecture.md, docs\roadmap.md -Pattern "loom/requirements-v1\.md|loom/implementation-plan-v1\.md|loom/agent-updates\.md|\./requirements-v1\.md|\./implementation-plan-v1\.md"
```

Expected: zero matches. (Historical files — DECISIONS entries, archived docs, old superpowers plans — keep their original wording; they describe the past.)

- [ ] **Step 2: Verify nothing at loom root but the intended set**

Run: `Get-ChildItem -File | Select-Object Name`
Expected markdown: `README.md`, `DECISIONS.md` only (plus config files; `requirements-v1.md`, `implementation-plan-v1.md`, `agent-updates.md` gone).

- [ ] **Step 3: Final gates**

Run: `pnpm typecheck` → PASS; `pnpm catalog -- --check` → exit 0; `git status --short` → clean.

- [ ] **Step 4: Push the branch** (no merge — human reviews)

```bash
git push -u origin claude/loom-docs-refactor
```
