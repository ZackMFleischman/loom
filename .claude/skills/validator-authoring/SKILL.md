---
name: validator-authoring
description: Use when writing or editing a LOOM acceptance validator (scripts/validate-*.mjs) — the isolation contract, flake-proof assertion patterns, and cleanup rules that every suite must follow.
---

# Validator authoring

A validator is a Playwright + headless-Chromium script proving a milestone's
behavior against real pixels. Every flake pattern below cost a debugging
session — follow them, don't rediscover them. `validate-m6.mjs` and
`validate-fixtures.mjs` are the reference shapes.

## The isolation contract (non-negotiable)

- **Own ports**: a unique Vite port AND sidecar WS port (`LOOM_WS_PORT` env +
  `?ws=` on the page URL). Grep existing scripts and take the next free pair —
  validators must be safe to run while a live performance session is up.
- **Pin the boot scene**: save `live.scene.ts`, write your pin (usually
  `export { default } from "./pulse.scene";`), ALWAYS restore in `finally`.
- **State**: boot with `?state=off` unless persistence is under test; if your
  run writes ANY state file (fixtures, projects, media-roots), back up the
  whole `content/state/` tree first and restore it in `finally`.
- **Temp content files** (scenes/modules/chains you write for the run): delete
  in `finally` AND rerun `scripts/build-catalog.mjs` — the dev server
  regenerated the catalog while your file existed; the repo must not keep the
  stale entry.
- Fail fast if Vite exits early (port collision) — race `waitForServer`
  against the process exit, or you'll validate against a stale server.
- `?embed=0` on any console.html page — an embedded engine would dial the
  DEFAULT sidecar port and break isolation. Use `forceWebGL2` + `glArgs` from
  `_browser.mjs`; add `--use-fake-device-for-media-stream` if camera/mic
  modules are exercised.

## Flake-proof assertions

- **Poll, never read once.** UI state (Console tiles, button labels) refreshes
  at ~10 Hz — a single `$eval` after an engine-state flip races the render.
  Use `page.waitForFunction(...)` or a `waitFor` loop. (The m4 staged-button
  check flaked twice before becoming a DOM poll.)
- **waitFor fns must swallow transient errors**: a screenshot of a just-created
  instance can race its first render (uninitialized target readback throws) —
  `try { … } catch { return null; }` inside the poll, never outside.
- **Pixel checks**: compare REGIONS or mean-absolute per-pixel diffs, not
  averages of full frames — a rotating symmetric object barely moves the mean.
  Crank the motion via `set_param` before comparing frames. Thresholds are
  calibrated on the WebGL2 fallback (headless has no WebGPU).
- **"No rebuild" assertions** ride the per-instance `builds` counter from
  `get_session` — never inference from pixels.
- **Tool-surface assertions move with behavior**: when a milestone adds MCP
  tools, the exact-list checks in older validators (m3/m4/m5/modulators) must
  be updated in the same change — same coverage, new expectation. Checks are
  never deleted or weakened to get to green.
- Machine-specific assets (the hippo FBX): gate those checks on `existsSync`
  and print `SKIP …` — validators must pass on a fresh clone; commit micro
  test assets (tiny clip.mp4 / cube.glb) for the portable paths.

## Skeleton

Copy a recent validator wholesale; the load-bearing pieces are: scene pin +
state backup → spawn Vite (race exit) → connect MCP client over stdio
(`--import tsx packages/sidecar/src/index.ts`, `stderr: "pipe"`) → launch
Chromium with `glArgs` → `waitForFps(outputPage)` → waitFor get_session →
checks (`check(name, ok, detail)` accumulating into a results array) →
`finally`: close client/browser, taskkill the Vite TREE on win32, restore
scene + state, regenerate catalog → exit 1 if any check failed.

Wire it up: add `validate:<name>` to package.json AND append it to the
`validate` chain; mention it in the architecture doc's validator list.
