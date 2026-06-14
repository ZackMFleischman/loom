# Agent build log (archived 2026-06-11)

Build diary for M0 through M6-palettes. **Retired:** milestone ship entries now go
to `DECISIONS.md` as ≤6-line SHIPPED entries — one log, not two.

## 2026-06-09 20:10 — M0 started

- Read requirements + implementation plan. Scope for M0: pnpm monorepo, Vite engine-app, WebGPURenderer + fps meter, hardcoded `defineScene` TSL scene, HMR hot-swap with error rejection.
- Branch: `claude/add-docs-loom-folder-8s4ox5` (M0 here; M1 will be cut onto its own branch per Zack's instruction).

## 2026-06-09 20:30 — M0 scaffold complete, typecheck green

- Monorepo: `loom/` root with `packages/runtime` (minimal `defineScene` + `SceneOutput` contract) and `packages/engine-app` (Vite app: fullscreen canvas, `WebGPURenderer`, `QuadMesh` fullscreen pass, fps meter).
- `content/scenes/hello.scene.ts`: animated TSL rings scene.
- HMR: `import.meta.hot.accept` on the scene file in `main.ts`; `SceneHost.setScene` try/catches `build()` and keeps the previous scene on any throw. Vite error overlay disabled so compile errors can't paint the Output window.
- Pinned `three@0.184.0` (exact, per plan risk table). One type fix: `colorNode` must be the typed node union from `NodeMaterial["colorNode"]`, not base `Node`.
- `pnpm typecheck` green. Playwright + Chromium installed for automated visual validation (will also serve M1).

## 2026-06-09 20:42 — M0 SHIPPED: 10/10 automated acceptance checks pass

- `pnpm validate:m0` (scripts/validate-m0.mjs) spins up Vite + headless Chromium and asserts the plan's "shipped when" end-to-end:
  - initial scene renders non-black (avg luminance 137)
  - editing the scene file hot-swaps in **102 ms** (plan budget: <2 s)
  - solid-green edit visibly lands on screen (center pixel rgb(0,255,0))
  - syntax error → screen unchanged, no reload, no error overlay
  - `build()` that throws → scene rejected, previous scene stays live
  - restoring the file hot-swaps the original back in
- Screenshots of each state saved to `loom/artifacts/m0-*.png` for inspection.
- Caveats: headless Chromium has no WebGPU adapter, so the automated run exercised three's WebGL2 fallback; desktop Chrome gets WebGPU. First pixel-sampling attempt via canvas `drawImage` read black (no `preserveDrawingBuffer`) — switched to decoding Playwright screenshots with pngjs.
- Next: commit M0, cut a new branch, build M1 (Signals).

## 2026-06-09 20:45 — M1 started on branch `claude/loom-m1-signals`

- M0 committed (`1ffa145`). New branch cut per Zack's overnight instruction; M1 = type kernel + InputBus + TexNode graph + 6 stdlib modules + per-instance containment.
- Kernel is pull-based and frame-memoized (`Signal.get(frame)` / `Events.poll(frame)`) so it unit-tests in Node with a fake clock. Wrote the tests first (TDD): 43 tests across signal/events/param/module/time/onset/control — red, then implementation, then green on the first full run.
- Added a synthetic audio mode (`?audio=test`: scheduled WebAudio kick + offbeat hats through the same AnalyserNode path as the mic) so audio reactivity is validatable headlessly and demoable without mic permission.

## 2026-06-09 21:00 — M1 SHIPPED: 19/19 browser checks + 43/43 unit tests + M0 regression 10/10

- `packages/runtime` is now the real kernel: `Signal`/`Events` (gate/latch/divide/frame-quantize), `Param`+`Manifest` (zod-validated, clamped, serializable), `defineModule`/`defineScene` with zod metadata, `BuildCtx` (manifest collection + Signal→GPU-uniform bridging), `Instance` (NFR-2: render-time throws freeze the instance, engine keeps running), `TimeBus` (BPM set/tap, beatPhase, beatEvery), `AudioBus` (mic or test signal → FFT bands bass/mid/treble, RMS, threshold+refractory onset detection).
- First 6 modules in `content/modules/`: `osc`, `noise`, `lag`, `lfo` (beat-synced), `feedback` (ping-pong render targets, the first stateful GPU pass), `levels`.
- `content/scenes/pulse.scene.ts`: the "shipped when" scene — kick onsets punch ring brightness through an envelope, lagged bass rides gain, 16-beat LFO drifts palette, feedback drags trails. `live.scene.ts` re-exports the active scene (one-line switch).
- `pnpm validate:m1` proves end-to-end: onsets ~2/s from synthetic kicks, luminance pulses with the kick (spread 33.6), HMR swap 102 ms, syntax error/build-throw/render-throw all keep pixels alive — the render-throw case freezes the instance while the engine loop keeps ticking (NFR-2), exactly per spec.
- Stumbles worth knowing: (1) an aborted validation run left an orphaned Vite holding the port and the next run silently talked to the stale server — scripts now fail fast if Vite exits early; (2) `@types/three` wants `Node<"vec4">` discipline, so `TexNode.color` is typed vec4-only, which is honestly the right contract anyway.
- Param manifest exists and collects (`punch`, `trail`, `drift` on pulse) but has no UI/MCP surface yet — that's M2/M3 per plan.

## 2026-06-10 16:45 — M0+M1 merged to main; M2 started on branch `claude/loom-m2-agent-eyes`

- Cleaned up branches: all work now on `main` (GitHub default), old claude/* branches deleted. Root `CLAUDE.md` written for future sessions.
- M2 scope: sidecar (WS bridge + MCP server over stdio), 4 agent tools (`get_session`, `get_manifest`, `set_param`, `screenshot`), `loom/.claude/` conventions + 2 skills, `validate:m2`.

## 2026-06-10 17:00 — M2 SHIPPED: 14/14 MCP e2e checks, set_param median 1.3 ms (budget 100 ms)

- New `packages/sidecar`: `protocol.ts` (zod wire contract, shared with the engine via alias), `Broker` (request/response correlation, timeouts, clean engine-not-connected errors — 17 unit tests, TDD), `index.ts` (MCP low-level Server on stdio + ws server on 7341, stderr-only logging).
- Engine: `bridge.ts` WS client (2 s auto-reconnect, hooks pattern, a throwing hook becomes an ok:false response); screenshots captured same-task after render (`toDataURL`, no preserveDrawingBuffer needed); `FpsMeter.current` exposed; session formalizes the `window.__loom` debug surface.
- Agent surface: `.mcp.json` (spawns sidecar via `node --import tsx`), `.claude/CLAUDE.md` (rules: params-before-rewrites, never touch packages/, signatures-first, trust-the-net-verify-with-eyes), skills `module-authoring` + `scene-composition` pointing at golden examples (`osc`, `feedback`, `pulse.scene`).
- `pnpm validate:m2` proves the loop end-to-end as a real MCP client: 4 tools listed, clean error with no engine, session/manifest reflect pulse, set_param round-trip 1.3 ms median + clamps + visibly steers pixels (bright extreme lum 146 vs dark 102), screenshot returns the real canvas, defaults restored.
- Kernel untouched: M1's Manifest/Param/uniformOf contract was already sufficient for live param writes — M2 is pure surface.
- Not yet proven: the human-witnessed magic-moment session (ink-blob prompt in a live Claude Code session) — needs a desktop run with `pnpm dev` + this branch's `.mcp.json`.

## 2026-06-10 18:00 — M2 magic moment witnessed; M3 started on branch `claude/loom-m3-stage-console`

- Zack ran the live session: agent produced `blobs` + `lava.scene` (contract-clean) and pulled the M5 catalog forward (`build-catalog.mjs` riding `pnpm typecheck`). M2 shipped-when criterion is fully met.
- Review caught: leaving `lava` live broke m1/m2 validators (they asserted pulse). Fixed first: validators pin pulse and restore the real scene; validation sidecars use an isolated WS port (`?ws=`/`LOOM_WS_PORT`) so a live Claude Code session can never collide with a validation run.
- M3 scope: Stage state machine (runtime, TDD), multi-instance engine + crossfade compositor, `/console.html` cockpit over BroadcastChannel, 4 new MCP tools with human-gated commit, `validate:m3`.

## 2026-06-10 18:25 — M3 SHIPPED: 24/24 e2e checks; stage/commit/PANIC loop proven

- `Stage` in `@loom/runtime` (11 unit tests): frame-boundary crossfades with mix in (0,1) exclusive, duration-0 hard cuts, PANIC cancels in-flight fades, `adoptLive` for boot only.
- Engine: `SessionStore` registry + per-instance 640×360 preview targets, `Compositor` (single/crossfade/hold; instances render exactly once per frame), eager-glob scenes barrel so HMR rebuilds only instances whose def identity changed, `EngineApi` as the single dispatch for bridge (agent) + Console channel (human).
- Console (`/console.html`, vanilla DOM): tile grid with ~6.6 fps JPEG thumbnails (async GPU readback), ✓/✗ chips, LIVE/STAGED badges, click-select/dblclick-solo, auto param panel (rAF-throttled writes), BPM/tap/RMS/fps status bar, big PANIC, stage strip with COMMIT + agent-commit arm toggle.
- MCP grows to 8 tools: create_instance/destroy_instance/stage/commit — commit refuses agents until armed (Console toggle or `?agentCommit=1`); destroying LIVE is refused for everyone; panic/resume/arm are human-only at dispatch.
- `pnpm validate:m3` (24/24): candidate created+staged via MCP, slider drag writes through, blocked agent commit leaves LIVE untouched, human COMMIT crossfades never-black (mid-fade lum 165) and promotes, PANIC holds pixels (rgb drift 0.00 over 500 ms) while frames tick 145→191, LIVE destroy refused, `?agentCommit=1` path commits end-to-end.
- Stumble worth knowing: the first console render bug was a self-destroying selector (badge class toggled away then queried) — tiles now use stable `*-badge` classes with a `show` modifier.
- Not yet proven manually: human auditioning in a real browser (drag sliders, watch the projector crossfade on a second display).

## 2026-06-10 19:00 — Console polish from first human drive

- Live tile preview was black: canvas thumbnails were read outside the render task (the documented preserveDrawingBuffer pitfall, resurfaced through a new path). Render loop now mirrors the canvas into a 2D canvas same-task; validate:m3 decodes the LIVE tile thumbnail at boot and after promotion.
- "LIVE live" confusion fixed: boot instance renamed to `boot`; `"live"` is now an alias resolved at dispatch to whatever the Stage routes to output (so default-instance commands always hit what the audience sees, even after commits). Stage strip shows `id · scene`.
- Console gained a scene picker (+ instance) so the human can spawn library scenes without the agent — closes the R4.5 gap. validate:m3 now 27/27.

## 2026-06-10 19:20 — Composable content library: pulseRings + glitch modules, scene-discovery watcher fix

- New scene `pulse-glitch` shipped live (slice tearing, kick-driven RGB split, scanlines over the pulse look), then refactored with the catalog in mind: `pulseRings` (source) and `glitch` (effect, RT-resampling pattern) extracted; `pulse` and `pulse-glitch` are now thin wiring of shared modules. Catalog: 9 modules, 4 scenes.
- `loom:watch-content` Vite plugin: brand-new `*.scene.ts` files now hot-register without touching the scenes barrel (content/ is outside the app root, so the watcher never saw file adds). Verified headless.
- Skills updated (module-authoring, scene-composition): scenes-are-wiring policy, module-composing-modules, the RT-resampling effect pattern, `new Signal` combinator idiom, scene-discovery fallback. Verified by a fresh-agent planning probe (proposed a reusable `kaleido` module unprompted under time pressure).
- Gates: typecheck, 75 unit tests, validate:m0 10/10, m1 19/19, m2 14/14, m3 27/27 — all green post-refactor.
- Ops note: the Output window stopped painting mid-session (rAF throttled while occluded/minimized — frame counter froze, bridge stayed responsive). Content exonerated on both backends; window needs to be visible to resume.

## 2026-06-10 — Roadmap v1.1 + M4 SHIPPED: Clean stage (15/15 e2e checks)

- Design pass on Console/usage produced requirements R6–R9 (`requirements-v1.md` §11) and the v1.1 roadmap (`implementation-plan-v1.md`): **M4 Clean stage** (this ship), **M5 input rack** (absorbs old-M4 MIDI; named tunable channels on a `"globals"` pseudo-instance manifest), **M6 color & chains** (global palettes + per-instance post-effect chains via `set_chain`), **M7 library & panels** (old M5 + old-M4 panels/save-as), **M8 Geo** (old M6), **M9 gig hardening** (old M7, v1). Rationale logged in `DECISIONS.md`.
- Pure Output (R9.1): `#status` overlay and `overlay.ts` deleted; `#fps` hidden but ticking (validators gate on it; `?hud=1` reveals). Audio source selection moved to a Console header picker via new human-only `set_audio` (not an MCP tool; mic failure falls back to test); snapshot gains `audioDevices`.
- No more warp (R9.2): fixed 1920×1080 internal render (`?res=WxH`) + `object-fit: cover` — fills any window, crops instead of stretching, render path untouched, screenshots now stable 1080p.
- Staging UX (R9.3): drag a tile onto the stage strip to stage; staged tile's button toggles to unstage; new `/staged.html` (BroadcastChannel sibling page, per-tab request-id prefix) shows the staged instance big with COMMIT/unstage — auditioning from a second tab/display works.
- `pnpm validate:m4` 15/15 (fake-media-device flags exercise the real mic path headless; synthetic DragEvents exercise the drop target). Gates re-run green: typecheck, 75 unit tests, m0 10/10, m1 19/19, m2 14/14, m3 27/27.
- Stumble worth knowing: Playwright's `waitForSelector` never resolves on `<option>`s inside a closed `<select>` (they're not "visible") — use `state: "attached"`.

## 2026-06-10 — M5 SHIPPED: the input rack (24/24 e2e checks) on branch `claude/loom-m5-input-rack`

- Runtime (TDD, 88 unit tests total): `defineInputs`/`InputRegistry` — named `level`/`onset`/`cc` channels with tunings on a globals `Manifest` (`inputs.<name>.*`), advanced once per frame so meters work with zero consumers; `MidiBus` (WebMIDI hot-plug, CC state, `inject()` for mocked hardware); `BindingStore` (MIDI-learn, scene-keyed bindings); `Param.setNormalized`; `BuildCtx.input(name)` — late-bound consumption + auto `input.<name>.amount` trim.
- Engine: `"globals"` pseudo-instance through the existing `get_manifest`/`set_param` dispatch (zero new param machinery, as planned); `content/inputs.ts` hot-reloads with tuning/detector-state carry-over and rejection containment; tuned state persists via the new `loom:state` Vite middleware (`content/state/{inputs,bindings}.json`, `values/<scene>.json`) and per-scene values now reapply on create/rebuild — NFR-5's "params reapplied from tuned state" is finally true; `?state=off` keeps validators deterministic (m0–m4 boot with it).
- Console: input-rack drawer on `i` (live meter + tuning widgets per channel, all pointed at "globals"), MIDI-learn button on every param widget (learn → twist → `cc21` badge; click-to-unbind), header MIDI device status. midi_learn/midi_unbind are human-only and not MCP tools.
- Content: `content/inputs.ts` ships kick/hats/bass/energy/knob1; `pulse.scene.ts` promoted to `ctx.input("kick"/"bass")` with identical defaults (m1 stays green); skills + CLAUDE.md updated (rack-first audio reactivity, trims-not-overrides).
- `pnpm validate:m5` 24/24: globals manifest over MCP, snapshot meters move, rack drawer + animated meter, threshold 0.95 kills onsets in the consuming scene with **no rebuild** and recovery on restore, state files round-trip a full reload (tunings + per-scene values + bindings), mocked CC learns and rides `punch` across its range, `inputs.ts` hot-reload adds `kickTight` while keeping the tuned kick, MCP tool surface unchanged. Gates re-run green: typecheck, 110 unit tests, m0 10/10, m1 19/19, m2 14/14 (paramPaths check loosened to subset — auto-trims grew pulse's manifest legitimately), m3 27/27, m4 15/15.
- Deviation worth knowing: m2 asserted pulse's manifest as an exact three-param list; converting pulse to rack channels adds trims, so the check now asserts the original three are present. Logged in DECISIONS.md with the rest of the M5 decisions.
- Stumble worth knowing: the threshold-0.95 check flaked because the synthetic test audio scheduled all stall-missed kicks in the past at once (analyser saturation = one giant onset). The scheduler now drops missed beats; two consecutive 24/24 runs plus full m0–m4 re-runs confirm.
## 2026-06-10 — Param modulators SHIPPED (feature-requests/param-modulators.md)

- Run-time attachable modulators on any param of any instance, zero code edits: sine,
  triangle, ramp, square, random (S&H), drift (smoothed walk), cycle (forward/reverse/
  pingpong/random over explicit values, int lattices, or bool toggles), audio
  (band/rms follower). Rates in `periodSeconds` or `periodBeats` (BPM-tracking), `phase`
  staggering, `[lo, hi]` clamped inside the declared param range (FR-6).
- Kernel: `runtime/src/modulator.ts` (strict zod spec + compiled per-frame evaluators,
  zero per-call allocation) and `modulator-host.ts` (per-instance attach/tick/reattach;
  eval throws detach + flag, never reach the render loop). 26 new fake-clock unit tests.
- Engine: hosts live on SessionStore entries (FR-3), tick before compositing, skipped on
  `hold` so PANIC truly freezes and RESUME continues phase-exact (FR-10); HMR rebuilds
  reattach and report orphans through `get_session` (FR-4); `set_param` on a modulated path
  is rejected with the detach gesture named (FR-7); `get_manifest` carries per-param
  modulator configs (FR-8); `window.__loom` exposes per-instance modulator state.
- Surfaces: MCP tools `modulate_param` / `clear_modulation` (set_param trust tier — no
  arming, live allowed); Console param rows gained a ∿ button + popover (type picker,
  seconds⇄beats rate, two-thumb range, per-type extras from one descriptor table, attach/
  update/retrigger/detach) and modulated sliders animate read-only with a tinted badge.
- Gates: typecheck, 103 unit tests, validate m0 10/10 · m1 19/19 · m2 14/14 · m3 27/27 ·
  m4 15/15 · **modulators 14/14** (new acceptance: `pnpm validate:modulators`; artifacts
  `mod-hi-*.png`/`mod-lo-*.png` show a square wave on `trail` moving page luminance).
- Stumble worth knowing: sampling a 2 s sine for 1.05 s "fails oscillation" — the window
  must cover a full period before asserting a direction change.

## 2026-06-11 — Console/Staged React + MUI refactor

Rebuilt /console.html and /staged.html as React 19 + MUI 7 apps
(packages/engine-app/src/ui/): EngineLink channel client with vitest coverage,
ParamWidget/ModPopover/Rack/Tile components, dark theme matching the old
palette. Engine, runtime, sidecar, and the Output window untouched; all
validators (m0–m5, modulators) green; validate-m3's slider write updated to the
React-safe native setter.

## 2026-06-11 — M6 global color palettes (palette half)

Shipped the palette half of M6 — global, agent/human-adjustable color that
retints scenes live with zero rebuild (R7/R7.1/R7.2):
- **Kernel** (human-reviewed): `color` param type (`Param<string>`, format-
  validating clamp that throws on bad hex); `labels` meta on ranged specs
  (int-selector affordance); `PaletteRegistry` + `fillRamp` (two 5-stop palettes
  on a globals-side manifest); `ctx.palette` (`color(i)`/`ramp(t)`/`own(...)`) with
  a `BuildCtx.finalize()` hook that declares `palette.source` (int 0..2) and one
  per-frame updater resolving the active stops, re-tinting uniforms / re-uploading
  a 256×1 ramp `DataTexture` only when the resolved stops change; modulators
  reject color params; a `builds` counter per session entry.
- **Engine**: `"globals"` now serves the rack + palettes merged (routed by
  `palette.` prefix); palette tunings persist to `content/state/palettes.json`;
  all three state-restore paths hardened with per-param try/catch (a corrupt color
  can't break boot); `builds` surfaced in `get_session` + `window.__loom`.
- **Console**: color-swatch widget + `labels` toggle in ParamWidget; a GLOBAL
  PALETTES block in the rack drawer (`i`); a primary/secondary/own source selector
  in the stage strip and `/staged` header.
- **Content**: `lava` converted to `ctx.palette` (own() reproduces its ink/ember
  look); new `gradient` scene as the minimal `ramp()` consumer.
- **Also**: added `unstage` as an MCP tool (agent surface 10→11) so agents can
  drop a staged candidate without a human; updated the four tool-surface validator
  assertions accordingly.
- Gates: typecheck, 167 unit tests, validate m0 10/10 · m1 19/19 · m2 14/14 ·
  m3 27/27 · m4 15/15 · m5 24/24 · modulators 14/14 · **m6 13/13** (new acceptance:
  `pnpm validate:m6`; artifacts `m6-*.png`). `packages/runtime` changes flagged for
  human review in the PR.
- Stumbles worth knowing: (1) a stale `node_modules/.vite` cache silently served an
  old engine bundle mid-session — get_manifest read the new registry (red) while the
  scenes/`__loom` rendered the old one (default); clearing the cache fixed it, and
  it's the same stale-module-graph hazard the architecture notes warn about. (2) the
  retint/source-flip screenshot checks needed to poll until the preview render +
  async pixel readback flush, not a single shot — "within a frame" on the GPU still
  needs a tick to reach a screenshot.
