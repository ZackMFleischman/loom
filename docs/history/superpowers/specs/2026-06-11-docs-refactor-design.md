# LOOM docs & agent-context refactor — design

**Date:** 2026-06-11
**Status:** approved (user delegated judgment calls)
**Execution note:** land on a fresh branch off `main` *after* `claude/loom-m6-palettes` merges — both CLAUDE.md files are mid-edit on that branch and this refactor restructures them.

## Problem

LOOM's documentation grew organically through M0–M6 and now works against both of its agent audiences:

- **Context cost.** A builder agent following the root `CLAUDE.md` "read in this order" list loads ~88KB before any work: root CLAUDE.md (~7.7KB) + requirements (18KB) + implementation plan (19KB) + DECISIONS (33KB) + agent-updates (18.5KB). A visuals agent auto-loads both CLAUDE.mds (~12KB) even though the root one is mostly engine architecture it must not touch.
- **Duplication → drift.** The architecture is described in three places (root CLAUDE.md, `loom/.claude/CLAUDE.md`, the implementation plan's repo sketch); all three were hand-patched separately for M6. The plan's sketch lists directories that don't exist (`content/panels/`, `fixtures/`).
- **Staleness.** README is 6 lines and says "M0–M7" (now M0–M9), no quickstart. The implementation plan reads as future tense for six shipped milestones.
- **Misplaced knowledge.** Agent-facing gotchas (TSL number-first-literal shader bug, derivative poisoning, RT-resampling pattern) are buried in DECISIONS/agent-updates instead of living in the skills where a visuals agent would hit them.
- **Catalog freshness gap.** `content/CATALOG.md` regenerates only on `pnpm typecheck`/`pnpm catalog`. In a live session an agent writes a module, exercises it via HMR, and never runs typecheck — the library's search surface is stale exactly when the next agent needs it.
- **Scratch in git.** `artifacts/` has 32 tracked files (~4.2MB) that regrow every validator run; the M0 DECISIONS entry mandating committed artifacts needs superseding.

## Principle

**One source of truth per fact; one doc per audience.**

- **Visuals agents** (live sessions, content/ territory) read only `loom/.claude/` — CLAUDE.md, skills, and the generated CATALOG.md. Nothing else enters their default context.
- **Builder agents** (working on packages/) get a slim root CLAUDE.md that points into `loom/docs/`. Deep docs are pulled on demand, not front-loaded.

## Target layout

```
ai-experiments/CLAUDE.md       slim (~30 lines): repo map, commands, conventions,
                               never-go-black in one paragraph, pointers into loom/docs/
loom/
  README.md                    real front door: what LOOM is, status, quickstart
                               (dev / console / agent session), doc map
  DECISIONS.md                 stays at root, append-only; consulted on demand
                               (grep by subsystem), no longer "read before work"
  docs/
    architecture.md            THE architecture doc (single source of truth)
    requirements-v1.md         moved from loom/ root, content unchanged
    roadmap.md                 replaces implementation-plan-v1.md
    history/
      implementation-plan-v1.md   archived verbatim
      agent-updates-m0-m6.md      archived verbatim (file retired)
    superpowers/               existing specs/plans (unchanged)
  .claude/CLAUDE.md            visuals-agent guide — role unchanged, stays the
                               single doc for that audience
  .claude/skills/              module-authoring + scene-composition, updated
```

## Components

### 1. `loom/docs/architecture.md` (new — the extraction target)

Single source of truth for how LOOM is built. Content assembled from the root CLAUDE.md Architecture section, the kernel facts duplicated in `loom/.claude/CLAUDE.md`, and the durable rationale currently only in DECISIONS:

- Package/directory layout with ownership boundaries (runtime/engine-app/sidecar = human-reviewed; content/ = agent territory).
- The kernel contracts: pull-based frame-memoized signals, the "stateful signals must be pulled every frame" rule and why instances guarantee it, TexNode vec4 discipline, effects own pass ordering, Param/Manifest write path.
- Never-go-black: all three containment layers, in full, with the rule that any swap/HMR/render-path change preserves them.
- The globals pseudo-instance pattern (rack + palettes), modulators, instance-id semantics (boot/live alias/globals).
- Validation approach: screenshot-based rationale, WebGL2-fallback caveat, scene pinning, port isolation, fail-fast-on-early-exit.
- Conventions: three pinned exact, `window.__loom` debug surface, state persistence middleware.

### 2. Root `CLAUDE.md` (slimmed to ~30 lines)

Keeps: repo orientation (2 lines), the full commands block (high value, changes rarely), the never-go-black invariant as one paragraph (the single thing no builder may violate), conventions bullets, and the doc map: `docs/architecture.md` for how it's built, `docs/requirements-v1.md` for what it is, `docs/roadmap.md` for what's next, `DECISIONS.md` greppable on demand. Logging policy (see §5).

Drops: the entire Architecture section (moves to architecture.md), the four-doc mandatory reading list.

### 3. `loom/docs/roadmap.md` (replaces implementation-plan-v1.md)

- Stack decisions that are still true (compressed).
- Shipped milestones M0–M6 as a one-line-each table (goal + validator + ship date), pointing at `docs/history/` and git history for detail.
- Full text for remaining work: M6 chains half, M7, M8, M9 — carried over verbatim from the v1.1 plan.
- Cross-cutting rules, risk table (pruned of retired risks), post-v1 horizon list.
- Old plan archived verbatim at `docs/history/implementation-plan-v1.md` (DECISIONS entries reference it by name).

### 4. `loom/README.md` (rewritten)

What LOOM is (keep the existing first paragraph — it's good), current status (M0–M6 shipped, M9 = v1), quickstart (`pnpm install`, `pnpm dev`, open `/console.html`, `?audio=test`, start Claude Code from `loom/` for the MCP server), and the doc map.

### 5. Logs: DECISIONS keeps its role, agent-updates retires

- **DECISIONS.md** stays the append-only institutional memory at `loom/` root. One-time pass: distill the agent-facing gotchas into skills/architecture.md (see §7), collapse the three post-v1 feature stubs to one-liners pointing at `feature-requests/*.md`. No aggressive rewrite — the rationale entries are the project's memory.
- **agent-updates.md** is archived verbatim to `docs/history/agent-updates-m0-m6.md` and the live file is deleted. Its job moves into DECISIONS: when milestone-level work ships, append one **"SHIPPED"** entry of ≤6 lines (date, milestone, gates run, deviations, stumbles worth knowing). One log to append to, not two.
- Reading guidance everywhere changes from "read these before work" to "grep DECISIONS when touching the relevant subsystem".

### 6. Catalog auto-generation (`loom:catalog` Vite plugin)

The one code change. A sibling plugin to `loom:watch-content` in `packages/engine-app/vite.config.ts`:

- On watcher `add`/`change`/`unlink` events for files under `content/modules/` and `content/scenes/`, debounce ~300ms, then spawn `node scripts/build-catalog.mjs` (child process — keeps the script standalone, no refactor of the generator).
- Log regeneration to the Vite server console; a generator failure logs and is otherwise swallowed (a broken half-written module must not break the dev server).
- `pnpm typecheck` keeps the regeneration hook; `pnpm catalog --check` stays the staleness gate.
- Result: CATALOG.md is always fresh while `pnpm dev` runs — which is the only time a visuals agent exists.

Agent-facing text (skills, CLAUDE.mds) changes to: "CATALOG.md regenerates automatically (dev server + `pnpm typecheck`); never edit it by hand" — and the module-authoring checklist no longer frames catalog freshness as the agent's job.

### 7. Skills updates

- **module-authoring:** add a "shader gotchas" section — TSL number-as-first-arg builds silently broken shaders (`mix(float(1), …)` wrap rule), derivative poisoning (guard with small node-first offsets, not huge sentinels or number-first `step`), pointer to `glitch.ts` for RT-resampling stays. Catalog wording per §6.
- **scene-composition:** catalog wording per §6; already palette-current otherwise.
- **`loom/.claude/CLAUDE.md`:** role unchanged; catalog wording per §6. Its architecture map stays (it's audience-scoped and cheap) but is noted as a summary of `docs/architecture.md`.

### 8. Artifacts gitignored

- Add `artifacts/` to `loom/.gitignore`; `git rm -r --cached artifacts`.
- Superseding DECISIONS entry: evidence for a milestone = validator pass/fail output + locally regenerable screenshots; nothing committed. (Validator `*.log` files are already ignored.)

## Execution phases

Each phase leaves the repo consistent; typecheck green throughout.

1. **Scratch out of git:** gitignore + untrack `artifacts/`.
2. **New docs in:** write `docs/architecture.md`, `docs/roadmap.md`, new `README.md`; move `requirements-v1.md`; archive old plan + agent-updates under `docs/history/`; delete `implementation-plan-v1.md` and `agent-updates.md` from root.
3. **Pointers flip:** slim root `CLAUDE.md`; update `loom/.claude/CLAUDE.md` + both skills (gotchas in, catalog wording); fix any cross-references (validators, feature-requests, superpowers plans) to moved files.
4. **Catalog plugin:** implement `loom:catalog`, verify live regen headed/headless, run the full validator suite (the only phase touching code).
5. **Memory updated:** DECISIONS pass (gotcha distillation, stub collapse) + new dated entry documenting this refactor and the new logging/artifacts policy.

## Error handling / risks

- **Broken references:** phase 3 includes a repo-wide grep for `requirements-v1.md`, `implementation-plan-v1.md`, `agent-updates.md` paths.
- **Catalog plugin failure mode:** generator errors are logged and swallowed; the dev server and HMR path (never-go-black layer 1) are untouched — the plugin only spawns a child process on watcher events it already receives.
- **Validator coupling:** docs phases can't break validators; phase 4 re-runs m0–m6 + modulators as the gate.

## Out of scope

- Rewriting requirements-v1.md (still accurate with §11).
- Any change to runtime/sidecar/protocol.
- New skills for builder agents (root CLAUDE.md + architecture.md cover that audience).
- Restructuring `feature-requests/` (already serving its purpose).
