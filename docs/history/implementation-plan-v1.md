# LOOM — Implementation Plan v1.1

Companion to *Requirements v1.0* (+ its §11 addendum). Ten milestones, M0–M9. **v1.1 — roadmap revised after M3 shipped:** M0–M3 below are the historical record matching their validators; M4–M9 replace the old M4–M7, folding in the post-M3 design pass (pure output + staging UX, the input rack, global palettes, post-effect chains). Nothing from the old plan was dropped — old M4 split across M5/M7, old M5→M7, old M6→M8, old M7→M9. **Every milestone ends with a runnable instrument that is strictly more useful than the last** — no milestone is pure plumbing. Rough size: S ≈ a weekend, M ≈ 2–3 weekends, L ≈ a focused month of evenings.

## Stack decisions (made now, cheap to revisit)

- **Language/build:** TypeScript everywhere, pnpm monorepo, Vite (dev server + HMR is the deploy mechanism).
- **Render:** Three.js `WebGPURenderer` + TSL for GPU material/compute; the TexNode layer compiles to fullscreen passes/render targets on top of it. (One renderer for both 2D-effect land and later 3D land.)
- **Validation:** zod for module/scene/panel metadata; `tsc --noEmit` in watch mode as the contract gate.
- **Shell:** plain Chrome window(s) + a Node **sidecar** process (WebSocket bridge + MCP server, stdio to Claude Code). No Electron in v1 — WebMIDI, getUserMedia audio, and fullscreen-on-display all work in the browser; NDI is the first thing that would force a native shell, and it’s out of scope.
- **Globals (v1.1, lands M5):** a reserved pseudo-instance id `"globals"` serves a global Manifest (input-channel tunings, palettes) through the *existing* `get_manifest`/`set_param` path. Console widgets, MCP, and MIDI-learn all reach global state with zero new param machinery.
- **Chain folding (v1.1, lands M6):** per-instance post-effect chains are data on the session entry, folded into the build after the scene (`tex = effect(ctx, { input: tex, … })` per step — effects already own pass ordering). A chain edit rebuilds through the NFR-5 containment path, so a bad chain edit can never kill the running instance.
- **State persistence (v1.1, lands M5):** a tiny Vite dev-server middleware (`POST`/`GET /loom/state/<name>` → `content/state/*.json`). Vite is LOOM’s standing server and the sidecar stays optional (R4.5); state files are plain text in git.
- **Repo layout:**

```
loom/
  packages/
    runtime/        # kernel: Signal, Events, Param, Module, Scene, TexNode, Stage, InputBus
    engine-app/     # Console + Output windows (Vite app)
    sidecar/        # WS bridge + MCP server
  content/
    modules/{control,sources,effects,geo,custom}/
    scenes/   panels/   fixtures/
    inputs.ts       # named input channels (v1.1, M5)
    state/{values,bindings}/
    CATALOG.md      # generated (rides pnpm typecheck)
  .claude/          # CLAUDE.md + skills
```

-----

## M0 — Pixels (S)

**Goal:** the editing loop exists. A scene file hot-renders in a window.

- Scaffold monorepo; Vite app with a fullscreen-canvas Output window; WebGPURenderer up; fps meter.
- One hardcoded `defineScene` rendering a TSL fullscreen shader; `import.meta.hot` wiring so saving the scene file swaps it in-place.
- HMR rejection on throw/compile-fail → keep previous module (first brick of never-go-black).

**Shipped when:** you edit `scenes/hello.scene.ts` in any editor and the window updates in <2 s; a syntax error changes nothing on screen. *(Note: Claude Code can already drive this — “make it pink and faster” works on day one, blind.)*

## M1 — Signals (M)

**Goal:** the type kernel + the world flows in. Visuals react to music.

- `runtime`: `Signal<T>` (memoized pull, per-frame eval), `Events<T>` (onset/beat streams + gate/latch/divide/frame-quantize), `Param<T>` + manifest collection, `defineModule`/`defineScene` with zod-validated metadata, instance lifecycle (build/dispose; rebuild-on-code-change policy per NFR-5).
- `InputBus` v1: `audio` (getUserMedia device picker → AnalyserNode FFT, named bands, RMS, threshold onsets; BPM = manual tap/set for now), `time` (now, dt, beatPhase, beatEvery from set BPM).
- TexNode graph: source/effect composition compiling to ping-ponged fullscreen passes; first 6 modules to prove each contract kind: `osc`, `noise`, `lag`, `lfo`, `feedback` (stateful), `levels`.
- Per-instance error containment (NFR-2).

