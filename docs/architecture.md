# LOOM architecture

How LOOM is built. This is the single source of truth — the root `CLAUDE.md` and
`.claude/CLAUDE.md` carry summaries that defer here. For *what* LOOM is, read
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
- `packages/sidecar` — agent surface: MCP server over stdio (17 tools: `get_session`,
  `get_manifest`, `set_param`, `modulate_param`, `clear_modulation`, `set_chain`,
  `save_chain`, `screenshot`, `create_instance`, `destroy_instance`, `stage`, `unstage`,
  `commit`, `record_fixture`, `list_projects`, `save_project`, `load_project`) bridged to the
  engine over WebSocket (port 7341; `LOOM_WS_PORT` + `?ws=` override for isolation).
  The wire contract is `@loom/sidecar/protocol` (browser-safe, shared with the
  engine via tsconfig path + Vite alias). The sidecar's stdout belongs to MCP — log
  to stderr only. `.mcp.json` registers it; `.claude/` holds the in-engine
  agent rules and skills (start LOOM agent sessions from the repo root).
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
  the mic. Voice-DSP — echo cancel / noise suppress / auto-gain — is requested
  *off* so music reaches the analyser intact. Driving the rack from a network
  stream like SonoBus via a virtual audio device: `docs/sonobus-audio.md`), and
  `MidiBus` (WebMIDI CC state, hot-plug;
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
- Chains (M6): a per-instance post-effect chain is runtime data on the session
  `Entry` (a `ChainHost`, sibling to `ModulatorHost`), **folded inside
  `buildInstance` before `finalize()`** — `tex = effect(ctx, { input: tex, … })` per
  step, each wrapped `mix(input, effect, fx.<id>.mix)`. So a throwing step throws
  the whole build (NFR-5 rejects it, previous pixels keep running) and enable/disable
  is a plain `fx.<id>.mix` param (no rebuild, MIDI-bindable). Step ids are stable
  (`<effect>-<n>`); knob values live in the chain data and re-apply after every
  rebuild (carry-forward by id on reorder/insert; full disk persistence is M9).
  `set_chain` is full-list/idempotent (agent edits to the LIVE chain are arming-gated
  like `commit`; sandbox + human edits are ungated; `restoreDefault` resets to the
  scene's declared `chain`). The chainable-effect library (`engine-app/effects.ts`,
  globbed like scenes) merges code effects that declare `meta.chainParams`
  (primitives) with saved chains under `content/modules/effects/chains/*.chain.json`
  (composites — one level deep, namespaced `fx.<id>.<inner>.<param>`); `save_chain`
  writes one via the `loom:effects` Vite middleware.
- Layers: `ctx.layer(name, tex)` wraps any TexNode as a named, grabbable node —
  it registers a stable identity (`Instance.nodes`, `{id, parent}` with parents
  detected via rig marker passes), folds a **uniform-driven rig**
  (`<name>.layer.x/y/scale/rotate/opacity`, identity defaults, one RT pass — a
  rig `set_param` never rebuilds), and folds the node's **FX chain** through a
  session-injected `foldNode` hook. Per-node chains are `ChainHost`s with a
  `<node>.fx` path prefix in `Entry.nodeChains` (lazy on first
  `set_chain {node}`; no scene default). The node-chain wet/dry preserves the
  input's ALPHA (root locks to 1) so chained overlay-nodes keep their
  silhouette. Explicit-only: unwrapped nodes cost nothing. `get_manifest` and
  `get_session` carry `nodes: [{id, parent, chain}]`; the Console renders node
  groups with per-node "+ effect".
- Geo (M7): `GeoNode` (`{object: Object3D}`) and `CamNode` (`{camera}`) join
  `ModuleOutput` — geo modules (content/modules/geo/) return scene-graph
  fragments animated through `ctx.updaters` (frame-clock). The `render3d`
  bridge (a source) owns Scene + lights + an MSAA RT and renders world+cam
  into the TexNode chain; `model` loads glTF/FBX with materials normalized to
  MeshStandardMaterial (loader-specific materials can throw in the backend).
  `Instance.frameMs` (EMA CPU submit cost) is the per-instance frame-time HUD
  (get_session, Console tiles); screenshot metadata carries fps.
- Particles (M8): `particleEmitter` samples a mesh's SURFACE (seeded
  MeshSurfaceSampler — `setRandomGenerator`, or fixture replays break) into a
  GPU-instanced pool driven by a CPU sim (struct-of-arrays, swap-kill,
  spawn-debt; `instanceMatrix` MUST be `DynamicDrawUsage` — static-usage
  buffers only re-upload inside the rAF loop). The base path runs and
  validates on the WebGL2 fallback; a TSL-compute pool is the post-v1 WebGPU
  upgrade. Offline fixture stepping binds the destination RT before each
  frame so destination-sized passes size deterministically.
