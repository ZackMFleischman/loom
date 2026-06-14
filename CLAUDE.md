# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository

**LOOM** is an AI-driven live-visuals instrument: you describe visuals in natural language, agents write typed TypeScript, and the engine hot-renders it the moment the file is saved.

This file stays slim: orientation, the never-go-black invariant, the command surface, and conventions. **Never restate architecture here** — `docs/architecture.md` is the single source; link it, don't copy it.

Doc map (pull on demand, don't pre-read):
- `docs/architecture.md` — how it's built: layout, kernel contracts, the "Testing & validation" section (all four test layers: when/why/how). **Read before changing `packages/`.**
- `docs/requirements-v1.md` — what LOOM is; its §8 out-of-scope list is load-bearing.
- `docs/roadmap.md` — what's shipped, what's next.
- `docs/debugging.md` — instrumentation & debugging tooling: `get_diagnostics` + the perf rollup (agent), FPS meters / `window.__loom` / URL knobs / loop guard (human), the four test layers + coverage gate (developer).
- `DECISIONS.md` — append-only decision log. Grep it when touching an unfamiliar subsystem; add an entry for non-obvious decisions; when milestone-level work ships, append a ≤6-line SHIPPED entry (date, gates run, deviations, stumbles).
- `.claude/CLAUDE.md` + skills — the in-session visuals-agent guide (content/ territory).

## Never go black

No agent action, compile error, or bad edit may interrupt the live output. Three containment layers: Vite withholds broken HMR updates (overlay disabled); a throwing `build()` never touches the running instance (NFR-5 `trySwap`); a render-time throw freezes that instance while the engine keeps ticking (NFR-2). **Preserve all three in any change to the swap/HMR/render path** — full detail in `docs/architecture.md`.

## Commands

All commands run from the repo root (pnpm workspace):

```
pnpm install            # install (uses pnpm workspaces)
pnpm dev                # start the engine app (Vite dev server, Output window)
pnpm sidecar            # start the MCP/WS sidecar standalone (Claude Code spawns it via .mcp.json)
pnpm typecheck          # regenerates content/CATALOG.md, then tsc --noEmit over packages/* and content/ — the contract gate
pnpm catalog            # regenerate content/CATALOG.md alone (--check exits 1 if stale)
pnpm test               # package unit tests (runtime/sidecar/engine-app) + content stdlib tests
pnpm test:content       # stdlib module tests alone: tier-1 contract, tier-2 extremes, golden patterns
pnpm validate           # ALL acceptance suites below in order (stops on first failure)
pnpm validate:core      # Boot smoke + the single canonical MCP tool-surface check (shared by all full-stack suites)
pnpm validate:m0        # M0 acceptance: Playwright + headless Chromium HMR checks
pnpm validate:m1        # M1 acceptance: signals/audio-reactivity/containment checks
pnpm validate:m2        # M2 acceptance: MCP client e2e (agent tools + latency)
pnpm validate:m3        # M3 acceptance: stage/commit/PANIC loop via MCP + Console
pnpm validate:m4        # M4 acceptance: pure output, cover scaling, set_audio, staging UX
pnpm validate:m5        # M5 acceptance: input rack, globals manifest, persistence, MIDI-learn
pnpm validate:m6        # M6 acceptance: palettes retint live, source switch with no rebuild
pnpm validate:layers    # Layers acceptance: ctx.layer nodes, rig rides with no rebuild, per-node chains
pnpm validate:projects  # Projects acceptance: set-list save/load round-trip, audience-safe load, deferred cull
pnpm validate:m9        # M9 acceptance: video sources play/freeze/scrub/loop live, media middleware (Range/roots)
pnpm validate:fixtures  # Fixtures acceptance: record/replay input traces, byte-identical screenshot({frames})
pnpm validate:m7        # M7 acceptance: geo path — gltf/FBX models, orbitCam, render3d bridge, frame-time HUD
pnpm validate:m8        # M8 acceptance: particles off mesh surfaces, turbulence, chain commit, fixture determinism
pnpm validate:m11       # M11 acceptance: catalog columns, hot-register a module mid-run, parallel sandboxes
pnpm validate:modulators # param-modulator acceptance: attach/clear via MCP, FR-4/5/7/10 behavior
pnpm validate:panic     # PANIC acceptance: arm/hold/scene paths (split out of the m3 family)
pnpm validate:stdlib    # tier-3 smoke render: every module hot-swapped in, non-black + clean console
```

Validators pin `pulse` as their live scene (restoring the real one afterwards) and run their sidecars on isolated ports — safe to run while a live session is up. Single test file: `pnpm --filter @loom/runtime exec vitest run test/signal.test.ts`.

Milestone work merges only with typecheck green, `pnpm test` green, and `pnpm validate` still passing. Full picture of the four test layers (what each can and can't see, when to run what): the "Testing & validation" section of `docs/architecture.md`. New modules merge with a `content/test/cases.ts` entry — the completeness test enforces it.

## Conventions

- `packages/*` changes get human review; `content/` is agent territory.
- `three` is pinned **exact** — don't bump it casually.
- `window.__loom` is the engine debug surface validators read; keep it updated when adding engine state.
- `content/CATALOG.md` and validator screenshots (`artifacts/`, gitignored) are generated — never hand-edit, never commit artifacts.
- New ideas outside v1 scope go to `DECISIONS.md` as post-v1 candidates (detail in `feature-requests/`).

## Screenshots in PRs

When a PR introduces or changes anything **visual** — a feature, the Console, a scene, a visualization — it **SHOULD** include a relevant screenshot in the PR body. Don't make a reviewer run the app to see what you changed.

Commit images to the tracked dir **`preview/screenshots/`** and embed them via `raw.githubusercontent.com` URLs, which render on GitHub and on phones (no preview deploy needed):

1. **Make the image.** Render a scene still (recommended), or drop in any PNG:
   ```sh
   node scripts/shoot.mjs pulse lava     # writes preview/screenshots/<scene>.png
   ```
2. **Commit it** on your PR branch: `git add preview/screenshots/<name>.png && git commit`, then push.
3. **Embed it** in the PR description with a raw URL pinned to the **commit SHA** (stable — survives rebases/force-pushes) or the **branch** (auto-updates):
   ```md
   ![pulse](https://raw.githubusercontent.com/ZackMFleischman/loom/<sha-or-branch>/preview/screenshots/pulse.png)
   ```

Full mechanics (shoot env knobs, the automated per-PR preview screenshots): `docs/ci-and-preview.md` → "Screenshots in the PR".