**Shipped when:** a kick-reactive feedback scene runs off live music; killing the file mid-edit never blanks the canvas; `pnpm typecheck` gates everything.

## M2 — Agent eyes & hands (M) ← *the magic-moment milestone*

**Goal:** the full prompt→see→self-correct→tune loop, no human code.

- Sidecar: WebSocket protocol to Engine (typed messages); session store in Engine (transport, instances, manifests).
- MCP server (stdio for Claude Code): `get_session`, `get_manifest`, `set_param`, `screenshot` (engine captures canvas → PNG over WS).
- `.claude/CLAUDE.md` (architecture map, rules: params-before-rewrites, never touch `runtime/`, signatures-first) + skills: *module-authoring*, *scene-composition*.
- Latency pass: `set_param` end-to-end <100 ms.

**Shipped when:** in one Claude Code session: “make a slow-breathing ink blob that pulses on the kick, mostly monochrome” → agent writes scene + any modules, screenshots, fixes its own mistakes, tunes params — and you watched every iteration render live.

## M3 — Stage & Console (M)

**Goal:** multiple instances, safe commits, a real cockpit.

- Stage: named slots, LIVE routing, staged candidates, frame-boundary crossfade COMMIT, PANIC (hold-frame / safe scene).
- Console window: pane grid (auto tile per instance, ✓/✗ HMR chips, click-select, double-click solo), status bar (transport/BPM/audio meter/MIDI placeholder/fps/PANIC), stage strip (live · staged · COMMIT).
- Param panel: auto-generated from selected manifest — sliders/steppers/toggles/swatches, fully mouse-operable; writes through the same path as `set_param`.
- MCP additions: `create_instance` (scene or single module + harness: fullscreen-quad | orbit-cam-later, inputs: live), `destroy_instance`, `stage`, `commit`. Output window = display-picker + fullscreen.

**Shipped when:** agent stages a candidate; you audition it in a tile, drag its sliders, hit COMMIT; the projector crossfades; PANIC works; nothing the agent does can touch LIVE without you.

## M4 — Clean stage (S) *(v1.1 — quick wins)*

**Goal:** the Output becomes a pure projector surface; staging stops being a chore.

- Pure Output: delete the status overlay (scene/audio/BPM text + device select). `#fps` stays in the DOM — every validator gates readiness on it — but is hidden unless `?hud=1`.
- Audio source selection moves to the Console: new **human-only** `set_audio` command (`mode: mic|test`, optional `deviceId`); `SessionSnapshot` gains `audioDevices`; the Console header’s read-only audio label becomes a picker.
- Aspect fix: fixed internal render resolution (1920×1080, `?res=WxH` override) + CSS `object-fit: cover` on the canvas — fills any window without warping, matches the smaller dimension, centers, crops overflow. The render path (and all three never-go-black layers) is untouched; screenshots become a stable 1080p.
- Staging UX: drag a tile onto the stage strip to stage it; the tile’s stage button toggles to **unstage** when staged; new `/staged.html` sibling page (same BroadcastChannel request/response + presence pattern as the Console) showing the staged instance large, with COMMIT and unstage buttons and a “nothing staged” empty state.

**Shipped when:** `validate:m4` — Output page has no `#status` element and `#fps` is hidden yet still matches `\d+ fps`; pulse rings stay round in a non-16:9 window; `set_audio` flips the audio mode from the Console channel and is *refused* over the agent bridge; `/staged` shows the staged instance’s pixels and its COMMIT drives the crossfade mix-walk; m0–m3 still green.

## M5 — The input rack (L) *(absorbs old-M4 MIDI; panels/save-as move to M7)*

**Goal:** every input the instrument reacts to is named, visible, and tunable in one place.

- `InputContext` in the runtime wrapping the Time/Audio buses: a registry of named channels — `level` (band energy → gain/floor/lag) and `onset` (detector → envelope; the hand-rolled `pulse.scene.ts` idiom promoted to a tuned global). Updated every frame so meters work even with no consumers.
- Channels are **code-defined** in `content/inputs.ts` via `defineInputs(d => { d.onset("kick", { band: "bass", threshold: 0.22, decay: 0.22 }); … })` — defaults live in code (typed, in git, agent-growable); live tuning goes through a **global Manifest** exposed as pseudo-instance `"globals"` (`inputs.kick.threshold`, …). Hot-reloaded like scenes; tunings persist to `content/state/inputs.json`.
- Consumption is **late-bound**: `ctx.input("kick")` resolves through the registry at pull time, so retuning/redefinition never rebuilds an instance. It also auto-declares a per-instance trim param (`input.kick.amount`). **Trims, not overrides:** one global owns each channel’s meaning; a differently-tuned kick is a new named channel (`kickTight`), so the rack never lies.
- Console rack drawer on `i`: one row per channel — live meter (snapshot gains `inputs: Record<string, number>`), enable toggle, tuning widgets (the existing param widgets pointed at `"globals"`).
- WebMIDI: `MidiBus` (hot-plug; device status finally fills the header placeholder); CCs join the rack as channels; **MIDI-learn binds a CC to any param path** — instance *or* globals (a knob can ride `inputs.kick.threshold`) — through the existing `Manifest.get(path).set(value)` write path. Bindings → `content/state/bindings.json`; tuned instance values → `state/values/`.
- The `loom:state` Vite middleware (stack decisions) lands here as the persistence path.