- Fixtures: deterministic input traces. `record_fixture` writes the rack's
  post-detector values (one row per frame, plus bpm) to
  `content/state/fixtures/<name>.json`; `create_instance({inputs:
  "fixture:<name>"})` replays it via a `FixturePlayer` (an `InputProvider` —
  the interface `ctx.input` consumes, so scenes are unchanged).
  `screenshot({frames})` runs a deterministic OFFLINE pass: the scene rebuilds
  against the trace on a virtual clock (frame 0, dt 1/60, own TimeBus, silent
  audio) with values/chains/modulators mirrored — same fixture + frames →
  byte-identical pixels. Consequence, enforced by a golden-pattern scan: TSL
  `time` (the renderer's wall clock) is banned in content/ — animate with
  `ctx.uniformOf(ctx.time.now)`.
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
`bindings.json`, `values/<scene>.json`, `projects/<name>.json`) served by the
`loom:state` Vite middleware (`GET/POST /loom/state/<name>`; `loom:state-list`
lists a state directory), saves debounced engine-side. Per-scene values
reapply on create/rebuild (NFR-5's "params reapplied from tuned state").
`?state=off` disables ambient load+save — all validators boot with it except m5
and projects, which test persistence. `media-roots.json` registers directories
OUTSIDE the repo (a VJ-assets folder) that the `loom:media` middleware may
stream (`GET /loom/media?p=<abs path>`, HTTP Range/206 for video seeking, 403
outside the roots; read per request, so edits apply without a restart) —
`mediaUrl(absPath)` in `content/modules/sources/video.ts` builds the URL. Projects (set lists) are explicit save/
load actions through `ProjectStore` (engine-app): serialize the instance set
(values, modulators, root + per-node chains, tile order, live pointer); loading
builds sandboxes via `SessionStore.create`'s init seed (chains fold into build
#1) and NEVER touches the Stage — the pre-load instances cull after a commit
from the loaded set lands (deferred-cull check in the render loop).

## Module packs

Third-party repos of modules/scenes, imported into a project so the library
isn't monorepo-only. A pack mirrors `content/`'s layout (no build step):
`loom-pack.json` (`{ name, version, loomApi, description }`) + `modules/`,
`scenes/`, optional `assets/` and `test/cases.ts`. Modules import ONLY
`@loom/runtime` (+ three) — the same portability rule the golden patterns
enforce in-repo.

- **Registration** is `content/state/packs.json` (`{ packs: [{ name, source,
  pin, branch?, loomApi? }] }`, committed) — the registered-roots idiom from
  `media-roots.json`. `pnpm pack:add <git-url|path>` clones (pins the SHA +
  records the tracked `branch`) or symlinks (`pin: null`) into the **gitignored**
  `packs/<name>/`; `pnpm pack:update` fetches/resets that branch and re-pins. The
  checkout is scratch; the JSON is the source of truth. The **canonical name** is
  the manifest's `name` (`--name` > `loom-pack.json` name > source basename) — a
  git pack is cloned to a temp dir, the manifest read, then moved to `packs/<name>`,
  so the published namespace matches what the author declared.
- **Discovery** is static `packs/*/…` globs added beside the `content/…` ones in
  the engine barrels (`engine-app/src/scenes.ts`, `effects.ts`), the test harness,
  and `scripts/build-catalog.mjs`. Absent until `pack:add`, so a pack-free repo is
  byte-for-byte unchanged.
- **Namespacing/precedence:** local content keeps its BARE name; pack content
  surfaces as `<pack>/<name>` in CATALOG / `availableScenes` / `availableEffects`.
  **Local wins** a bare-name collision (a pack's same-named item is reachable only
  namespaced) — deterministic, the marketplace relies on it. One rule, two synced
  helpers: `engine-app/src/packs.ts` (browser) and `scripts/lib/packs.mjs` (Node).
- **Resolution:** `preserveSymlinks: true` (both Vite configs) lets a linked
  out-of-tree pack resolve the host's `three`/`three/tsl` from node_modules.
- **Gate & trust:** `packs/` is in the root tsconfig include, so **typecheck is
  the real compatibility gate**; `loomApi` is a fast caret-major hint. A pack's
  `test/cases.ts` merges into the completeness sweep (same enforcement as local
  modules). A pack is arbitrary code at the SAME trust level as editing
  `content/` — **documented, not sandboxed**, for v1. Full rationale: the
  "Module packs (v1)" entry in `DECISIONS.md`.

## Content marketplace (discovery, Phase 1)

The DISCOVERY layer over module packs: packs let you **depend on** a pack whose
URL you know; the marketplace lets you **find** one you don't. Phase 1 is
frictionless — a flat, versioned JSON index, no backend, no accounts. (Spec:
`feature-requests/content-sharing-marketplace.md`; trust + publish one-pager:
`docs/marketplace-publishing.md`.)

- **The index (`index.json`) — FROZEN schema (Phase 2 reuses it):**
  `{ schemaVersion: 1, packs: [{ name, gitUrl, gitRef?, description, tags[],
  author, loomApi, rating? }] }`. `name`/`loomApi` mirror `loom-pack.json`;
  `tags` draw from the catalog vocabulary. A seed lives at
  `content/marketplace/index.json`; `LOOM_MARKETPLACE_INDEX` (a path OR an
  http(s) URL) overrides it — the schema is the stable seam, the transport
  swappable (NFR-1). One Node helper (`scripts/lib/marketplace.mjs`) and one
  sidecar mirror (`packages/sidecar/src/marketplace.ts`) own the schema +
  validator + ranker, kept in sync (the frozen schema makes that safe).
- **Search, two surfaces, one ranker:** `search_content { query, tags? }` (MCP,
  agent — read-only, source-tagged, agent-allowed, NO arming because it pulls
  nothing; answered sidecar-side without the engine) and `pnpm pack:search
  <query> [--tag t]` (CLI). Both return entries ranked name > tag > description,
  tags as a hard AND filter, ties broken by `rating` then name. Each result
  carries the exact `installHint` (`pnpm pack:add <gitUrl>` + `--ref` when
  pinned). NFR-4 reflex: search the LOCAL catalog first; the tool/CLI say so.
- **Install handoff (FR-4):** installing a found entry is exactly
  `pnpm pack:add <gitUrl>` — discovery hands off to module packs, it does not
  reimplement loading. After install the pack appears namespaced in CATALOG /
  `availableScenes` (already true).
- **Override paths (FR-6):** `pnpm pack:fork <name>` copies an installed pack
  into an editable, un-pinned `forks/<name>/` tree (committed; `.git` excluded)
  and re-points its registry entry at that local path with `pin: null` — the
  whole-pack override. To override a SINGLE module without forking, author a
  bare-name local `content/modules/.../<name>.ts`: **LOCAL-WINS** precedence
  (module packs) shadows the pack's same-named item — the local-shadow rule.
- **Git-native publish/ratings/moderation (FR-7/8/9):** publish = PR a line to
  `index.json` (CI validates it against the frozen schema); a rating is a schema
  field (a maintained aggregate / GitHub-stars mirror); moderation IS the index
  repo's merge queue. Trust is loud and UNCHANGED from packs (NFR-3): a rating
  is popularity, **not** a security audit; installing runs arbitrary code at
  content-edit trust; install is human-gated like commit. No sandboxing —
  document, don't promise.
- **Offline-degrades (NFR-2):** a missing/unreachable/invalid index is a CLEAN
  tool/CLI error (clear message, exit 1) — it NEVER blocks already-pinned packs,
  which load offline from `packs.json`.
- **Deferred to Phase 2:** the hosted index API (same shape, swapped transport),
  real account-based ratings + active moderation, and the Console browse panel.
  Payments are out of scope even in Phase 2.

## Testing & validation

Four layers, cheapest first. The merge gate is all of them: milestone work merges
only with typecheck green, `pnpm test` green, and `pnpm validate` (every suite)
still passing.

### 1. Typecheck — the contract gate (`pnpm typecheck`, seconds)

Regenerates `content/CATALOG.md`, then `tsc --noEmit` over `packages/*` and
`content/`. Types are the coordination protocol between modules, scenes, and the
kernel — this is the first thing to run after any edit, and the only gate a live
session's hot-reload loop doesn't already enforce.

### 2. Package unit tests (`pnpm -r test`, ~5 s)

Per-package vitest roots, plain Node:

- `packages/runtime` — kernel behavior with a fake clock: Signal/Events memoization,
  Param clamping, Stage commit/panic/rename semantics, modulators, onset detection,
  input rack, palettes, MIDI bindings.
- `packages/sidecar` — protocol schemas and MCP tool surface.
- `packages/engine-app` — runs **two vitest projects** under one
  `pnpm --filter @loom/engine-app test` (each its own environment): a `node` suite
  (the pure-logic tests — `EngineLink` against a fake BroadcastChannel,
  render-service, MIDI, projects…) and a `ui` suite (`happy-dom`) that exercises
  the React `useSyncExternalStore` hooks in `src/ui/hooks.ts` with `renderHook`
  over a fake `EngineLink`. testing-library + the DOM env are **devDependencies of
  engine-app only** — they never enter the production Vite build.

Run one file: `pnpm --filter @loom/runtime exec vitest run test/signal.test.ts`.

**Coverage gate (`pnpm test:coverage`) — `packages/` only.** A v8 coverage run
over `packages/*/src/**` with line/branch/function/statement thresholds set at a
ratchet floor (= the current measured coverage; raise deliberately, never lower).
The scope is **physically incapable of measuring `content/`**: the coverage
`include` is `packages/*/src/**` and `content/**` is excluded outright
(`vitest.coverage.shared.ts`), mirroring the packages-vs-content line in
`biome.json`. The gate lives ONLY in `pnpm test:coverage` (and the CI `checks`
job) — `pnpm test`, `pnpm typecheck`, and the MCP creative loop are untouched, so
building visuals stays a single round-trip with no coverage step in the loop.

### 3. Stdlib content tests (`pnpm test:content`, ~3 s — chained into `pnpm test`)

`content/test/` under the root `vitest.config.ts` (happy-dom, because
image-flavored modules construct a DOM `Image` at build time; no GPU is ever
created). Modules build through the **real `BuildCtx`** over mock/real buses —
`FakeAudioBus` (settable levels, queued onsets), real `TimeBus`, real
`InputRegistry` running the actual `content/inputs.ts` rack, real
`PaletteRegistry`. `ProbeCtx` records every uniform a module registers, so
checking those values for finiteness is *total* NaN detection for CPU-side
signals. Coverage is automatic — `import.meta.glob` discovers every
`defineModule` export, and a discovered module without an opts entry in
`content/test/cases.ts` fails the completeness test (**new modules merge with
their case + tests, mechanically enforced**):

- **Tier 1 — contract** (`contract.test.ts`): meta kind matches its folder,
  metadata complete, output shape per kind (TexNode / Signal), effects return
  `[...input.passes, ownPass]` (asserted with a marker pass), manifest ranges
  honest (`min < max`, default inside — degenerate knobs rejected).
- **Tier 2 — robustness** (`robustness.test.ts`): every ranged param swept to
  min and max (bools both ways), 60 ticked frames per setting, every probe
  finite, nothing throws; effects also build against a black constant input.
- **Golden patterns** (`golden-patterns.test.ts`): raw-source scans — no
  `audio.onset(` in modules *or* scenes (onset detection is owned by the named
  rack channels, R6.4; a differently-tuned kick is a new channel, never a local
  re-detection); modules never import the engine app or sidecar.
- **Harness self-test** (`harness.test.ts`): deliberately broken modules (NaN at
  a param extreme, dropped/reordered passes, malformed metadata, dishonest
  ranges) are provably caught — if one of these "passes", the net has a hole.

What this layer *can't* see: actual pixels, shader compilation, render-time
behavior. That's layer 4.

### 4. Acceptance validators (`pnpm validate`, ~6 min; or any `pnpm validate:<x>` alone)

Playwright + headless Chromium scripts in `scripts/validate-*.mjs`, each booting
its own Vite (and, where needed, its own sidecar) — the eyes-on layer. A shared
helper module (`scripts/_harness.mjs`) holds the boot block (`bootStack`) and the
assertion/teardown primitives so the suites don't re-fork them. One suite per
shipped milestone, kept green forever, plus `core` (the boot smoke + the SINGLE
canonical MCP tool-surface assertion, run first so the others don't re-prove it):
`m0` (HMR/never-go-black), `m1`
(signals/audio/containment), `m2` (MCP e2e), `m3` (stage/commit/PANIC + Console),
`m4` (pure output/staging UX), `m5` (input rack/persistence/MIDI-learn), `m6`
(palettes), `layers` (named nodes: rig rides with no rebuild, per-node chains,
NFR-5 on a throwing node step, Console node tree), `projects` (set lists:
save/mutate/load round-trip with LIVE untouched, deferred cull, restart
survival, agent-save gating), `m9` (video: play/freeze/scrub/loop with no
rebuild, cover scaling on a video source, media middleware), `fixtures`
(record/replay determinism: byte-identical screenshots across calls and
instances), `m7` (geo: gltf sandbox → orbit → post chain → commit, frame-time
HUD; FBX checks where the local asset exists), `m8` (particles: surface
emission, turbulence whip, chain commit, byte-identical fixture replay),
`m11` (catalog columns, hot-register a module mid-run, parallel sandboxes),
`modulators`, `panic` (arm/hold/scene paths, split out of the m3 family),
and `stdlib` — the tier-3 smoke render: every module is
mounted in a generated sandbox scene (sources direct, effects over an `osc`,
controls driving an osc param), hot-swapped in via the `live.scene.ts` pin, and
must render non-black with a clean console and no NFR-2 freeze.

When a deliberate behavior change invalidates a validator's assertion, the
validator moves with the behavior (same coverage, new expectation) — checks are
never deleted or weakened to get to green.

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
- Validator console pages pass `?embed=0` so the Console never spawns an embedded
  engine that would dial the DEFAULT sidecar port and break run isolation.
- Each session entry carries a `builds` counter (1 on create, ++ per successful
  rebuild) exposed in `get_session` and `window.__loom` — assert "no rebuild
  happened" against it.
- Editing source files **while** a validator runs reloads its dev server mid-flight
  and fails the run spuriously — run validators between editing bursts.

### When to run what

| Moment | Run |
|---|---|
| After any edit | `pnpm typecheck` |
| After kernel/sidecar/UI-client changes | `pnpm test` |
| After adding/changing a module or scene | `pnpm test` (tiers 1–2 + patterns) then `pnpm validate:stdlib` (pixels) |
| After touching the swap/HMR/render path | `pnpm validate:m0` + `validate:m1` at minimum |
| Before merging milestone-level work | `pnpm typecheck && pnpm test && pnpm validate` |

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