**Shipped when:** `validate:m5` — with `?audio=test`, `get_manifest {instance:"globals"}` lists `inputs.kick.*`; rack meters move; setting `inputs.kick.threshold` to 0.95 zeroes onsets in a consuming scene and restoring recovers them; tunings round-trip a reload; a mocked MIDI CC binds via learn and moves a param. m0–m4 green.

## M6 — Color & chains (M)

**Goal:** a global look you can retint live, and effects you can throw on anything.

- **Color param type** in the kernel (`#rrggbb` value, format-validating clamp; `<input type="color">` widget — the swatches R3.1 promised). Independently useful; human-reviewed runtime change.
- **Palettes:** `PaletteContext` — `primary` and `secondary` global palettes, **5 ordered color stops** each, registered on the globals manifest (`palette.primary.0`…). Scenes consume via `ctx.palette.color(i)` (vec3 uniform per stop), `ctx.palette.ramp(t)` (256×1 DataTexture, re-uploaded on change), `ctx.palette.own([...])` for scene defaults. Using `ctx.palette.*` auto-declares a `palette.source` param (primary/secondary/own) resolved **per frame** by the uniform updaters — switching palettes is a plain `set_param`, instant, no rebuild. The stage strip and `/staged` page show the source selector for the staged instance. Roles (bg/primary/accent) are documented conventions on stop indices, not kernel vocabulary.
- **Post-effect chains:** `chain: ChainStep[]` (`{ id, effect, params }`, stable step ids) as data on the session entry, folded after the scene build. **Chain edit = rebuild via NFR-5** — a throwing step rejects the rebuild and the previous pixels keep running. Effects declare chain knobs via optional `meta.chainParams`; step params live at `fx.<stepId>.<param>` (stable across reorder), values stored in the chain data and re-applied after every rebuild. One new command + MCP tool: `set_chain { instance, steps }` (full-list semantics — attach/detach/reorder in one idempotent verb). Humans may edit the LIVE chain directly; **agents need the arming gate to touch the LIVE chain** (non-live is ungated, like `create_instance`). Console: collapsible FX-chain section in the param panel — step cards with drag-reorder, “+ effect” fed by a new effects barrel, per-step widgets grouped by prefix. Per-step output previews are a stretch goal (fold-time copy passes behind a flag; never render an instance twice).
- **Output types formalized:** `ModuleOutput = TexNode | Signal | Events` (+ `GeoNode` when M8 lands) and a `ChainableEffect` alias; `meta.kind` ↔ output type stays the convention; the only runtime check is the chain fold asserting a `TexNode` result. Retrofit `glitch`/`feedback`/`levels` with `chainParams`; convert one scene to `ctx.palette`.

**Shipped when:** `validate:m6` — a globals palette edit retints a consuming instance within a frame; flipping `palette.source` changes pixels with no rebuild; `set_chain` appending glitch makes `fx.glitch-1.*` appear in the manifest and visibly changes the preview; a throwing chain step leaves the instance running on previous pixels; reorder preserves knob positions. m0–m5 green.

## M7 — Library & parallel build (M) *(old M5 + old-M4’s panels/save-as)*

**Goal:** the agent composes from vocabulary; subagents build in parallel; the library grows itself.

- Stdlib buildout to ~20 modules (full Control/Source/Effect list from Requirements §6, minus Geo) — every effect `chainParams`-compliant, every audio-reactive module consuming named `ctx.input(...)` channels. The library is born compatible with the rack and chains.
- `CATALOG.md` extended (chainable / inputs-consumed columns) — the AST generator already rides `pnpm typecheck`; this supersedes the old “catalog.json” line. *Library-use* skill: search catalog first, register after writing, tag conventions.
- Fixtures: record/replay InputBus traces **including input-channel values**; `create_instance({inputs: "fixture:…"})`; `screenshot({frames:[…]})` deterministic against fixtures.
- Parallel workflow proven: signatures-first convention + `tsc` gate; subagents each get a sandbox instance (own tile) with fixture input.
- Panel files (R3.5): declarative `{paramPath → widget, midi}` subsets; Console renders open panels; opening activates bindings; *panel-authoring* skill. “Save as” flows (R3.4): persist tuned scene; factor selection into a custom module. Both land here because they compose the params + bindings M5 defined, and the library is what makes saving worth it.

**Shipped when:** “build me three new scenes in parallel — glitchy, organic, geometric — using the library” lights up three tiles that converge concurrently; a brand-new custom module written today is found and reused by the agent tomorrow via the catalog; the R3.5 panel prompt produces a working bound panel; “save it as bass-tunnel” round-trips through restart. (`validate:m7`)

## M8 — Depth: Geo & particles (L) *(old M6, scope unchanged)*

**Goal:** the 3D path. Your flagship prompt works.

- `Geo` type — `GeoNode` joins `ModuleOutput`; `gltf` + primitive loaders; `render(world, cam)` bridge module (scene-in-scene render target → TexNode); `orbitCam` control module.
- `particleEmitter`: mesh-surface sampling, GPU-instanced pool via TSL compute, `rate`/`lifetime`/`turbulence` as Signals/Params; pool state under the rebuild-on-change policy.
- Harness additions for single-module sandboxes: `orbit-cam`, `chain:<scene>@<node>` (mount in situ).
- Stdlib Geo entries cataloged; *module-authoring* skill extended for Geo kind.

**Shipped when:** *“create a particle generator that spits out particles from the surface of a 3D skull, hats driving turbulence”* → agent builds it in a sandbox tile, you tweak on MIDI, and commit it through a `feedback`+`paletteMap` post chain — now via M6’s real `set_chain` mechanism instead of hand-wiring. (`validate:m8`)

## M9 — Gig hardening (M) *(old M7)*

**Goal:** trust it in a dark room.

- Session snapshot/restore (crash recovery of transport, slots, open panels, values — **and globals tunings, palettes, chains, bindings**).
- Perf budget: frame-time HUD per instance; `screenshot` metadata includes fps so agents self-police; document a perf-check step in the commit skill.
- 90-minute soak test on fixtures (memory/VRAM stability, HMR churn, **rack-tuning and chain-edit churn**).
- A starter set: 8–10 tagged, tuned scenes in the repo **using palettes, chains, and named input channels**; a one-page performer cheatsheet; the §9 magic test executed clean, timed, from fresh clone.

**Shipped when:** you play a real (or fully simulated) 60+ minute set: agent staging looks between tracks, you committing and riding knobs, zero output interruptions. **This is v1.**

-----

## Cross-cutting rules

- Every milestone merges with: typecheck green, the previous milestones’ demos still passing (keep them as scripted checks where possible), and CLAUDE.md/skills updated to match reality — stale conventions poison every future agent session.
- `runtime/` changes get human review; `content/` is agent territory.
- Keep a `DECISIONS.md` log; future-you and future-agents both read it.

## Risks & mitigations

|Risk                                              |Mitigation                                                                                                                                    |
|--------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------|
|WebGPU/TSL instability or driver pain             |Pin Three.js version per milestone; smoke-test scene in CI; WebGL2 fallback is a last-resort fork of the TexNode compiler, not a day-one cost.|
|HMR semantics fight the instance model            |NFR-5 rebuild-on-change keeps it trivial; revisit only after v1.                                                                              |
|Browser audio latency/quality (Analyser smoothing)|Acceptable for v1 reactivity; AudioWorklet onset/BPM is a contained M5+ upgrade inside InputBus.                                              |
|Agent writes sprawling untyped code               |zod-validated metadata + skills with golden examples + catalog-first rule; reject via tsc, not vibes.                                         |
|Scope creep (this conversation’s natural hazard)  |§8 out-of-scope list is load-bearing. New ideas go to `DECISIONS.md` as post-v1 candidates.                                                   |

## Post-v1 horizon (ordered candidates)

1. Embedded perform-mode chat pane (Claude Agent SDK client on the existing MCP/WS boundary)
1. NDI out (forces the Electron/native-shim decision)
1. AudioWorklet beat tracking + look-ahead quantization
1. OSC in/out (GrandMA3 says hello)
1. Generative-video source module (Mirage-class / StreamDiffusion as a TexNode source)
1. Pop-out OS-window panes; multi-display layouts
1. Embeddings over the catalog when flat JSON stops scaling