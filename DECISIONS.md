# DECISIONS

Log of implementation decisions, per the plan's cross-cutting rules. Newest at the bottom.

## 2026-06-09 — M0

- **three pinned exact at 0.184.0** (`@types/three@0.184.1`), per the plan's "pin Three.js per milestone" risk mitigation. Vite 8, TypeScript 5.8, pnpm workspace.
- **One root `tsconfig.json` drives typecheck** for `packages/*` and `content/` (no project references). `@loom/runtime` resolves via tsconfig `paths` + a Vite alias in `engine-app/vite.config.ts` — the alias is what lets `content/` scenes (which live outside any package) import the runtime.
- **Vite HMR error overlay disabled** (`server.hmr.overlay: false`): a compile error must never paint over the Output window. Compile errors are withheld by Vite (previous module keeps running); runtime throws are contained by `SceneHost.setScene` try/catch.
- **M0 error containment boundary:** TS/parse errors and `build()` throws are contained. A scene whose _shader_ fails at GPU compile time after a successful build() is not yet contained — that's part of NFR-2 work in M1's per-instance containment.
- **Validation is screenshot-based** (Playwright + pngjs): reading a WebGL/WebGPU canvas via `drawImage` returns black without `preserveDrawingBuffer`, so acceptance checks sample composited page screenshots instead. Headless Chromium has no WebGPU adapter → automated runs exercise the WebGL2 fallback path; WebGPU is verified manually in desktop Chrome.
- **Validation artifacts committed** under `loom/artifacts/` as evidence for each milestone run.

## 2026-06-09 — M1

- **Kernel is pull-based with per-frame memoization.** `Signal.get(f)`/`Events.poll(f)` memoize on `f.frame`. Consequence: stateful ops (lag, envelope, divide, quantize, onset detectors) must be pulled every frame or they miss time — instances guarantee this because every CPU signal reaches the GPU through a registered uniform updater that runs each frame. Documented as a contract, not a bug.
- **`TexNode.color` is strictly `Node<"vec4">`.** Looser unions (float/vec3) fight @types/three conversion overloads and push casts into every effect. Sources normalize to vec4 once.
- **Effects own pass ordering.** A stateful effect (feedback) returns `[...input.passes, ownPass]` — topological order falls out of composition; the Instance just runs the list. No graph scheduler until one is actually needed.
- **Feedback render targets are fixed 1280×720 half-float.** Per-instance sizing belongs to M3 (Stage/panes); resolution-independent history would complicate the first stateful pass for no M1 payoff.
- **Synthetic test-audio mode lives in AudioBus** (`?audio=test`, also the automatic fallback when getUserMedia fails). Scheduled kick + offbeat hats feed the same AnalyserNode path as the mic, so validation and demos exercise the real analysis code. This is a stopgap for M5 fixtures (record/replay InputBus traces), not a replacement.
- **BPM is manual (set via `?bpm=` / tap on `t`)** per plan; beat tracking from audio is explicitly post-v1.
- **Onset detection** = threshold + rising edge + refractory + re-arm-below-threshold, per detector instance (each `ctx.audio.onset()` call gets independent state/options). Spectral-flux fanciness deferred until kicks feel missed in practice.
- **Validation scripts fail fast if Vite exits early** (port collision) — an aborted run once left an orphan server and the next run silently validated against its stale module graph.
- **NFR-5 rebuild semantics in `trySwap`:** build the next instance fully before disposing the old one; a failed build never touches the running instance.

## 2026-06-10 — M2

- **Sidecar topology:** Claude Code spawns the sidecar over stdio (`.mcp.json`: `node --import tsx packages/sidecar/src/index.ts`); the engine dials out to `ws://localhost:7341` (`LOOM_WS_PORT` overrides) and reconnects every 2 s. Latest engine connection wins; the sidecar never blocks on a missing engine — tool calls fail fast with "engine not connected".
- **MCP via the low-level `Server` API with plain JSON-Schema tool definitions**, not `registerTool`+zod: the MCP SDK's zod lineage (v3) would couple against the project's zod v4. Tool args are validated with our own protocol schemas on both sides of the wire.
- **The WS wire contract lives in `@loom/sidecar/protocol`** (browser-safe: no Node/DOM APIs), shared with the engine via tsconfig `paths` + a Vite alias — same pattern as `@loom/runtime`.
- **Screenshots are captured inside the render loop** via same-task `canvas.toDataURL` right after `renderFrame` (the WebGL drawing buffer is invalid in later tasks without `preserveDrawingBuffer`). A screenshot request resolves on the next presented frame; a frozen instance still serves its held frame.
- **`set_param` writes through `Manifest.get(path).set(value)`** — the M1 kernel needed zero changes for M2; clamping and `param.signal()` liveness were already the contract. Instance id is fixed to `"live"` until Stage lands in M3.
- **stdout discipline:** the sidecar's stdout belongs to MCP; all sidecar logging goes to stderr.
- **`pnpm.onlyBuiltDependencies: ["esbuild"]`** in the root manifest — pnpm 10 blocks install scripts by default and tsx needs the esbuild binary.

## 2026-06-10 — content (lava scene)

- **Multi-channel TexNode packing for field sources:** `blobs` outputs its thresholded ink mask in r/b and the raw-field "core glow" (smoothstep of stacked field depth) in g, so scenes can shade blob interiors without the module dictating color. Convention for future field-like sources: pack semantic scalars into vec4 channels and document the layout in the module description. Monochrome consumers reading `.x` still work.
- **CPU-side signal composition via `new Signal((f) => ...)`** pulling several signals (param + LFO + onset envelope) is the idiom for combining reactive values into one module opt — `Signal.map` is single-input. Hoist `param.signal()` calls outside the closure (each call creates a new Signal).
- **`content/CATALOG.md` is generated, never hand-written.** `scripts/build-catalog.mjs` extracts defineModule/defineScene metadata via the TypeScript AST (importing content in Node would drag `three/webgpu` into an environment without browser globals). Auto-regen rides `pnpm typecheck` — the gate every change already runs — so the index cannot drift silently; `pnpm catalog --check` exits 1 on staleness for CI-style use.

## 2026-06-10 — M3

- **Validators pin their scene and isolate their sidecar port.** A performance left `lava` live and broke m1/m2's pulse assertions; a live Claude Code session holding WS 7341 killed validation sidecars. Scripts now write the pulse pin into `live.scene.ts` (restoring the real one after) and run their sidecar on a private port via `?ws=` + `LOOM_WS_PORT`.
- **Engine stays in the Output window; the Console is a sibling page** (`/console.html`) talking over `BroadcastChannel("loom")` with the same request/response envelopes as the sidecar wire — one `EngineApi` dispatch serves both, tagged by source (`agent` | `human`). Closing the Console never touches the projector, and the Console works with the sidecar/agent absent (R4.5).
- **Commit is human-gated for agents**: `commit` from the WS bridge requires the armed flag (Console toggle, or `?agentCommit=1` at engine boot for dev). Human-only types (`panic`, `resume`, `arm_agent_commit`) are refused for agents at dispatch. Destroying the LIVE instance is refused for everyone.
- **Crossfade semantics (`Stage`)**: commits start at the next frame boundary; a duration-N fade spends exactly N frames with mix in (0,1) exclusive — duration 0 is a hard cut. PANIC cancels an in-flight fade (live stays live) and holds the canvas by skipping all rendering; the browser keeps presenting the last frame (same mechanism as NFR-2 freezes).
- **Multi-scene HMR via an eager glob barrel** (`engine-app/src/scenes.ts`): every scene edit bubbles through the barrel to one hot-accept; instances rebuild only when their def's module identity changed, so editing scene A never resets scene B's feedback state. Vite still withholds syntax errors wholesale — never-go-black is unchanged at N instances. Deleting a scene file destroys its instances.
- **Instances render exactly once per frame** (stateful passes advance per render call): the Stage directive decides each instance's one destination — canvas, a full-res crossfade leg, or its 640×360 preview target.
- **Console previews are JPEG dataURLs at ~6.6 fps** read back via `readRenderTargetPixelsAsync` (BroadcastChannel can't transfer ImageBitmaps). WebGL reads come back bottom-up, WebGPU top-down — the flip keys off `renderer.backend.isWebGLBackend`. Broadcasts pause when no Console has said hello for 5 s. Upgrade path if tiles need to be smoother: window.open + MessagePort with transferable ImageBitmaps.
- **`Stage.adoptLive` exists for boot/recovery only** (fills an empty live slot); every other LIVE change goes through `commit()` — the audience-safety invariant lives in one place.
- **`"live"` is an alias, not an instance id.** The boot instance (bound to `live.scene.ts`) is id `"boot"`; commands default to `instance: "live"`, which resolves at dispatch to whatever the Stage currently routes to output. Before this, the boot instance was literally named "live", which read as "LIVE live" in the Console and silently pointed at the _old_ instance after a commit.
- **The Console can spawn library scenes** (scene picker + "+ instance") — R4.5 demands the instrument work with the agent absent, and until this the human had no way to instantiate a scene without one. Goes through the same `create_instance` dispatch as the MCP tool.

## 2026-06-10 — content library refactor (pulseRings/glitch) + scene discovery

- **Visual identities live in modules, scenes are wiring.** `pulse` and `pulse-glitch` both compose `pulseRings` (source: rings/core/ink palette, grain via the `noise` module) instead of duplicating TSL; the glitch treatment is a standalone `glitch` effect. The module-authoring and scene-composition skills now state the policy: >few lines of inline TSL in a scene means a module is missing.
- **UV-warping effects must own a RenderTarget.** An effect cannot re-evaluate `input.color` at a shifted UV (it's a node graph, not a function of UV), so `glitch` renders its input into an owned RT each frame and re-samples `texture(rt.texture, warpedUv)` — three taps for the RGB split. `feedback` proved write-then-sample-same-frame is safe on both backends; `glitch.ts` is now the reference for stateless-looking-but-stateful resampling effects.
- **`loom:watch-content` Vite plugin (engine-app).** `content/` sits outside the app root, so Vite's watcher never saw NEW files there: `import.meta.glob("…/content/scenes/*")` missed additions until something else invalidated the barrel (first symptom: `create_instance` reported the freshly written `pulse-glitch` scene unknown until the barrel was touched). `server.watcher.add(contentDir)` makes add/unlink events reach Vite's glob invalidation; verified headless (new file → `hot updated: /src/scenes.ts` with no manual touch).
- **A frozen frame counter with a responsive bridge is a _window_ problem, not a content bug.** Chrome stops rAF for minimized/occluded windows: `get_session` keeps answering (WS handlers run) while `frame`/`fps`/`rms` freeze and `screenshot` times out (it resolves inside the render loop). Diagnosed by exonerating the content headless (WebGL2) and headed (WebGPU) — both scenes ran clean. Recovery is desktop-side: make the Output window visible again.
- **Debug pages must pass `?ws=<isolated>`.** A throwaway repro page without it silently attached to the live session's sidecar on 7341 (same lesson the validators learned in M3, re-learned for ad-hoc scripts).

## 2026-06-10 — post-v1 candidate: param modulators

- **Attachable param modulators** (run-time LFO/ramp/random/cycle/audio-follow on any param of any instance, Console + MCP, no code edits) — fully fleshed out as requirements + phased implementation plan in `feature-requests/param-modulators.md`. Distinct from the `lfo` control module: modules modulate at build time in code; modulators attach per instance at perform time.

## 2026-06-10 — roadmap v1.1 (post-M3 design review)

A design pass on "how the instrument is actually used" produced requirements R6–R9 (requirements-v1.md §11) and reshaped the plan: old M4 split across new M5 (MIDI/bindings/values) and M7 (panels/save-as); old M5→M7, M6→M8, M7→M9. Nothing dropped; `validate:m*` numbering continues unbroken. The decisions:

- **Quick wins are their own mini-milestone (M4 "Clean stage")**, not folded into the next big one: pure output + aspect fix + staging UX are performer-visible in a weekend, every later milestone's Console work builds on the resulting page structure, and bundling would couple a trivial validator to a large one.
- **One "globals" mechanism for all global state.** Input-channel tunings (M5) and palettes (M6) register on a single global Manifest served as pseudo-instance `"globals"` through the existing `get_manifest`/`set_param` dispatch. Console widgets, MCP, and MIDI-learn reach globals with zero new param machinery — the alternative (bespoke commands per subsystem) would triple the protocol surface for no expressiveness.
- **MIDI folds into the input-rack milestone (M5)** instead of shipping first as old-M4: the rack drawer is MIDI's natural UI surface and InputBus its home; building MIDI-learn before the rack exists would mean building a binding panel twice.
- **Input channels are code-defined** (`content/inputs.ts`, hot-reloaded), Console-_tuned_ — not Console-created. Code is the substrate (Principle: everything authored is text in git), the agent can grow the rack, and the protocol stays read/tune-only. Revisit only if mid-set channel creation with a mouse turns out to be a real need.
- **Global-vs-local input semantics: trims, not overrides.** A channel's detection meaning (band, threshold, decay) is owned globally; consumers get an auto-declared multiplicative trim param. A differently-detected kick is a new named channel (`kickTight`) — local threshold overrides would fork the meaning of a name and make the rack lie.
- **Palettes are 5 anonymous ordered stops + a ramp**, two global slots (primary/secondary). Roles like bg/accent are documented conventions on indices — first-class named roles would lock a vocabulary into the kernel permanently. Per-instance palette choice is a live `palette.source` param resolved per frame, so switching is a `set_param`, never a rebuild.
- **Chains precede the library buildout** (M6 before M7) so all ~20 stdlib effects are written `chainParams`-compliant from day one instead of retrofitted.
- **Chain edits rebuild through NFR-5** rather than live-patching the node graph: a throwing step rejects the rebuild and previous pixels keep running — never-go-black needs no new mechanism. Cost: feedback state resets on a successful chain edit (the documented NFR-5 trade). Humans may edit the LIVE chain directly; **agent `set_chain` on the LIVE instance requires the same arming gate as `commit`** (non-live is ungated, matching the existing trust model).
- **"catalog.json" is superseded by `content/CATALOG.md`** (AST-generated, rides `pnpm typecheck`) — the M7 library milestone extends it rather than building the JSON artifact the old plan named.

## 2026-06-10 — post-v1 candidate: PANIC modes (safe scene)

- **PANIC armed modes: HOLD (default, today's freeze) or SAFE SCENE** — cut to a pre-built, always-warm panic instance designated by a `panic.scene.ts` pointer (the `live.scene.ts` twin). Output override, not a commit: LIVE pointer unmoved, RESUME cuts back; broken safe scene degrades PANIC to hold, never worse than today. Full requirements + phased plan in `feature-requests/panic-safe-scene-redesign.md`.

## 2026-06-10 — post-v1 candidate: console screenshot tool

- **`screenshot_console` MCP tool** — agent eyes on the cockpit UI itself (tiles, badges, param panels), not just instance pixels. Console self-captures its DOM in-page (SVG foreignObject) and replies over a new engine→Console reverse request/response envelope (the missing direction on the BroadcastChannel link); sidecar-side headless capture is impossible (BroadcastChannel is same-browser) and CDP attach was rejected for v1 (launch-flag friction). Full plan in `feature-requests/console-screenshot.md`.

## 2026-06-10 — M4 (Clean stage)

- **`#fps` stays in the DOM, hidden, on the pure Output page.** Every validator (m0–m4) gates readiness on `/\d+ fps/` in `#fps`'s text; removing the element would break them all for zero benefit. It's `visibility: hidden` by default, `?hud=1` adds `.show`. The `#status` overlay (and `overlay.ts`) had no validator references and is deleted outright.
- **Cover scaling is CSS, not render-path code.** The Output renders at a fixed internal 1920×1080 (`?res=WxH` override; `renderer.setSize(w, h, false)` so CSS owns the on-screen size) and `#out` uses `object-fit: cover`. The browser compositor does the scaling, so all three never-go-black layers are untouched, `screenshot` returns a stable 1080p regardless of window shape, and render cost stops depending on window size. The previous resize-to-window behavior warped UV-space scenes at non-16:9 aspects.
- **`set_audio` is human-only and not an MCP tool** — an agent must not silently swap the audio source mid-set. Enforcement is doubled: the tool simply doesn't exist on the MCP surface, and dispatch refuses agent-sourced `set_audio` (same `HUMAN_ONLY` set as panic/resume). Device labels populate after mic permission, so the handler refreshes the cached device list after a successful `startMic`; a failed mic always falls back to the test signal (the instrument never goes deaf).
- **`/staged.html` rides the thumbs broadcast** rather than its own readback: the staged instance already renders to its 640×360 preview target every frame, so the page is pure consumer. Its request ids carry a per-tab random prefix — the Console shares the BroadcastChannel and plain sequential ids would resolve across tabs.

## 2026-06-10 — M5 (the input rack)

- **Channel values are computed imperatively in `InputRegistry.update(f)`, not pulled as Signals.** The engine advances every channel once per frame (after `AudioBus.update`), storing a plain number; `ctx.input(name)` returns a Signal that just reads it. This makes "meters work with no consumers" automatic, and stateful detectors/envelopes can never miss time no matter who does or doesn't pull — the M1 "stateful signals must be pulled every frame" hazard doesn't apply to the rack.
- **Onset channels re-read their tuning params every step** (threshold/decay live on the globals manifest) instead of constructing an `OnsetDetector` per options object — that's what makes a `set_param` on `inputs.kick.threshold` take effect the same frame with zero rebuild. `rise`/`refractoryMs` stay code-level opts (defaults, not rack knobs) to keep the rack legible.
- **Redefining the rack carries state forward by channel name+kind:** tuned manifest values AND detector/envelope state survive an `inputs.ts` hot reload, so growing the rack mid-set never resets its feel. A throwing `defineInputs` is caught and keeps the previous rack (never-go-black extends to inputs).
- **MIDI bindings are keyed by SCENE name, not instance id** (`BindingStore`): instance ids churn across rebuilds and sessions, while "this knob is pulse's punch" is durable. A CC writes to every running instance of the scene via `Param.setNormalized` (0..1 → range; bool flips at 0.5). `"globals"` is the pseudo-scene for rack tunings. midi_learn/midi_unbind are HUMAN_ONLY and not MCP tools (same belt-and-braces as set_audio).
- **Tuned state persists through a tiny Vite middleware** (`loom:state`: GET/POST `/loom/state/<name>` ⇄ `content/state/<name>.json`; names sanitized, JSON-validated writes). Globals → `inputs.json`, bindings → `bindings.json`, per-scene values → `values/<scene>.json` — saves debounced 400 ms engine-side. Per-scene values reapply on create/rebuild, making NFR-5's "params reapplied from tuned state" real for the first time: an HMR edit no longer resets sliders. Where a scene has several instances, last-touched wins the file.
- **`?state=off` disables tuned-state load+save; validators m0–m4 boot with it** so a performer's persisted tunings (e.g. a hot kick threshold) can never skew their assertions; validate-m5 runs with state ON (it's under test) and snapshots/restores `content/state/` around the run. validate-m2's "manifest paths" check loosened from exact-equality to subset — `ctx.input()` auto-trims legitimately grew pulse's manifest.
- **`pulse.scene.ts` consumes `ctx.input("kick"/"bass")`** with channel defaults exactly matching its old hand-rolled detector (threshold 0.22, decay 0.22, lag 0.06), so m1's luminance/onset assertions hold unchanged. Other scenes keep raw `ctx.audio` until the M7 retrofit.
- **Mocked MIDI rides the real path:** `MidiBus.inject(cc, ch, v)` (exposed as `window.__loom.midiInject`) feeds the same emit pipeline as a hardware `midimessage`, so validate-m5's learn/binding checks exercise everything but the W3C event plumbing.
- **Test-audio scheduler drops missed beats after a stall.** `startTest`'s lookahead loop used to schedule every missed kick _in the past at once_ when the main thread stalled (e.g. a Playwright screenshot); the pile-up saturated the analyser and read as one giant onset that crossed even a 0.95 threshold — caught as a validate-m5 flake. `next` now fast-forwards past `currentTime` before scheduling.

## 2026-06-10 — M5 follow-up: WebMIDI permission UX (first hardware run)

- **Chrome ≥124 gates ALL WebMIDI behind a permission prompt, and the engine requests it from the Output window — a bare projector page nobody clicks.** First real-hardware run (nanoKONTROL2): the prompt was never granted, `requestMIDIAccess` rejected, and `MidiBus.init` swallowed it silently — "no access" and "no devices" were indistinguishable (`MIDI —`). Fixes: `MidiBus.status` ("off"/"ready") with idempotent, retryable `init()` (a ready bus never re-prompts); the engine retries on pointer gestures and watches `navigator.permissions` for the midi grant; the Console header shows "MIDI: connect" (clickable) when off, and clicking any M learn button without access primes `requestMIDIAccess()` **from the Console window** — the grant is per-origin, so the engine page inherits it and re-attaches via the permission watcher. Same shape as the audio autoplay escape hatch (resume on gesture + mode surfaced in the snapshot).

## 2026-06-10 — Param modulators SHIPPED (design refinements vs the feature request)

- **Phase is a dt-accumulator, not wall-clock or beat-count derived.** Each evaluator advances
  `phase += f.dt / periodSec` only when evaluated; the engine simply skips the modulator pass
  while the stage directive is `hold`. FR-10 (PANIC pauses, RESUME continues without a
  catch-up jump) falls out structurally — no pause bookkeeping anywhere. Consequence:
  `ModulatorBus` is `{ bpm(): number; audio? }` rather than the sketched beats Signal;
  `periodBeats` converts to seconds from live BPM per frame, so tap-tempo retunes every
  synced modulator at once (FR-5) and a PANIC'd beat clock can't replay into a jump.
- **`ModulatorHost` lives in `@loom/runtime`, not the engine.** The per-instance state machine
  (attach/replace/clear, per-frame tick with FR-9 containment, FR-4 reattach-after-rebuild
  with orphan flagging and fix-forward recovery) is fake-clock unit-tested against a
  `ManifestLike` slice; `SessionStore` just owns one host per entry and calls
  `tickModulators(f)` before compositing. The engine only schedules and stores (NFR-2).
- **Spec validation is engine-side** (the dispatch is the protocol boundary, matching every
  other command): the wire carries the modulator as an opaque JSON object; the runtime's
  strict zod `ModulatorSpec` rejects unknown keys/typos with real errors.
- **`cycle` on ints accepts an explicit `values` list too** (the 4→8→16→32 slices case);
  without one it steps the integer lattice of [lo, hi].
- **Acceptance is `pnpm validate:modulators`** — the `validate:m*` numbering stays reserved
  for roadmap milestones. m3/m4's expected MCP tool lists grew by the two new tools (their
  intent — exactly-these-tools, no `set_audio` for agents — is preserved).

## 2026-06-11 — Feature request: Console screenshot for agents (post-v1 candidate)

- **`screenshot_console` MCP tool** — agent eyes on the cockpit UI itself. Existing `screenshot` can't reach a sibling tab; CDP attach is the likely winner. Full analysis + candidate approaches in `feature-requests/console-screenshot.md`.

## 2026-06-11 - Image/transform building blocks (image, Transform2D, transform2d)

- **`image` replaces `imagePlate`**: the base image source only loads/draws (aspect-correct,
  upright, premultiplied alpha); placement is an attached `Transform2D`, not baked-in opts.
- **`Transform2D` is a concept, not just a module**: a plain interface of live signals
  (x/y/rotate/scale/mirrorX) plus the shared `localSpace()` mapper in
  `content/modules/effects/transform2d.ts`. Sources sample through it directly (no render
  target, no resolution loss); the `transform2d` effect module wraps the same mapper around
  an owned RT for transforming arbitrary TexNode chains (glitch-shaped).
- **Why two paths**: a generic TexNode transform must rasterize first (a node graph cannot be
  re-evaluated at shifted UVs), but image sources can sample their texture anywhere - forcing
  everything through RTs would cost a pass per sprite. `flyby` composes 5 sprites as
  `image`+`Transform2D`+`over` with zero extra passes.
- **Shader-build gotcha (repeat offender)**: TSL `mix(1.0, node, node)` with a plain JS number
  as the FIRST arg builds a shader that silently fails to compile - the instance reports ok
  but its render target never gets written (screenshot errors with "reading 'format'").
  Wrap leading literals: `mix(float(1), ...)`.

## 2026-06-11 - Unified Transform: 2D and 3D tilt in one concept (no Transform3D split)

- **One interface, not two**: `Transform` (transform.ts, replacing transform2d.ts) adds
  rotateX/rotateY/perspective to the 2D fields. A plane under rigid 3D transform +
  pinhole projection is a homography - closed-form inverse - so sources still sample
  through `localSpace()` with no render target; absent fields reduce exactly to the old
  affine path. Every consumer keeps a single attachment point.
- **Per-layer perspective** (anchored at the layer center, CSS-style) rather than one
  global camera: tilt reads the same anywhere on screen, which is what compositing wants.
- **Cramer instead of `inverse(mat3)`**: TSL's matrix inverse isn't guaranteed on the
  WGSL backend; cross/dot are universal.
- **Scope line**: this stays a 2.5D compositor transform. Real geometry/camera work
  (the reserved `geo` module kind) should use three's scene graph, with the compositor
  Transform moving that rendered layer like any other image.
- **Derivative-poisoning gotcha**: guarding invalid uv regions with a huge sentinel
  (mix to 1e6) or number-FIRST TSL args (step(0.0, node)) collapses texture sampling to
  the lowest mip everywhere (giant mosaic). Guard by adding a SMALL node-first offset:
  `local.add(behind.mul(10))`.

## 2026-06-11 — Console + Staged pages rebuilt on React + MUI

The cockpit pages outgrew hand-rolled DOM diffing (console.ts was ~800 lines of
querySelector bookkeeping). Both pages are now React 19 + @mui/material 7 apps
under `packages/engine-app/src/ui/`, with a framework-free `EngineLink` class
(unit-tested) owning the BroadcastChannel protocol. Deliberate choices:

- **No @vitejs/plugin-react.** Vite's esbuild compiles .tsx natively
  (`"jsx": "react-jsx"` in tsconfig.base.json); vite.config.ts is unchanged, so
  the scenes HMR path — never-go-black layer 1 — is provably untouched. Editing
  a cockpit .tsx full-reloads the cockpit tab only; the Output window doesn't care.
- **The validator DOM contract is preserved** (.tile[data-id], #commit, #panic,
  data-path on the real input, data-learn text M/···/cc<N>, .rackfill inline
  width, body.disconnected). One validator change: validate-m3 writes the slider
  through HTMLInputElement's prototype value setter because React dedupes direct
  .value writes (and waits with state:"attached" since MUI's range input is
  visually hidden).
- The Output window (index.html + src/main.ts) stays vanilla on purpose: it is a
  pure projector surface; a React tree there buys nothing and risks the render loop.

## 2026-06-11 — M6 global color palettes (palette half)

Two global 5-stop palettes (`primary`/`secondary`) live on a `PaletteRegistry`
in `@loom/runtime`, served through the existing `"globals"` pseudo-instance by
merging the registry's manifest with the input rack's, routed by path prefix
(`palette.*` → palettes, else rack). Scenes consume via `ctx.palette.color(i)`
(vec3 stop uniform), `ctx.palette.ramp(t)` (256×1 `DataTexture` gradient), and
`ctx.palette.own([...5])` (scene-default stops). Decisions:

- **`color` is a kernel param type** (`Param<string>`, `"#rrggbb"`). Its clamp
  **throws** on a non-hex value rather than silently coercing — `set_param`
  surfaces a clean error to agents. Because a corrupt persisted value would then
  throw at boot, all three state-restore paths (`main.ts` inputs + palettes
  loops, `SessionStore.applyTuned`) wrap each `param.set` in try/catch and keep
  the code default on failure.
- **`setNormalized` is a no-op on color params** — a 0..1 CC has no honest color
  mapping. A MIDI CC bound to a stop is a harmless no-op; binding `palette.source`
  (an int) to a knob is the point.
- **`labels` meta on ranged specs** (`int`/`float`): an array of value names that
  the Console renders as a `ToggleButtonGroup` instead of a slider. Generic
  int-selector affordance; first user is `palette.source`.
- **`palette.source` is an int param 0..2** (primary/secondary/own), declared in
  a new `BuildCtx.finalize()` hook that `buildInstance` calls after `build()` —
  deferred so its default can honor whether the scene called `own()` (own→2,
  else→0). Ints keep MIDI-learn, `cycle` modulators, and number-typed persistence
  working for free. Switching source is a plain `set_param`, resolved per frame
  by one updater that re-tints uniforms / re-uploads the ramp only when the
  resolved stops actually change — **never a rebuild** (R7.2).
- **"own" falls back to primary** live when a scene selected source=own but never
  declared `own()` stops — keeps the 3-way switch total.
- **Modulators reject color params** at attach (their evaluators produce numbers).
- **`builds` counter per session entry** (1 on create, ++ per successful rebuild),
  exposed in `get_session` instances and `window.__loom` — validators assert
  "no rebuild" against it (M6 needs it twice; the chains half will reuse it).
- Palette tunings persist to `content/state/palettes.json` via the `loom:state`
  middleware. Stop roles (0 bg · 1 edge · 2/3 core · 4 accent) are documented
  convention, not kernel vocabulary (R7.1).
- **`gradient` scene** added as the minimal `ramp()` consumer (and the validator's
  ramp target); `lava` converted to `ctx.palette` stops with an `own()` default
  reproducing its original ink/ember look.
- **`unstage` added as an MCP tool** (agent surface 10→11): clearing the staged
  candidate is as safe as staging, and agents auditioning palette/source variants
  need to drop a candidate without a human. The four tool-surface validator
  assertions (m3/m4/m5/modulators) gained `"unstage"`.

## 2026-06-11 — Docs refactor: one source of truth per fact, one doc per audience

- **`docs/architecture.md` is now THE architecture doc**; root `CLAUDE.md` slimmed to orientation + commands + the never-go-black paragraph + a doc map (the old "read 4 docs before work" list cost ~88KB of context per session). `loom/.claude/` stays the complete, self-sufficient surface for visuals agents.
- **`implementation-plan-v1.md` → `docs/roadmap.md`** (shipped table + remaining milestones); original archived in `docs/history/`. `requirements-v1.md` moved to `docs/` unchanged.
- **`agent-updates.md` retired** (archived as `docs/history/agent-updates-m0-m6.md`): milestone ships are now ≤6-line SHIPPED entries here — one log, not two. Durable gotchas distilled into the skills.
- **`artifacts/` gitignored** — supersedes the M0 "validation artifacts committed as evidence" decision; the evidence is the validator's pass/fail output, screenshots are regenerable local scratch.
- **`loom:catalog` Vite plugin**: the dev server regenerates `content/CATALOG.md` on every module/scene save (debounced, failures logged and swallowed), closing the gap where live sessions never run `pnpm typecheck` and the library's search surface went stale exactly when agents needed it.
- Spec: `docs/history/superpowers/specs/2026-06-11-docs-refactor-design.md` (archived 2026-06-13). The in-flight `m6-color-chains` worktree predates this layout — on rebase, redirect its doc steps (ship entry → DECISIONS, guide edits → new paths).

## 2026-06-11 — mandelbloom palette showcase SHIPPED

- **The `mandelbrot` source module absorbed the dive animation** (optional `glide` lag on
  cx/cy + `dive`/`depth`/`baseScale` ping-pong zoom integrator) instead of a separate
  `mandelDive` module — one abstract source covers both the static renderer and the
  self-diving case. The no-`dive`/`glide` path is byte-identical, so existing callers are
  unaffected; `mandelbrot.scene.ts` was refactored onto it, deleting its duplicated integrator.
- **New `paletteMap` effect** (`content/modules/effects/paletteMap.ts`): maps input luminance
  through the **global** palette ramp (`ctx.palette.ramp`), the palette-native sibling of
  `colorize` (which only knows the cosine PALETTES presets). Any scene using it auto-declares
  `palette.source`.
- **New `mandelbloom` scene** showcases R7 palettes: exterior filaments via the ramp, a
  kick-blooming "garden" (warped noise + blobs, discrete stops) in the black interior, an
  accent-stop boundary rim for contrast, then feedback → glitch → levels. One `palette.source`
  flip (own/primary/secondary) retints the whole frame with no rebuild (verified `builds`=1).
- Gates: `pnpm typecheck` + `pnpm test` green; `pnpm validate:m6` green; eyes-on via MCP
  (retint with no rebuild; garden blooms on mic audio). Spec + plan under `docs/history/superpowers/`.

## 2026-06-11 — Console UI redesign SHIPPED

- **Console cockpit rebuilt for cohesion + density** (spec/plan under `docs/history/superpowers/`):
  LOOM wordmark; BPM readout and TAP consolidated into one tappable chip; FPS promoted to a
  first-class mono readout; output/staged open in new tabs; slim stage bar; tiles carry their
  chrome as overlays (LIVE = red ring + chip, hover-only destroy ×); drag-reorder persists to
  localStorage; param drawer resizable (240px–60vw, persisted); palettes are swatch-only with
  hex tooltips; staged instance streams at 640×360 so /staged.html shows real detail.
- **Scene picker is a ghost "+" tile**: a grid of scene cards showing each scene's _last-run
  snapshot_ (`loom.scenethumbs` in localStorage, fed by every rendering tile). Hovering a card
  shows its snapshot in the tile instantly, builds a REAL sandbox instance after 250 ms, and
  swaps in live pixels when they arrive — the tile never blanks mid-swap (the v1 list flickered:
  destroy-then-create left a blank gap). Preview destroyed on close/move, never more than one
  alive; the grid hides the preview's own tile until picked.
- **Agent commit defaults ARMED** ("let the agent commit by default for now" — Zack);
  `?agentCommit=0` or the Console checkbox restores the gate. \*\*Drop on the stage bar = stage
    - commit\*\* (human-sourced, never gated). validate-m3/m4 acceptance moved with the behavior:
      the gate is now proven via disarm instead of via arm, drag-to-strip asserts go-live.
- Gates: typecheck, unit tests, validate m0–m6 + modulators all green (m5 flaked once on the
  envelope-drain window, clean on rerun). Eyes-on via validator + peek screenshots.

## 2026-06-11 — Console works without the Output tab visible (+ QoL batch)

- **Worker clock for hidden tabs**: browsers freeze rAF and clamp main-thread timers to
    > =1 s when a tab is backgrounded, so the Console went dead whenever the Output tab
    > wasn''t showing. A dedicated-worker interval (exempt from timer throttling) drives
    > `frameTick` at ~30 fps while `document.hidden`, and the console-channel state/thumb
    > broadcasts moved to the same worker clocks. `__loom.clockSource` reports which clock
    > drove the last frame (raf | worker).
- **/staged.html presents like the Output window**: preview fills the viewport,
  cover-scaled, under its slim header (was a small contain-fit image).
- **palette.source moved to the param drawer** (Zack: belongs with the instance''s params,
  not the sub-header). ParamPanel hoists it flat — never buried in an accordion; the
  stage bar lost its toggle; /staged keeps one (no drawer there). m6 §9 now drives the
  drawer toggle.
- **Named palette presets**: per-row dropdown in the Rack applies curated built-ins or
  user-saved palettes (5 stops, live retint via set_param); "save as…" names the current
  stops (localStorage `loom.palettepresets`, user entries shadow built-ins).
- Gates: typecheck, unit tests, full validate m0–m6 + modulators green; worker-clock
  render path proven via forced-hidden probe (clockSource=worker, thumbs streaming).

## 2026-06-11 — Roadmap restructure: depth before library, assets get milestones

- Zack's call: split the old Geo-&-particles L into two milestones and move them **ahead of**
  Library & parallel build — M7 Geo, M8 Particles (particles consume M7's `GeoNode`). New
  milestones: M9 video sources (clips usable exactly like images, mirroring `sources/image.ts`),
  M10 asset explorer (left Console pane: modules binned by kind, TouchDesigner-style, plus
  user-registered external folders — e.g. a VJ Assets dir — with select/drag as the interaction
  model). Library is M11, gig hardening M12.
- New ordered Housekeeping block in the roadmap: cull `hello`/`pulse-glitch`/`vinyl` scenes
  (`pulse` stays — every validator pins it as its live scene, so culling it would mean re-pinning
  six validators; Zack chose to keep it as the test workhorse), then a param-group naming
  pass over surviving scenes; Console mod-popover default becomes 20 s (was 4 beats; runtime
  has no default to change); double-click-to-rename instance tiles; 2× tile thumbnails.

## 2026-06-11 — The Output window is optional: embedded console engine

- The previous worker-clock fix only covered "Output open but backgrounded" — Zack opens
  the Console _alone_. The Console now boots an **embedded engine** in a hidden same-origin
  iframe (`/?embedded=1&audio=test`) when no engine says hello within 2.5 s.
- **Takeover protocol** (console-channel): state broadcasts carry `engineId`/`embedded`;
  an embedded engine that hears another engine''s state **stands down completely** — stops
  the render loop, the worker clocks, the WS bridge (no zombie reconnects racing
  "latest connection wins" at the sidecar), and stops answering channel requests. The
  Output window always wins; embedded peers tie-break on id. The Console follows the new
  engine seamlessly.
- Worker fallback clock now also fires on **rAF starvation** (>150 ms without a rAF tick),
  which covers offscreen-iframe throttling, not just `document.hidden`.
- Audio: AudioContexts need a user gesture the iframe never gets — the Console forwards
  its pointerdown to `iframe.__loom.resumeAudio()` (activation is visible to same-origin
  frames). Embedded boots on the test signal; switch to mic from the header picker.
- Validator consoles pin `?embed=0` — an embedded engine would dial the DEFAULT sidecar
  port and break run isolation.
- Gates: typecheck, unit tests, full validate m0–m6 + modulators green. Solo probe:
  console alone → boot tile + thumbs stream; real Output opened → embedded frame counter
  freezes, console stays connected.

## 2026-06-11 — Selection halo, name-only tiles, rename_instance, pnpm validate

- **Selection and stage status get separate visual channels**: status stays the inner
  ring (red LIVE / amber STAGED) + chip; selection is an OUTER green halo past a gap
  (Figma-style) + tinted name row — a selected live tile reads "red ring inside a green
  halo". Previously one ring served both and selection vanished on live/staged tiles.
- **Tiles show just the instance name** (scene moved to the tooltip and the param-drawer
  header, which also gained LIVE/STAGED chips). **Double-click renames inline** via a new
  human-only `rename_instance` command: `SessionStore.rename` re-keys the entry (no
  rebuild), `Stage.onInstanceRenamed` carries live/staged/fade pointers (unit-tested),
  reserved names refused, `boot` exempt (bound to live.scene.ts hot-swaps). Not an MCP
  tool — the agent tool surface is validator-pinned.
- **`pnpm validate` runs every acceptance suite** in order, stopping on first failure.
- **m5 de-flaked**: "threshold 0.95 zeroes kick onsets" raced the synthetic kick (any
  threshold < 1 can be grazed; ~1-in-3 flake). The check now also sets the kick
  envelope gain to 0 — deterministic silence, same late-binding semantics.
- Gates: typecheck, unit tests (+ new stage rename test), full `pnpm validate` green
  (139 checks). Eyes-on: selected-live halo, selected-staged halo, rename end-to-end
  (tile id, stage pointer, drawer header all follow).

## 2026-06-11 — SHIPPED: Housekeeping batch

- Scene cull (hello/pulse-glitch/vinyl; pulse kept as validator workhorse), param groups for
  fireflies/mandelbrot/mandelbloom with persisted-value key migration, 20 s modulator default
  (ModPopover seed only — runtime requires an explicit period), 2× tiles (480px columns),
  whole-top StageDropZone (strip alone was too thin; #stagestrip id kept, validator drags bubble).
- Gates: typecheck, unit tests (137+24+7), full `pnpm validate` (m0–m6 + modulators) green.
- Deviation: thumbnail capture stays 320×180 until the rename workstream's engine-api lands
  (follow-up noted in roadmap). Stumble: a parallel session edited the same console files
  mid-run — every commit used explicit path lists, no `git add -A`.

## 2026-06-12 — CI on GitHub Actions + Cloudflare Pages preview + PR screenshots

- **First production build target.** The standing decision was "Vite dev server =
  the deploy mechanism" (no build step). For phone-openable PR previews we added a
  static multi-page `vite build` (Output `/` + Console `/console.html` + Staged
  `/staged.html`) in `engine-app/vite.config.ts`. Dev server, HMR, and never-go-black
  are untouched — the build is a _parallel_ artifact, not the live runtime. The
  static bundle is "view + tweak" only: the sidecar WS is absent and the bridge's
  reconnect loop no-ops harmlessly; live agent/MCP editing stays in the dev session.
- **Validators are now Linux-portable.** They hardcoded `--use-angle=d3d11` (Windows).
  Centralized GL flags in `scripts/_browser.mjs` (`glArgs`), chosen by platform and
  overridable with `LOOM_GL`; Linux/CI defaults to SwiftShader, the software GL that
  drives the same WebGL2 fallback the checks already assert against.
- **pnpm 11 portability.** `pnpm.onlyBuiltDependencies` (read by pnpm 10 from
  package.json) moved to `pnpm-workspace.yaml` `allowBuilds: { esbuild: true }`;
  pinned `packageManager: pnpm@11.6.0` for reproducible installs (corepack + CI).
- **Preview + screenshots ride the same deploy.** `scripts/shoot.mjs` renders scenes
  to PNG (same spawn-vite + headless-Chromium pattern as the validators, restores
  `live.scene.ts`); the preview job shoots into the deploy's `shots/` and
  `scripts/preview-comment.mjs` embeds them inline in a sticky PR comment — no git
  binaries. Durable in-diff stills go to the tracked `preview/screenshots/` when
  authoring a visual.
- Cloudflare deploy/comment steps skip gracefully until `CLOUDFLARE_API_TOKEN` +
  `CLOUDFLARE_ACCOUNT_ID` secrets exist; the build still runs so the bundle stays
  tested. Setup: `docs/ci-and-preview.md`. Gates: typecheck + unit tests green
  locally; validators run in CI (no GPU in this dev container to run them here).

## 2026-06-12 — Headless CI tuning: required gate vs advisory validators

Getting the validators green on GitHub's GPU-less runners surfaced three headless
realities (the validators were written for a real GPU + manual WebGPU checks):

- **Force WebGL2 by hiding `navigator.gpu`.** Chrome 148 headless exposes a
  software WebGPU adapter regardless of flags (`--disable-features=WebGPU` etc.
  don't stick), so `WebGPURenderer` picked WebGPU and rendered blank-white or hung
  the screenshot. A Playwright init script (`forceWebGL2`, `scripts/_browser.mjs`)
  defines `navigator.gpu` as undefined → three falls back to the WebGL2 backend the
  assertions are calibrated for. Chromium GL flags only choose SwiftShader as the
  WebGL2 _provider_.
- **`LOOM_RES=640x360` in CI.** Software WebGL2 can't render heavy scenes
  (pho-nebula's multi-pass feedback) at 1080p fast enough for the compositor to
  hand Playwright a frame; the shot times out. A `resQuery` (gated on `LOOM_RES`)
  drops the internal render res for CI only — local hardware keeps full fidelity.
- **Headless audio/MCP-readback are flaky.** The synthetic `AudioContext` yields
  only a couple of analysable kicks (onset detectors can't re-arm), and the MCP
  `screenshot` tool's `readRenderTargetPixelsAsync` returns no image under software
  GL. Rather than weaken the suite further or change `engine-app`, CI splits:
  **required gate** = typecheck + unit + build + **m0** (deterministic HMR /
  never-go-black smoke); **advisory** (non-blocking) = m1–m6 + modulators. They
  still run every PR for signal but don't gate merge. Full acceptance stays a
  real-GPU / manual exercise, exactly as the validators were designed.

## 2026-06-11 — Raw-MIDI monitor in the session snapshot (first real-controller debugging)

A nanoKONTROL2 in a non-default mode (relative knob ticks, non-CC faders) looked
simply "dead" to MIDI-learn: the engine acts on Control Change only and dropped
everything else without a trace, making the failure undiagnosable from inside
LOOM. `MidiBus` now keeps the last 16 raw messages — including the traffic it
ignores, minus realtime keepalives (clock/active-sensing) — surfaced as
`midi.recent` in the session snapshot (`.default([])` keeps older engines
parseable) and as a live monitor dialog behind the Console header's MIDI status.
The engine still _acts_ on CC only; the monitor is eyes, not new routing.
Hardware lesson for the books: constant repeated CC values or pitch-bend faders
mean the controller needs a factory reset to CC mode, not an engine fix.

## 2026-06-11 — SHIPPED: MIDI button bindings (modes + actions pseudo-scene)

Bindings carry mode absolute/set/cycle (rising-edge for buttons): set
accumulates radio groups, cycle wraps ints / flips bools (Param.cycle —
renamed from step() in review: collided with the RangedSpec step slider
hint), and pseudo-scene "actions" (live.next/live.prev) steps LIVE through
ok tiles via stage/commit as a human gesture (mash-safe; clobbers a pending
staged candidate by design). Gates: typecheck, unit (154), validate-m5 34/34,
full pnpm validate. Stumble: validator waitFor treats falsy as "not yet" —
never return a flipped bool from a poll. Spec:
docs/history/superpowers/specs/2026-06-11-midi-button-bindings-design.md (archived 2026-06-13).

## 2026-06-11 — Stdlib tests & robustness SHIPPED

- **Real BuildCtx, not a mock**: the roadmap asked for a mock BuildCtx, but the real one
  is already GPU-free (its only three import is `uniform` from three/tsl) — so the
  content/ test root (`loom/vitest.config.ts`, happy-dom for TextureLoader''s DOM Image)
  builds modules with the REAL BuildCtx over mock/real buses (FakeAudioBus, real
  TimeBus/InputRegistry-with-the-actual-rack/PaletteRegistry). `ProbeCtx` records every
  uniform a module registers; finiteness over those probes is total NaN detection for
  CPU-side signals.
- **Coverage is automatic**: `import.meta.glob` discovery sweeps every module file;
  tier-1 (kind↔folder, metadata, output shape, `[...input.passes, own]` via a marker
  pass, honest ranges incl. no degenerate min==max) and tier-2 (param-extremes sweep,
  60 frames per setting, black-input builds for effects) run per discovered module. A
  module without a `cases.ts` entry fails the completeness test — "new modules merge
  with their tests" is mechanical, not policy.
- **Golden patterns as tests**: no `audio.onset(` in modules OR scenes (named rack
  channels only, R6.4). The scan immediately caught `lava` and `mandelbloom` re-detecting
  kick locally — both converted to `ctx.input("kick")`.
- **Ship-gate self-test**: deliberately broken modules (NaN at a param extreme, dropped/
  reordered input passes, malformed metadata, dishonest ranges) are provably caught.
- **Tier-3 smoke render** (`validate:stdlib`): every module hot-swaps into the live
  engine in a generated sandbox scene (effects over osc, controls driving osc) and must
  render non-black with a clean console; appended to `pnpm validate`.
- Gates: typecheck; `pnpm test` = 312 tests (168 package + 144 content); full
  `pnpm validate` = 162 checks across 9 suites, all green. Spec + plan under
  `docs/history/superpowers/`.

## 2026-06-12 — Better panic button (PANIC modes: hold | safe scene)

Implements `feature-requests/panic-safe-scene-redesign.md`. PANIC gains an armed mode: **hold**
(freeze the last frame, unchanged default) or **scene** (hard-cut to a warm,
always-rendering safe scene). Gates run: `pnpm typecheck`, unit tests (runtime
144, sidecar 24, engine-app 7), `validate:panic`.

- **Runtime stays minimal (NFR-2).** Stage adds one directive mode
  (`panic-scene`, carrying the panic instance id + the untouched live id) and a
  `panic(mode, panicId?)` signature; `held: boolean` became `panicState: "hold"
|"scene"|null`. Scene-panic is an output override — the LIVE pointer never
  moves (FR-4), so RESUME is just "clear panic" with no bookkeeping. Re-press
  only escalates hold→scene; scene→hold is a no-op (FR-6). Everything else
  (warm-instance lifecycle, compositor leg, fallback) lives in engine-app.
- **Worst case = today.** A broken/absent safe scene routes to hold (FR-7); a
  render-throw in the panic instance freezes it → the compositor skips it →
  hold (FR-8). Never worse than the pre-feature behavior.
- **Deviation from the spec's resolved-decision #1 (designation via
  `panic.scene.ts` pointer, _not_ a Console picker), at the user's request:**
  the SAFE target is now a **movable designation over existing instances** — the
  ⛑ SAFE marker and scene-panic routing point at whichever instance the human
  picks from the Console (`set_panic_instance`, human-only), exactly like LIVE /
  STAGED are instance pointers. `panic.scene.ts` builds the boot-default safe
  instance (id `"panic"`, the initial designation + guaranteed fallback);
  picking any other instance moves the designation (and destroy/rename
  protection) to it with no rebuild. Persisting the designated instance's scene
  name lets the boot default reflect it across a restart (instance ids are
  ephemeral). The "pick any instance / multiple named safe scenes" item moves
  from out-of-scope to shipped.
- **Trust tiers unchanged.** `panic`/`resume`/`arm_panic_mode`/`set_panic_instance`
  are human-only (Console); agents only observe via `get_session`
  (`panicMode`/`panicActive`/`panicScene` + the `pinned:"panic"` instance) and
  are told to stop touching the live path while `panicActive` is non-null.

## M6 chains half — per-instance post-effect chains (2026-06-12)

- **Enable/disable is a wet/dry `fx.<id>.mix` float param, not a structural
  field.** Every step is always built; the fold wraps it as
  `mix(input.rgb, effect.rgb, mix)`. So toggling/fading an effect is a plain
  `set_param` (no rebuild, MIDI-bindable, ridable on a fader) and bypassed steps
  keep their passes running — stateful history (feedback) stays warm. Structural
  edits (add/remove/reorder/insert) rebuild; mix rides don't.
- **Chains are runtime data on the session `Entry` (a `ChainHost`), folded inside
  `buildInstance` before `finalize()`.** A throwing step throws the whole build →
  NFR-5 rejects it and the previous chain + pixels keep running. No new
  never-go-black mechanism. Mirrors `ModulatorHost`: instance-scoped, survives
  rebuilds, reseeded with carry-forward by stable step id (`<effect>-<n>`).
- **`set_chain` is full-list/idempotent** (the whole desired step list) so
  add/remove/reorder/insert are one verb. Agent edits to the LIVE chain need the
  same arming gate as `commit`; sandbox edits are ungated. Humans (Console) are
  never gated. `restoreDefault` resets to the scene's declared `chain`.
- **Saved chains are composite effects: data, one level deep.** `save_chain`
  writes `content/modules/effects/chains/<name>.chain.json` (a `loom:effects` Vite
  middleware, sibling to `loom:state`); the effects barrel globs them alongside
  code primitives. A composite folds its inner primitives, namespaced
  `fx.<id>.<inner>.<param>`. A composite may not contain a composite (cycle guard).
- **Chain knob values live in the chain data (session-lived), not
  `values/<scene>.json`** — `fx.*` is filtered out of per-scene persistence. Full
  chain snapshot/restore across reload stays M9.
- **Scenes may declare a default chain** (`defineScene({ chain: [...] })`), seeded
  at create and restorable; scene-code HMR updates the stored default but never
  clobbers a chain the user/agent has since edited (same rule as tuned params).
- **SHIPPED:** runtime `ChainHost` + fold (`chain.ts`), `meta.chainParams` on
  `glitch`/`feedback`/`levels`, engine-app effects barrel + `set_chain`/`save_chain`
    - Console FX-chain panel (cards, drag-reorder, insertion points, mix faders,
      picker, save-as, restore). Gates: typecheck + unit (runtime `chain.test.ts`,
      sidecar protocol) + production build green. `validate:m6` chain checks added but
      **not run here** — this sandbox is egress-blocked from Playwright's browser and
      the substituted system Chromium can't do the WebGL readback (the palette half's
      first screenshot times out too); run it on a real-GPU/CI browser.

## Layers — named nodes, per-node rigs & chains (2026-06-11)

- **`ctx.layer(name, tex)` is the one new BuildCtx primitive.** It folds a
  uniform-driven rig (`<name>.layer.x/y/scale/rotate/opacity`, identity defaults,
  2D affine + opacity through one RT pass mirroring `transform`'s mechanics —
  `set_param` never rebuilds) and the node's FX chain via a session-injected
  `foldNode` hook. Explicit-only: unwrapped nodes cost nothing. Duplicate /
  reserved / malformed names throw (NFR-5 contains them).
- **Parentage is detected via marker passes**: wraps register bottom-up; an outer
  wrap claims any not-yet-parented node whose rig pass is in its input's pass
  list. Works through pass-merging composition (`over`).
- **Per-node chains are `ChainHost`s with a path prefix** (`<node>.fx` vs root
  `fx`) in an `Entry.nodeChains` map, lazily created on first `set_chain {node}`;
  node chains have no scene default (restoreDefault clears). Same NFR-5 + arming
  semantics as root.
- **Node-chain wet/dry preserves the INPUT's alpha** (root keeps M6's lock-to-1):
  most stdlib effects emit alpha 1, which would make a chained overlay-node
  full-frame opaque. Consequence: node FX recolor within the node's silhouette;
  silhouette-expanding FX (feedback halos) belong inside the wrap or on the root.
  Revisit by auditing effect alpha propagation if it pinches.
- **Manifest stays flat** — paths encode the tree; modulators, MIDI-learn, tuned
  persistence work on layer params unchanged. `get_manifest`/`get_session` gain
  `nodes: [{id, parent, chain}]`; the Console renders node groups (⬚, parent
  annotation) each with its own FX chain. MIDI e2e intentionally not re-validated
  (path-generic, m5 covers the mechanics).
- **SHIPPED:** runtime `layer.ts` + `BuildCtx.layer` + ChainHost prefix; session
  nodeChains + `set_chain` node arg; Console node sections; `vinyl-zoom` (dive/
  logo/hippos) + `pho-nebula` (bowl/garnish/badge) wrapped. Gates: typecheck,
  pnpm test (353), `validate:layers` 22/22, full `pnpm validate` green.

## Projects — set lists (2026-06-11)

- **A project is the serialized instance set**: per instance `{scene, values,
modulators, root chain, per-node chains}` in tile order + which one was live,
  written to `content/state/projects/<name>.json` through the existing
  `loom:state` middleware (set lists live in git, NFR-4). Chain knob values ride
  in the chain data, never in `values` (same rule as per-scene persistence).
- **Loading is audience-safe**: every instance builds into a sandbox via a new
  `SessionStore.create(def, id, init)` seed path (chains + values fold into
  build #1 — no rebuild storm); the Stage is never touched. The pre-load
  instances cull only after a commit FROM the loaded set lands (fade complete;
  deferred-cull check in the render loop). Ids are kept when free, `~n`-suffixed
  when taken — loading twice is legal.
- **Per-instance values override per-scene tuned defaults** at load (two
  differently-tuned instances of one scene can coexist in a project).
- **Trust tiers**: `load_project`/`list_projects` are ungated (loading is free);
  agent `save_project` needs arming like commit (it writes a repo file). The
  Console has a load switcher + save dialog (tile order captured from the grid);
  the engine caches the project list for the snapshot, `loom:state-list` lists
  the directory so git-dropped files appear too.
- Projects save/load deliberately IGNORE `?state=off` — explicit user actions,
  not ambient persistence (validators still snapshot/restore content/state).
- **SHIPPED:** engine `ProjectStore` + deferred cull (main.ts), session init
  seeding, 3 MCP tools, Console header control, `validate:projects` 23/23,
  engine-app `projects.test.ts` round-trip; full gate green.

## M9 — Video sources (2026-06-11)

- **`video` module mirrors `image`** (same localSpace placement, premultiplied
  alpha, contain-by-height): an HTMLVideoElement + three `VideoTexture`, muted
  by default. `speed`/`scrubbing`/`scrub`/`loop` are **SignalLike opts** (the
  module-authoring rule: params live in scenes, modules take Signals) — scenes
  wire them to params, so set_param retimes/scrubs with no rebuild. The element
  is driven CPU-side in the module's pass, fully guarded: a missing/unsupported
  clip stays transparent, never throws the build.
- **`loom:media` middleware** serves repo-EXTERNAL files (`/loom/media?p=<abs>`)
  with HTTP Range support (video seeks need 206); confined to roots registered
  in `content/state/media-roots.json` (read per request, hot-editable; 403
  outside). `mediaUrl(absPath)` in video.ts builds the URL. M10's asset
  explorer grows on this registration.
- **Asset reality**: the artist .mov loops are MJPEG (Chrome can't decode) — the
  Beeple .mp4s play directly; `Videos/transcoded/` holds h264 transcodes of two
  loops (ffmpeg, not in repo). A committed 23 KB testsrc2 clip
  (content/assets/test/clip.mp4) makes the validators machine-independent.
- `beeple-wall` scene: two video decks (city + kaleido-folded tunnel) with
  speed/scrub params, layer-wrapped, kick-driven levels.
- **SHIPPED:** video module + cases.ts entry (tier-1/2 swept), stdlib smoke
  covers it, `validate:m9` 14/14 (play/freeze/scrub/loop with no rebuild, M4
  cover checks on a video source, Range/403/404 middleware, external clip e2e).

## Fixtures — deterministic input traces (2026-06-11)

- **A fixture is the rack's POST-DETECTOR values, one row per frame**
  (`content/state/fixtures/<name>.json`: name/bpm/channels/frames) — replay
  needs no audio, no detectors, no timing luck. `record_fixture` captures the
  live rack in the render loop; `create_instance({inputs:"fixture:<name>"})`
  replays it through a `FixturePlayer` (an `InputProvider` — `ctx.input` is
  late-bound, so scenes change not at all).
- **`screenshot({frames:[…]})` is a deterministic offline pass**: the entry's
  scene is REBUILT against the trace on a virtual clock (frame 0, dt 1/60, own
  TimeBus at the trace's bpm, silent audio), with its tuned values + chains +
  modulator specs mirrored, stepped to each requested frame and read back.
  Same fixture + frames → byte-identical PNGs, every call, across instances.
  The live entry is never touched (builds counter unchanged).
- **TSL `time` is banned from content/** (golden-pattern scan): it reads the
  renderer's WALL clock, bypassing the frame clock — the one nondeterminism
  the first validator run caught (7 modules migrated to
  `ctx.uniformOf(ctx.time.now)`). Frame-clock time also means a virtual clock
  can pause/step scenes — groundwork M11/M12 want anyway.
- **SHIPPED:** runtime `FixturePlayer`/`InputProvider` (+ unit tests), session
  fixture entries (rebuild-safe), record/replay/shots in main.ts, MCP
  `record_fixture` + extended `create_instance`/`screenshot`,
  `validate:fixtures` 11/11. Tool-surface assertions moved (m3/m4/m5/modulators).

## M7 — Geo (2026-06-11)

- **GeoNode/CamNode join ModuleOutput** (`{object: Object3D}` / `{camera}`,
  runtime geo.ts): geo modules return scene-graph fragments, never pixels.
  The `render3d` bridge (a SOURCE) owns a Scene + default hemi/key lights +
  an MSAA HalfFloat RT sized to the destination, renders world+cam per frame,
  returns a TexNode — so meshes flow through chains, layers and 2D effects
  unchanged. Transparent clear by default (composites over anything).
- **Primitives** (box/sphere/torus over a shared `_primitive` helper) carry
  live spin/tumble/glow/scale via ctx.updaters (frame-clock — deterministic
  under fixtures). `orbitCam` integrates speed (rad/s) the same way.
- **`model` loads glTF AND FBX** (the user's hippo is FBX; three's loaders,
  fflate bundled). Loaded materials are NORMALIZED to MeshStandardMaterial
  (color + diffuse map): FBX phong with layered textures threw inside the
  WebGL backend and froze the instance (NFR-2 caught it; the readback of the
  never-written preview target was the visible symptom). Async load into a
  placeholder group, bbox recenter + height-normalize; missing files stay
  empty, never throw. Path-style `/loom/mediafs/<rootIdx>/<rel>` route added
  so FBX relative textures resolve (query-style ?p= URLs can't).
- **Per-instance frame-time HUD** (pulled forward): Instance.frameMs (EMA of
  CPU submit cost) in get_session + Console tiles; screenshot metadata gains
  fps. The perf early-warning meter before M8 particle pools.
- Harness: stdlib smoke mounts geo modules through render3d + orbitCam; a
  committed 1.5 KB cube.glb (scripts/make-test-glb.mjs) keeps model checks
  machine-independent; validate-m7's FBX checks run only where the local
  hippo exists. The roadmap's `chain:<scene>@<node>` mount idea is covered by
  validate-layers' per-node chain checks — not built separately.
- **M8 validation strategy (decided up front, per the roadmap risk)**: the
  particle pool ships with a CPU-sim + instanced-rendering base path that
  runs (and validates) on the WebGL2 fallback; TSL-compute is the WebGPU
  upgrade path, verified manually in desktop Chrome. Headless SwiftShader
  WebGPU stays off the table (\_browser.mjs hides navigator.gpu for known
  blank-render reasons).
- **SHIPPED:** 6 geo modules + render3d, mediafs route, frameMs/fps HUD,
  geo-rave + hippo3d scenes (eyes-on stills verified), `validate:m7` 11/11
  incl. FBX hippo render, contract tests grown a geo branch.

## M8 — Particles (2026-06-11)

- **CPU sim over a GPU-instanced pool** (the validation strategy decided at M7):
  struct-of-arrays state, swap-with-last culling, spawn-debt accumulator,
  InstancedMesh of unit octahedra with emissive standard material — runs and
  VALIDATES on the WebGL2 fallback everywhere. TSL-compute is the WebGPU
  upgrade path (post-v1), behind the same module surface.
- **Surface sampling via MeshSurfaceSampler**, lazily acquired so async models
  (the hippo FBX) emit the moment their geometry arrives; sampling happens in
  the surface's WORLD space, so spinning/scaling the host mesh steers the
  emission live. Velocity launches along the world normal.
- **Determinism, hard-won twice**: (1) `instanceMatrix` needs
  `DynamicDrawUsage` — without it the WebGL backend re-uploaded the buffer
  only inside the rAF loop, freezing offline fixture passes (giant
  identity-matrix octahedron as the tell); (2) `MeshSurfaceSampler` defaults
  to `Math.random` — `setRandomGenerator(seededPrng)` (runtime API,
  @types/three omits it) makes replays byte-identical (cross-call diff
  mean=0, max=0). Also: offline fixture stepping now BINDS the destination
  RT before each renderFrame — destination-sized passes (render3d/transform/
  rigs) were sizing off the live loop's leftover target.
- render3d dropped MSAA (resolve also misbehaved outside rAF; full-res live
  render keeps edges fine).
- `hippo-swarm` scene IS the flagship prompt on this rig's own model:
  particles off the hippo's surface, hats driving turbulence
  (`turbulence: hats × chaos`), kick punching the key light; the validator
  commits the swarm through a feedback+paletteMap chain via the REAL
  set_chain. Eyes-on still verified.
- **SHIPPED:** particleEmitter module + case + stdlib smoke, hippo-swarm
  scene, `validate:m8` 9/9 (emission, motion, no-rebuild rides, turbulence
  whip, chain commit, byte-identical fixture replay, frame-time HUD).

## Stdlib burndown complete — 33 TD-inspired modules + 8 showcase scenes (2026-06-12)

- **The whole docs/history/stdlib-burndown.md list shipped in one pass** (M11's §6
  coverage worklist): 6 controls (envelope/remap/spring/sampleHold/gate/
  counter), 8 sources (solid/gradient/shape/checker/voronoi/plasma/text/
  webcam), 15 effects (blur/threshold/bloom/mixer/displace/hsv/mirror/tile/
  echo/key/posterize/invert/rgbSplit/vignette/crt), 4 geo (plane/tube/
  pointCloud/displaceGeo) — 63 modules total in the catalog, every effect
  chainParams-eligible, every module cases.ts-swept (381 content tests) and
  smoke-rendered (validate:stdlib 64/64, now with Chromium's fake camera for
  the webcam smoke).
- **`mix` landed as `mixer`** — TSL's `mix` import would shadow it everywhere.
  Like `over`, `mixer`/`displace`-with-map are scene-composition effects (two
  TexNode inputs; chains carry one), but `displace` doubles as a chain step
  with a built-in fractal-noise displacer.
- All time-driven modules integrate on the frame clock (no TSL `time`, the
  scan enforces it); stateful CHOPs (envelope/spring/sampleHold/gate/counter)
  document the pull-every-frame contract; geo vertex writers (displaceGeo/
  pointCloud) carry the M8 DynamicDrawUsage lesson.
- **Echo's ring buffer stores frames at 640×360** (24 max) — ghosting doesn't
  need 1080p and VRAM dies fast at full res.
- 8 showcase scenes (neon-bloom, deck-mixer on two live Beeple decks,
  warp-room, camera-ghost, type-strobe, plasma-wall, rutt-etra, spring-rave),
  all layer-wrapped, all rack-driven, eyes-on stills verified.

## M11 — Library & parallel build (2026-06-12)

- **Catalog columns**: the AST generator now marks ⛓chainable (declares
  `chainParams` → FX-picker/set_chain eligible) and ⚡inputs (named rack
  channels consumed, scanned from `ctx.input("…")` calls). Reality check the
  columns encode: modules take SignalLike opts BY DESIGN, so ⚡ lives on scene
  lines; two-input effects (`mixer`, `over`) are correctly not chainable.
- **library-use skill**: search-catalog-first, compose-before-writing,
  register-after-writing (metadata/tags/chainParams/cases.ts), and the
  parallel-build recipe (own tile + fixture input + independent files +
  signatures-first).
- **Parallel proof, run for real**: three subagents concurrently wrote
  static-haunt (glitchy) / biolume (organic) / prism-array (geometric) from
  the library only — zero file collisions, types-only coordination, all
  typecheck-green on first convergence; one human-pass default tune
  (static-haunt's strobe squared so decaying kicks don't sit half-inverted).
- **`validate:m11`**: catalog columns asserted; a module written MID-RUN
  hot-registers into the catalog + availableEffects with no reload (the
  "found tomorrow" loop); the 3 subagent scenes build healthy; three
  fixture-driven sandboxes create CONCURRENTLY and run healthy on a shared
  trace. The roadmap's stale CI section corrected: PR/push CI (typecheck +
  tests + build + Pages preview) has existed all along; validators stay
  local-on-real-GPU by documented decision.

## Spring cleaning (2026-06-12)

- **content/modules/\_shared.ts** is the new shared plumbing (deliberately
  outside the kind folders so discovery never sweeps it): `bufferPass()` —
  the buffer-the-input-and-resample skeleton previously copy-pasted across 9
  effects (transform/mirror/tile/rgbSplit/crt/displace/blur/bloom/pixelate,
  with hooks for idle gates, sibling targets and extra quad passes);
  `surfaceAspect()` (moved from transform) and `parseHex()`. History-keeping
  effects (feedback/echo/glitch) intentionally keep FIXED-size buffers and
  stay custom.
- **GPU-side `16/9` is gone**: gradient/checker/plasma/voronoi/shape/vignette
  now use `surfaceAspect()` — modules track whatever surface they render to.
  CPU-layout modules (fireflies/blobs/spriteSwarm/pulseRings) keep an explicit
  `aspect` opt by necessity (JS math can't read a shader node).
- **`integrateSignal(rate, {wrap})` joins the runtime** (the `integrate()`
  helper every scene kept re-writing); `wrap` fixes a real float-precision
  hazard in hour-long sets. Scenes + module phase accumulators migrated.
- **engine-app readback.ts** unifies the three readRenderTargetPixelsAsync→
  canvas→dataURL copies (engine-api, main, fixture shots); SessionStore's
  create/swap share `reapplyValues`.
- **Test gaps closed** (the review's top tier): engine-api.test.ts (agent
  live-chain arming, commit gating, NFR-5 chain revert keeps the instance,
  reserved-name renames, MIDI target resolution incl. bool/action rejects,
  snapshot shape, liveStep wrap/mash-guard) and content behavior.test.ts
  (control CHOPs do what they claim: envelope asymmetry, spring overshoot,
  gate hysteresis, counter edge+wrap, sampleHold, remap curves) +
  integrateSignal unit tests. engine-app's vitest config gained the runtime/
  protocol aliases (value imports need them; type-only imports had hidden it).
- **Docs/skills debt from the review**: architecture tool count (17),
  ci-and-preview validator list (17 suites), module-authoring gains the M7/M8
  gotchas (DynamicDrawUsage, sampler seeding, material normalization,
  bufferPass/surfaceAspect guidance), scene-composition gains the fixtures
  iteration loop, library-use gains the composite-depth rule, and a NEW
  validator-authoring skill encodes the isolation contract + flake patterns.
- **Module packs** (third-party module/scene repos) sketched in
  feature-requests/module-packs.md and added to the post-v1 horizon.
- Follow-up left open: the ~800 lines of copied validator boilerplate
  (check/waitForServer/waitFor/spawn) want a shared scripts/\_validate.mjs —
  mechanical but touches all 17 suites at once; do it as its own change.

## Expandable slider ranges (2026-06-12)

TouchDesigner-style live-editable param ranges: a module's declared
`{min,max}` is now a _default_ baseline the performer can widen/narrow at
runtime, not a hard wall.

- **`Param` owns a mutable effective range** (`param.ts`): float/int params
  init `lo`/`hi` from the declared spec and keep an immutable `declaredLo/Hi`
  baseline. Clamp, `setNormalized` (MIDI), and `cycle` all read the live
  range. `setRange`/`resetRange` re-clamp the current value; numeric clamping
  moved out of the per-spec closure into `Param.clamp` so it tracks edits.
  `toJSON` carries `defaultRange` ONLY when overridden — keeps the default
  manifest shape (and its golden test) untouched and doubles as the UI's
  "is overridden" flag.
- **Persistence mirrors values**: `Manifest.rangeOverrides()`/`applyRanges()`
  → per-scene `state/ranges/<scene>.json` and global `state/input-ranges.json`.
  Ranges are reapplied BEFORE values on every build (SessionStore.reapplyValues
  / boot load) so a bound widened to hold an out-of-range value survives HMR
  and restart. Only divergent paths are written (clean files; reset drops out).
- **`set_param_range` is Console-only** (in the RequestType enum + engine
  dispatch, NOT an MCP tool): widening the author's declared range is a human
  power-tool, same spirit as MIDI-learn living in the Console. Labelled ints
  (toggles) and bool/color are rejected — only plain sliders have a range.
- **UX** (`RangePopover.tsx`, opened from a ⟷ button and the now-clickable
  value readout): exact min/max fields, ⊟/⊞ halve/double (symmetric ranges
  expand both ways, else anchor at min), a value field that widens the range
  to swallow an out-of-bounds number, and reset-to-default. The ⟷ button and
  value tint warning when the range is overridden.
- Gates: typecheck + `pnpm test` (387) green. Browser acceptance suites
  (validate:m5/m6) not run — this environment's egress blocks Playwright's
  browser download; they exercise the rack/param widgets touched here and
  should be run where a browser is available.

## 2026-06-12 — Console UI overhaul: FX/modulator toggles, concise params, dnd-kit

- **FX step enable/fade are manifest params** (`fx.<id>.enabled` bool +
  `fx.<id>.fade` seconds, declared in `ChainHost.foldStep` next to `mix`):
  making them real params buys MIDI cycle-binding, value carry-forward across
  rebuilds/reorders, project persistence, and Console widgets for free. The
  effective wet/dry is `mix x envelope` (`chainWetSignal`) — a stateful Signal
  ramping linearly toward enabled∈{0,1} over `fade` seconds, pulled per frame
  through the existing uniform updater, so toggling never rebuilds and the
  envelope starts AT the current state (no fade-in from bypass on build).
  `mix`/`enabled`/`fade` are now reserved chain-param names (fold throws).
- **Modulator pause is slot-level, not spec-level**: `ModulatorSpec` stays a
  strict zod union; `enabled` lives on the host slot (`setEnabled`/
  `toggleEnabled`), survives reattach, resets on replace. Paused = tick skips
  the slot, the param holds and `active()` is false so `set_param` works again.
  New `set_modulation_enabled` verb (engine dispatch + MCP tool). MIDI maps it
  via the `mod:<paramPath>` binding namespace (cycle = flip per press), fanned
  out to every instance of the scene like param bindings; manifest snapshots
  embed `enabled` in the modulator config (stripped before re-sending — the
  spec parser is strict).
- **dnd-kit over react-beautiful-dnd** for FX-chain reorder, tile grid
  reorder, and drag-to-live: rbd is archived, has no React 19 support, and no
  grid sorting (@hello-pangea/dnd inherits the grid limitation). One
  DndContext in ConsoleApp (tiles + stage-zone droppable; order state lifted
  there), a nested context per FX chain (handle-only drags — cards are full
  of sliders). validate-m4 now drives a real pointer drag.
- **Param rows are one line**: description moved into the label tooltip,
  control inline (slider mid-row, bools as a ToggleButton — not a switch),
  double-click the value to type an exact number (widens the range like the
  range popover). Layer rig params fold into a nested "transform" accordion.

SHIPPED 2026-06-12: console-ui-overhaul — FX enable/fade, modulator
pause/resume (+MIDI), single-row params, inline value edit, transform
sub-group, dnd-kit DnD. Gates: typecheck, pnpm test (387+201+27+17),
validate m4/m5/m6/layers/projects/modulators green. Deviations: exact
MCP-tool-list pins in m4/m5/modulators updated for set_modulation_enabled.

## 2026-06-13 — Contextual PR preview screenshots

- **The preview comment now shoots what the diff touches**, not always the boot
  scene. `scripts/affected-shots.mjs` diffs HEAD against the PR base and maps
  changed files → shoot targets: a changed scene file → that scene; a changed
  `content/modules/**` file → every scene that transitively imports it (a
  forward import graph built from `content/` sources, same TS-parsing spirit as
  build-catalog.mjs); a `packages/engine-app/src/ui/**` change → the Console.
- **Why an import graph, not grep**: catches transitive module deps and avoids
  name-collision false positives. The decision logic is pure + unit-tested
  (`affected-shots.test.mjs`, run via a new `vitest.scripts.config.ts` /
  `pnpm test:scripts`, chained into `pnpm test`); only the CLI touches git/fs.
- **Console shots are self-contained**: `shoot.mjs --console` loads
  `/console.html`, which self-boots an embedded engine (hidden iframe) when no
  Output window says hello — so no sidecar/Output process is needed for the shot.
- **Guards**: scene output capped at 6 (directly-changed first) so a popular
  shared module can't fan out to dozens of slow software-GL renders; global
  content (inputs.ts, the live pointer, content/test) and non-content changes
  fall back to the boot scene; resolver exits 0 even if git diff fails (never
  blocks the preview). Preview job checkout switched to fetch-depth: 0 so the
  base ref is present to diff against.

SHIPPED 2026-06-13: contextual-preview-shots — affected-shots resolver,
shoot.mjs --console mode, workflow + comment wiring. Gates: pnpm test
(632 + 11 new script tests) green; shoot --console and scene+console runs
verified locally (console.png renders, live.scene.ts restored).
MCP-tool-list pins in m4/m5/modulators updated for set_modulation_enabled.

## soft-serve scene — color-chooser param + reversed kaleidoZoom (2026-06-13)

- **First scene-level `color` param** (`cream.color`, soft-serve.scene):
  declared via `ctx.manifest.color(...)` — BuildCtx has no `color` shorthand
  and adding one is runtime territory (human-reviewed), so the scene reaches
  through the public `manifest`. Bridged to the GPU as three per-channel
  Signals reading `param.value` behind a cached `parseHex`, so a color
  `set_param` retints live with no rebuild; the catalog's AST param extractor
  only sweeps `ctx.float/int/bool`, so `cream.color` is absent from the scene's
  catalog line (runtime manifest is correct).
- New premultiplied-alpha overlay sources: `softServe` (coil-phase cone +
  dispenser ribbon) and `sprinkles` (edge-launched tumbling rods; `count`
  rides a kick envelope + beat LFO for bursts/cadence — speed stays
  phase-stable so bursts never teleport sprinkles).
- Gates: typecheck + `pnpm test` (633) green. validate:stdlib not run here —
  this environment's egress blocks Playwright's browser download; run it
  (plus an eyes-on screenshot pass) where a browser is available.

## soft-serve rev2 — literal cone, sticky sprinkles, no kaleido (2026-06-13)

- Human feedback on the preview screenshot: the swirl read upside-down, had
  no cone, was too thin, the cream should be vanilla (pale yellow + thicker),
  and the kaleidoZoom fold "didn't work" (it shredded the cone silhouette).
  Reworked toward a literal, readable ice-cream cone "constantly getting more
  added":
    - `softServe` rebuilt: an upright teardrop swirl (wide base → hooked tip),
      fat coil bands (default 4) shaded with crest highlight + valley AO, coils
      perpetually climbing (the "more being added" read), pale-vanilla default.
    - New `wafffleCone` source: a downward waffle cone (diamond cross-hatch,
      golden, premult alpha) sized to meet the swirl base.
    - `sprinkles` reworked to toss-AND-stick: each rod flies in from an edge
      angle, lands on the swirl surface (placed via the SAME profile math the
      scene feeds both modules) and then rides the coil scroll — so they stick
      to the cream instead of fading in mid-air.
    - Dropped kaleidoZoom from the scene; "spirals forever / more added" now
      comes from the endless coil climb + dispenser ribbon, not a fractal fold.
- Gates: typecheck + `pnpm test` green. validate:stdlib still blocked by
  egress; the PR's Cloudflare preview screenshots the booted scene as the
  eyes-on check.

## noise module — TouchDesigner-style noiseField + noiseSignal (2026-06-13)

- **Noise basis is a compile-time menu, the rest is live** (`noiseField`): the
  noise `type` (perlin/ridged/worley/cell) selects a different per-octave TSL
  function, so switching it rebuilds — matching TouchDesigner's Noise "Type"
  menu. Everything else (scale, gain, lacunarity, exponent, amplitude, offset,
  3D flow) is a live uniform. `octaves` is a JS-loop count (compile-time, like
  the stdlib `noise`) so gain/lacunarity can stay live uniforms inside the
  summation. `mx_worley_noise_float`'s third (metric) arg is dropped —
  @types/three only types `(texcoord, jitter)`. `noiseSignal` is the CHOP-side
  companion: CPU value-noise fbm on the frame clock (deterministic for fixtures),
  for patching into any `SignalLike` param. Scenes: noise-flow (noise-as-image)
  and noise-warp (noise-as-displacement/rotation). Gates: typecheck + pnpm test
  green; GPU validators (validate:stdlib) not run — sandbox blocks the
  Playwright chromium download.

## Architecture refactor — Phase 0: Biome lint (2026-06-14)

First of a 7-phase architecture refactor (plan: lint → typed paths → state
schema → main.ts decomposition → handleRequest handlers → console logic
extraction → TSL seam). Phase 0 adds Biome 2.5 as the lint/format tool.
- **Lint-only, no repo-wide reformat** (deliberate): a formatter sweep would
  bury every later refactor diff. `pnpm lint` = `biome lint .`; `pnpm format`
  exists but is not in the gate. `biome.json` formatter is configured to match
  the existing style (2-space, double quotes, semicolons, width 120) so
  touched-file formatting is near-zero churn.
- **Rule tuning:** the error gate stays tight — only genuine correctness bugs
  block. Disabled rules that fight the codebase's deliberate idioms
  (`noNonNullAssertion`, `useImportType`, `noApproximativeNumericConstant`).
  Downgraded awkward-but-harmless ones to warn (`noImplicitAnyLet`,
  `useIterableCallbackReturn`, `noUnusedFunctionParameters`,
  `useExhaustiveDependencies`, `noArrayIndexKey`). Result: 0 errors, ~35
  advisory warnings (future cleanup).
- **Real fixes made:** a latent bug in `lfoSignal` (control.ts) — the shape
  `switch` had no fallback, so the `.map` callback returned `undefined` if
  `LfoShape` ever gained a member; added `default: return phase`. Removed dead
  imports (displace/plasma/voronoi `Signal`, plasma `cos`, inputs `BandName`)
  and two `?.[0]!` optional-chain-then-assert smells in protocol.test.
- Gates: typecheck + `pnpm test` (663) + `pnpm lint` green. validate suites not
  run — sandbox egress blocks the Playwright chromium download (as for prior
  entries); CI / Cloudflare preview is the eyes-on check.

## Architecture refactor — Phase 1: typed path module (2026-06-14)

Phase 1 of 7. Adds `packages/runtime/src/paths.ts` — the single source of truth
for the stringly-typed manifest-path schema that couples scenes, the Manifest,
MCP, MIDI, persistence, and the Console.
- **Why:** the path conventions (`input.<name>.amount`, `inputs.<ch>.<knob>`,
  `palette.<source>.<i>`, `<node>.layer.<knob>`, `fx.<id>.<sub>`,
  `<node>.fx.<id>.<sub>`) and the routing prefixes (`palette.`, `mod:`,
  `fixture:`, `fx.`) were built and parsed by ad-hoc string concatenation/
  slicing across runtime + engine-app — the `palette.`-vs-rack routing predicate
  alone was duplicated in 4 places. Now every build/parse goes through one
  module, so a convention change is one edit.
- **Behaviour-preserving:** pure refactor; no validator assertion moves. Two
  predicates kept deliberately distinct — `isFxPath` (root `fx.` only, used by
  per-scene value persistence) vs `hasFxSegment` (root OR `<node>.fx.`, used by
  project serialization) — preserving the existing asymmetry rather than
  flattening it.
- `modBindingPath` named with the `*Path` suffix (like `inputTrimPath`/
  `layerRigPath`) to avoid colliding with ModPopover's local `modBinding` var.
  Dropped unused build helpers (`fixtureRef`/`isFixtureRef`) rather than ship
  dead exports; `NS` kept module-local.
- Wired: layer/palette/buildctx/inputs/chain (runtime) + session/engine-api/
  main/projects/ModPopover/ParamPanel (engine-app). New `paths.test.ts` pins the
  schema (7 cases).
- Gates: typecheck + `pnpm test` (670) + `pnpm lint` green. validate not run
  (sandbox egress blocks Playwright chromium; CI/preview is the eyes-on check).

## Architecture refactor — Phase 2: state schema (2026-06-14)

Phase 2 of 7. Centralizes the persistence schema in `state.ts` (alongside
StateClient): `StateKey` (inputs/input-ranges/palettes/bindings/panic +
sceneValues/sceneRanges builders), `StateDir` (projects/fixtures), and the
`projectKey`/`fixtureKey`/`repoStatePath` helpers.
- **Why:** every state key was a raw string literal scattered across main.ts's
  persist object, the boot-load block, and the projects/fixtures fetch URLs — a
  typo silently loses tuned state. Now one module is the source of truth, and the
  load-bearing "ranges before values" ordering is documented on the keys.
- Behaviour-preserving: same keys, same URLs (encodeURIComponent kept inline on
  fetch URLs; repoStatePath used only for display paths in tool results).
- Gates: typecheck + `pnpm test` (670) + `pnpm lint` green. validate not run
  (sandbox egress; CI/preview is the eyes-on check).

## Architecture refactor — Phase 4: handleRequest handlers (2026-06-14)

Phase 4 of 7 (Phase 3 main.ts decomposition + Phase 6 TSL seam DEFERRED — they
touch the never-go-black render path and can't be validated in the sandbox; do
them when validators run on real hardware).

Splits engine-api's ~300-line `handleRequest` switch into a thin dispatcher
(the HUMAN_ONLY gate + source-tagging) delegating to one focused private method
per command (`setParam`, `setChain`, `commit`, …). Each handler owns its
arg-parsing, validation, and work — individually readable and testable.
- Behaviour-preserving: every case body moved verbatim; throws still propagate
  to the transport as ok:false. `liveStepCmd` named to avoid the existing
  `liveStep` method; handlers take `source` only where the trust gate needs it
  (set_chain, commit, save_project).
- Gates: typecheck + `pnpm test` (670, incl. the 18 engine-app/engine-api
  dispatch tests) + `pnpm lint` green. validate not run (sandbox egress).

## Architecture refactor — Phase 5: console logic extraction (2026-06-14)

Phase 5 of 7 (and the last of the non-render-path "safe" phases; Phase 3 main.ts
decomposition + Phase 6 TSL seam remain deferred for hardware validation).

Pulls the pure data logic out of the two heaviest Console components into
testable modules, giving engine-app's UI its first logic tests:
- `param-groups.ts` — `groupParams` (manifest → flat params + dotted groups,
  dropping fx chain knobs, keeping palette.source flat, a section per layer
  node) and `splitRig` (a group's `<node>.layer.*` rig vs the rest). ParamPanel
  now calls these and owns only rendering/persistence.
- `chain-ops.ts` — `chainSteps`/`insertStep`/`removeStep`/`reorderStep` (pure
  full-list edits FxChain wraps in one set_chain) + the moved `stepKnobs`.
- `console-logic.test.ts` — 11 cases over the extracted functions.
- Gates: typecheck + `pnpm test` (681) + `pnpm lint` green. validate not run
  (sandbox egress; CI/preview is the eyes-on check).

- **Color channels are real channel params, not bespoke color modulators**
  (R7.4): `Manifest.setColorSpace(path, "hsv"|"rgb")` materializes three 0..1
  float params `<path>.h/.s/.v` (or `.r/.g/.b`) and the color recomposes from
  them on every `value` read; "hex" removes them. Because the channels are
  ordinary floats, the entire existing stack — ModulatorHost, MIDI bindings,
  ModPopover, range edit — drives them for free; no color-aware modulator type
  was needed. Channels are seeded from the live color and write back through
  `set()` so the picker still works while decomposed. Decompositions persist
  (`colorSpaces()`/`applyColorSpaces()`) and reapply BEFORE values on every
  build so they survive HMR and modulator reattach finds the channel paths.
  New `set_color_space` verb (engine dispatch + MCP tool); collapsing a color
  clears its channels' modulators + bindings.
- **"globals" grew a ModulatorHost** for the first time, scoped to palette
  color channels only (`requireGlobalsChannel` rejects rack tunings and bare
  stops). Ticked once per frame in `frameTick` BEFORE the compositor so the
  recomposed stops are ready when instance palette resolvers read them; frozen
  under PANIC hold like instance modulators (FR-10). Channel modulator specs +
  the palette decompositions persist alongside the palette tunings
  (`palette-spaces`, `palette-mods` state keys).
- **Palette-index sliders carry `swatches`** (R7.3): an optional
  `string[][]` on the ranged param spec (one gradient per option), validated
  and surfaced in the manifest like `labels`. `colorize` exports
  `PALETTE_SWATCHES` (cosine presets sampled to hex); julia/mandelbrot/
  pho-nebula pass it, and the Console's `PaletteChoice` draws clickable
  gradient chips over the bare slider (the slider still rides fractional
  blends). The cosine PALETTES (`color.palette`) and the global palettes (R7)
  stay distinct systems — the chooser targets the former.

## Scene preview mode — full-screen audition overlay (2026-06-14)

- **Preview is a Console overlay, not a new page/route**: `PreviewMode.tsx`
  renders `position: fixed; inset: 0; zIndex: modal` over the whole Console —
  the selected instance blown up (its 640×360 thumbnail, cover-scaled exactly
  like `/staged.html`) with only the params drawer alongside. Reuses `useThumb`
  for pixels and `ParamPanel` wholesale, so widgets, FX chain, and the existing
  stage/GO-LIVE buttons all come for free. The slim overlay header repeats GO
  LIVE (verbatim `stage`→`commit`, the same human-sourced ungated path as the
  ParamPanel button) so sending to live stays one tap even with the drawer
  collapsed.
- **Single `#panel` invariant**: while previewing, ConsoleApp stops mounting
  the main-grid `ParamPanel` (`!previewing && <ParamPanel/>`) so the overlay's
  drawer is the only `#panel` — two same-id drawers would break the DOM
  contract validators read. The tile grid stays mounted (hidden behind the
  overlay) so thumbnail subscriptions keep flowing.
- **Toggle = Header button (`#previewbtn`) + "p" hotkey; Esc exits**: the
  hotkey handler folds into ConsoleApp's existing "i" (rack) keydown listener,
  sharing its "ignore while typing in a field" guard. DOM contract:
  `#preview-mode`, `#preview-image`, `#preview-name`, `#preview-stage`,
  `#preview-golive`, `#preview-exit`.
- Gates: typecheck + pnpm test (216+27+19 +434 content) green. Verified in
  headless Chromium: overlay opens via button + "p"/Esc, names the selected
  instance, mounts exactly one drawer, follows tile selection, GO-LIVE
  enabled/disabled+label logic. Live pixel-stream and the GO-LIVE crossfade
  landing reuse m4-validated infra (thumbnail readback + console→engine
  `stage`/`commit`) that this session's headless harness couldn't exercise
  (offscreen readback + occluded-tab BroadcastChannel both dead — the standard
  boot tile fails identically).

## Preview mode — full-resolution adaptive stream (2026-06-14)

- **Non-live instances render at 640×360, so "exact preview" needs a real
  full-res render, not a sharper readback.** While the preview overlay is open,
  the engine renders the *selected* instance at the chosen resolution and
  streams it back (`set_preview` human-only verb + a separate `kind:"preview"`
  broadcast, like thumbnails). Mechanism: resize that sandbox entry's
  `RenderTarget` so the compositor renders it at preview res **once per frame**
  (no second render → no destination-sized-buffer thrash); the tile thumbnail
  just downscales from the now-larger target. `readTarget` reads the target's
  ACTUAL size (was hardcoded `PREVIEW_W/H`) so thumbnails/screenshots still
  work when it's enlarged. The **live** instance renders to the canvas, not a
  target, so it's mirrored from the canvas at preview res (`previewMirror`,
  same same-task-read trick as `liveMirror`) and its target is left untouched.
- **fps-driven auto-reduction lives in the engine, ceiling in the UI.** The
  Console dropdown sets a height ceiling (1080/720/540/360, default Full,
  persisted); `tickPreview` (render loop) runs a hysteresis ladder — sag below
  50 fps for ~0.33 s drops a level, headroom above 57 fps for ~4 s climbs one
  back, never above the ceiling. The preview frame carries `actualHeight/
  ceilingHeight/reduced` so the overlay shows the live res + "· auto" when
  throttled. The same loop that bounds GPU cost also protects against the
  full-res readback cost (heavy preview → fps dips → it downscales itself).
- **Stream is overlay-gated and self-cleaning**: it only runs while a Console
  is present AND a preview is requested; on stop/instance-switch/destroy the
  enlarged target is restored to 640×360 (`restorePreviewTarget`). `set_preview`
  is human-only and NOT an MCP tool — agents have no path to it.
- Gates: typecheck + pnpm test green (4 new engine-api tests cover the resize,
  the live-instance no-resize, the human-only gate, and the up/down ladder).
  Browser-verified the dropdown/persistence/readout DOM; the hi-res pixel
  stream itself couldn't run in this headless session (dead offscreen readback,
  same limit that blanks the tiles) — the render-path logic is unit-tested
  instead.

## 2026-06-14 — signal robustness (cost attribution + loop guard)

Two engine-level defenses for slow / non-halting CPU signals (the synchronous
pull runs on the render thread, so a heavy or runaway `Signal.fn` degrades or
wedges the whole loop; NFR-2 only contains *throws*, not slowness).

- **Per-signal cost attribution (always on).** `Signal` carries an optional
  `label`; `Param.signal()` stamps the param path, `ctx.input()` stamps
  `input.<name>`, `ctx.color`/palette label their own updaters. `ctx.uniformOf`
  inherits the signal's label (or takes an explicit one), so the GPU-bridge
  updater knows which signal it pulls. `Updater` is `((f)=>void) & {label?}` —
  plain `ctx.updaters.push((f)=>…)` callers are unchanged (assignable). `Instance`
  times each updater (EMA) when `Instance.profilingEnabled` (default on; `?profile=0`
  opts out — overhead is microseconds and it only measures, so fixtures stay
  byte-identical) and exposes `slowSignals(n)`, surfaced in `get_session`'s
  `InstanceInfo.slowSignals` and `window.__loom`. Turns "the scene is choppy"
  into "param X is 14 ms".
- **Loop-guard transform (`packages/runtime/src/loopguard.ts`, Vite `loom:loop-guard`,
  `enforce:"pre"`, content/ only).** A TS-AST pass injects a per-loop-entry
  iteration budget (`DEFAULT_LOOP_BUDGET` 5e6); a runaway loop *throws* (prefix
  `[loom] loop guard: `) which NFR-2 then contains — converting "never halts"
  into "never go black". **Count-based, not time-based, on purpose:** same
  throw/no-throw on every machine and replay, so deterministic fixture playback
  is preserved (a wall-clock deadline would not). Each loop gets its own counter
  reset on entry (big-but-finite loops and per-frame re-entry are fine; only
  unbounded iteration trips). Labels kept on the loop so `break/continue <label>`
  still resolve. The transform is **not** exported from `@loom/runtime`'s index
  (it imports `typescript` — node-only; must never reach the browser bundle).
  Plugin is defensive (any failure → untransformed passthrough). Limitation:
  TS-printer output drops sourcemaps for guarded files (acceptable v1); loops
  inside the content build only — runtime/engine code is never rewritten.

## batch + set_params MCP tools (2026-06-14)

- **Latency win is collapsing model round-trips, not WS hops.** Each MCP tool
  call is a full LLM turn; the localhost sidecar↔engine WS round-trip is sub-ms.
  So `batch`/`set_params` pay off by letting the agent express many edits in ONE
  tool call (fewer turns, denser tokens), not by speeding the wire.
- **Both fan out engine-side, reusing `handleRequest` by recursion.** `batch`
  re-enters the same dispatch per sub-call, so every per-type Zod parse AND every
  gate (HUMAN_ONLY verbs, live-chain/commit arming) is enforced exactly as a
  direct call would be — no second copy of the gate logic. `batch` rejects
  nesting (one level deep, bounds the work per request).
- **Serial-only for v1.** `mode` is accepted for forward-compat but the only ops
  that would benefit from parallelism (screenshot/create_instance/previews) are
  renderer-bound and unsafe to run concurrently against the shared WebGPU
  renderer; pure-CPU ops (set_param) gain nothing. Parallel is a deliberate
  non-goal until an async-safe subset is carved out.
- **`set_params` applies all paths in one handler call → same frame, one persist
  flush.** Partial success (bad path → `errors[]`, good ones still land) so a
  single typo doesn't sink a bulk tweak. Same modulation guard and globals/
  palette routing as `set_param`.
- **MCP boundary stays JSON, not a YAML string.** A YAML blob would have to be a
  JSON-escaped string inside the tool args (more tokens, not fewer); the savings
  come from one call replacing N and from `set_params`' flat path→value map.
- **Sidecar unwraps screenshots taken inside a batch** into MCP image content
  (base64 stripped from the text echo), mirroring the single-screenshot path.
  Batch WS timeout = Σ per-call budgets + base, reusing the single-dispatch
  budgets. Also a `ToolMetrics` counter on the MCP dispatch tallies per-tool
  calls + `missedBatchable` (consecutive same-instance set_param that could have
  folded), digested to stderr — the signal for whether agents adopt the verbs.
  Gates: typecheck + `pnpm test` green; validate:m2's tool-list check passes,
  browser e2e blocked by the sandbox Playwright download.

## Architecture refactor — merge with main; Phase 4 superseded (2026-06-14)

Merging PR #16 (the refactor) with `main` (which had advanced by the
color-channel/`set_color_space`, per-signal-profiling, and `set_params`/`batch`/
`set_preview` work) needed two passes — `main` advanced again mid-resolution.
All of `main`'s new features were preserved; the refactor's Phases 0/1/2/5 stayed
intact (new state keys `palette-spaces`/`palette-mods`/`color-spaces/<scene>`
folded into the Phase 2 `StateKey` schema; the `channelOf` skip folded into
Phase 5's `groupParams`).
- **Phase 4 (handleRequest → per-command methods) was superseded.** `main`
  actively develops `engine-api.ts` as a `switch` and kept adding cases there, so
  the method-extraction re-conflicted on every `main` change. Resolution: take
  `main`'s switch form and re-apply only Phase 1's path helpers
  (`isPalettePath`/`isModBinding`/`modTarget`/`fixtureName`). The switch is the
  form being maintained; re-proposing the split is **not** recommended (noted in
  `feature-requests/architecture-refactor-render-path.md`).
- Remaining deferred render-path work (Phase 3 `main.ts` decomposition + the
  `window.__loom` throttle, Phase 6 TSL seam) is captured in that same ticket.
- Cleared shipped feature-requests: `param-modulators.md`, `panic-scene.md`.
- Gates after merge: typecheck + `pnpm test` (755) + `pnpm lint` green.

## Architecture refactor — Phase 6: TSL/WebGPU adapter seam (2026-06-14)

The last two deferred phases (from `feature-requests/architecture-refactor-
render-path.md`) shipped — they touch the never-go-black render path, so on this
sandbox they're gated on typecheck + `pnpm test` + lint, with a real-GPU
`pnpm validate` left as the human eyes-on check (egress blocks Playwright
chromium, as for every prior phase).

Phase 6 routes every kernel-side `three/tsl` + `three/webgpu` import through one
`packages/runtime/src/tsl.ts` module, so the coupling to the **exact-pinned**
`three` is visible and swappable in a single file (a major bump lands here first
instead of across texnode/instance/buildctx/chain/layer/palette/geo).
- **Not an abstraction layer** (deliberate, per the ticket): symbols re-exported
  verbatim — same names, same types — zero-cost and behaviour-identical. The
  value is the single chokepoint, not insulation; the payoff only fully lands on
  an actual upgrade, and over-abstracting risks more than it saves.
- **Kernel-scoped**: `content/` still imports `three/tsl` directly by contract
  (`TexNode.color` is a TSL `vec4` node), so scenes/modules aren't routed through
  the seam — the exact pin is what this protects in `packages/`.

## Architecture refactor — Phase 3: main.ts decomposition (2026-06-14)

The riskiest phase: `packages/engine-app/src/main.ts` (~1100 lines, ~57
top-level bindings, ~7 responsibilities, almost no unit tests) decomposed into a
thin composition root (~615 lines) + testable units, extracted **one per commit**
(typecheck + `pnpm test` + lint green at each step):
- **MidiRouter** — `writeParam`/`setModEnabled`/`onCc` routing (+8 tests).
- **PanicController** — warm safe-scene lifecycle, SAFE designation, build health
  (`tryBuild`/`setInstance`/`instanceId`/`info`) (+8 tests).
- **ProjectsController** — set-list fetch/persist glue + deferred-cull over the
  tested ProjectStore (+3 tests).
- **FixtureService** — recording (`record` + the per-frame `recordFrame` hook) +
  the ~110-line deterministic offline `shots` pass (+7 tests; the GPU offline
  render stays the `validate:fixtures` check).
- **DebugSurface** — the `window.__loom` assembler. **Behaviour change** (per the
  ticket): the allocation-heavy `instances` array (`[...entries].map()` with
  nested `.list().map()`) rebuilds on frame 0 then only every 6th frame (~100 ms)
  instead of every frame; all scalar fields stay per-frame fresh. Safe because
  the Console reads only `__loom.resumeAudio` and validators poll
  `__loom.instances` through multi-second `waitFor` loops (+4 tests pin the
  throttle + scalar freshness).
- **RenderService** — owns `{ renderer, session, stage, compositor }` + the frame
  loop, the rAF/worker-clock lifecycle, and the loop-local state the EngineApi
  reads back (latest frame, mix, onset count, screenshot/preview queues). The
  per-frame **statement order was moved verbatim** and the never-go-black ordering
  is documented on the class + pinned by a test (cull → render → mirror →
  screenshot → preview; modulators frozen + screenshots rejected under hold while
  the compositor still ticks) (+5 tests). main.ts pins `const api: EngineApi` to
  break the renderService ↔ api ↔ debug closure-inference cycle.
- **Explicit boot sequence** — the inline tuned-state load became a named
  `loadPersistedState()` (verbatim, preserving the ranges-before-values ordering)
  and the boot is marked in 5 ordered phases (renderer/audio → load state → debug
  surface + build instances → render loop/api/transports → start loop).
- Cleared shipped feature-request: `architecture-refactor-render-path.md`.
- Gates: typecheck + `pnpm test` (771) + `pnpm lint` green; `pnpm validate` not
  run (sandbox egress) — real-GPU validate is the remaining eyes-on check.

## Hide the auto per-instance input trim from the default params box (2026-06-13)

- **What the param is.** When a scene calls `ctx.input("bass")`, `BuildCtx.input`
  auto-declares a per-instance float `input.<name>.amount` (default 1, range 0..2)
  on that instance's manifest and returns `channel × trim`. It's a *per-instance*
  scale on the named rack channel — distinct from the *global* `inputs.<name>.gain`
  (which the rack already exposes on the "globals" pseudo-instance and which scales
  the channel for every consumer + its meter/detection). In the Console it surfaced
  as an `input` accordion with one slider per consumed channel — a knob the scene
  author never wrote, appearing on every audio-reactive scene. The owner found this
  distracting and asked whether it should "just be managed by the audio rack."
- **Options weighed.** (a) Remove the auto-trim entirely and rely on global gain —
  rejected as too destructive for a conservative pass: it silently changes the value
  every scene reads (currently `channel × trim`), drops a real capability (per-
  instance scaling, which global gain can't express), and would orphan any persisted/
  MIDI-bound/modulated `input.*.amount` in `content/state/`. (b) Keep the engine
  behavior but flag the param so the default params box omits it — chosen. (c) special-
  case `input.*` paths in the Console — rejected in favor of a general flag.
- **Decision + why.** Added a generic, reusable `hidden` param-meta flag (param.ts
  `RangedSpec`, serialized via the existing `specMeta`/`toJSON` spread) and set it on
  the auto-trim in `BuildCtx.input`. The Console's `groupParams` drops hidden params
  by default and reports `hiddenCount`; `ParamPanel` shows a persisted "▸ advanced (n)"
  toggle that reveals them. This removes the clutter (the actual complaint) while the
  value path is **byte-for-byte unchanged** — at the default trim=1 nothing moves on
  screen, persisted tunings still apply, and the knob stays fully `set_param`-able,
  MIDI-bindable and modulatable. Fully reversible, non-breaking.
- **Touched.** runtime: `param.ts` (flag + schema), `buildctx.ts` (set flag + doc).
  sidecar: `protocol.ts` (`hidden` on `ParamDescriptor`; `looseObject` already passed
  it). engine-app: `engine-link.ts` (`ParamDesc.hidden`), `param-groups.ts` (filter +
  count), `ParamPanel.tsx` (advanced toggle). Docs: `.claude/CLAUDE.md` rule 7. Tests:
  `param.test.ts`, `inputs.test.ts`, `console-logic.test.ts`.
- **Generality.** `hidden` is now available to any future auto-machinery param, not
  just the input trim. It is a UI-default-visibility hint only — it changes nothing
  about clamping, persistence, MIDI, or modulation.
- Gates: typecheck + `pnpm lint` (no new errors; pre-existing advisory warnings only)
  + `pnpm test` green (runtime 239 · sidecar 35 · engine-app 39 · content 434 ·
  scripts 11). validate suites not run (sandbox egress blocks Playwright chromium;
  CI/preview is the eyes-on check, per prior entries).

## FPS counters (Console + Output + per-tile) — 2026-06-13

Three visible FPS readouts, reusing the engine's existing fps/frameMs rather than
adding engine plumbing:
- **Console UI paint rate (new):** `FrameRateCounter` (pure, rolling-window) +
  `useRenderFps()` rAF hook in `packages/engine-app/src/ui/fps-meter.ts`. The
  Console is a React app whose paint loop is independent of the engine render
  loop, so its jank was previously unmeasured. Shown as `#uifps` in the Header
  next to the engine readout.
- **Output window fps:** already in `SessionSnapshot.fps` (from the engine's
  `FpsMeter`, gated visible by `?hud=1` in the Output). Surfaced in the Console
  Header as `#fps`, relabeled "out" to distinguish it from the new "ui" meter.
- **Per-tile fps:** `tileFps(frameMs, engineFps, frozen)` — every instance renders
  once per engine frame, so a tile's throughput is the engine fps capped by its
  own CPU budget (`1000/frameMs`); a frozen (errored) instance reads 0. Shown on
  each grid Tile (`.tilefps`) and in PreviewMode's header (`#preview-fps`)
  alongside the existing `frameMs`. No new engine/protocol fields.

**Perf findings (investigated; NOT fixed here to avoid destabilizing — sibling
PRs concurrently edit Header + FxChain):**
- The Console re-renders its whole tree on every engine **state** broadcast
  (`STATE_MS = 100`, ~10 Hz): `useEngineState()` returns a fresh snapshot object
  each tick (`engine-link.ts` `onMessage`/state), so `ConsoleApp` and all
  descendants (Header, StageStrip, TileGrid, every Tile, ParamPanel) re-render
  10×/s regardless of what changed. This is the dominant Console CPU cost. Safe
  future fix: memoize tiles (`React.memo` on `Tile` keyed by the fields it reads)
  and/or split the snapshot into narrower external-store selectors so a tile only
  re-renders when its own instance changes — deferred because it touches the
  shared render path the sibling PRs are also editing.
- Thumbnails are a separate ~6.6 Hz store (`THUMBS_MS = 150`) already isolated via
  `useThumb`; good as-is.
- Dropdown/popover open-delay is consistent with MUI Menu/Popover mounting heavy
  children *while* the 10 Hz re-render storm competes for the main thread —
  i.e. a symptom of the re-render cost above, not an independent bug. The
  `STATUS_BREAKPOINT` crash could not be reproduced headlessly (no WebGPU adapter
  in headless Chromium); reasoned from code — most likely GPU/driver-side under
  many simultaneous live preview canvases, outside this PR's scope.
- Gates: `pnpm typecheck`, `pnpm lint` (no new errors — 37 pre-existing warnings
  unchanged), `pnpm test` (engine-app 46, +9 new fps-meter tests) all green.

## 2026-06-13 — Console preview fidelity + header declutter

- **Console preview now renders at the LIVE resolution, not a fluctuating one.**
  Root cause of the "preview doesn't match live / params break" bug: the preview
  resized the previewed sandbox instance's OWN render target through an
  fps-adaptive ladder (1080→720→540→360). Destination-sized stateful passes
  (`layerRig`, `transform`, feedback, render3d) re-size/reset their buffers off
  the target, and `screenSize`/`surfaceAspect` are resolution-dependent — so the
  audition looked different from the fixed-1080p live canvas and params driving
  those passes thrashed. Fix: a dedicated fixed full-res `previewRT` (RENDER_W×
  RENDER_H); the compositor redirects the previewed NON-live instance there
  (`PreviewRoute`, replacing its thumbnail render — one render, never a second/
  stateful pass; live/crossfade/panic legs untouched, so "never go black" holds).
  The fps ladder now only caps the **JPEG downscale** of the readback, never the
  render — bandwidth/readback still throttle under load, pixels stay faithful.
  The live instance keeps its canvas-mirror path (now full-res, downscaled at
  JPEG time). `set_preview` no longer mutates entry targets.
- **PreviewMode header declutter:** dropped the duplicated `#preview-stage` /
  `#preview-golive` buttons — the ParamPanel rendered in the same overlay already
  carries `#panel-stage` / `#panel-golive` as the single source. No validator
  references the removed ids. Console main header / `StageStrip` (`#commit`,
  `#unstage`, `#stagestrip`, drop-to-go-live) untouched — left for the sibling
  Console PRs (FPS / FxChain) to avoid conflicts.
- Gates: `pnpm typecheck`, `pnpm lint` (no new diagnostics), `pnpm test` green
  (engine-api preview tests rewritten to assert the fixed-res route + no target
  resize). GPU acceptance validators (m3/m4 preview paths) not run here.

## 2026-06-13 — Module packs (v1)

Third-party repos of modules/scenes import into a project; the library stops
being monorepo-only. Foundational infra for the later marketplace + plugin work,
so the on-disk schema is deliberately small and stable. (Spec:
`feature-requests/module-packs.md`.)

- **`loom-pack.json` schema** (pack-side manifest): `{ name, version, loomApi,
  description }`. `loomApi` is a caret-major HINT (`"^1"`), NOT a gate.
- **`content/state/packs.json` schema** (host-side registry, committed; mirrors
  `media-roots.json` — the checkout is scratch, the JSON travels in git):
  `{ "packs": [ { name, source, pin, branch?, loomApi? } ] }`. `source` is a git
  URL or an absolute local path; `pin` is the cloned commit SHA, or `null` for a
  linked local path; `branch` (git packs only) is the tracked ref so `pack:update`
  fetches/resets it explicitly (shallow-clone `origin/HEAD` is unreliable). The
  `packs/` checkout dir is **gitignored**.
- **Canonical pack name = the manifest's `name`** (the namespace authors publish
  under, the marketplace keys on). `pack:add` resolves it as
  `--name > loom-pack.json name > source basename` — for a git URL it clones to a
  temp dir, reads the manifest, then moves into `packs/<name>`, so the namespace
  matches what the author declared, not the folder/URL they cloned from.
- **Namespacing + precedence (LOAD-BEARING — the marketplace depends on it):**
  local content keeps its BARE name; pack content surfaces as `<pack>/<name>` in
  CATALOG, `availableScenes`, and `availableEffects`. Precedence is
  **local-wins**: a bare lookup always resolves local; a pack's same-named item
  is reachable ONLY via its namespaced id. Pack ids are always prefixed and local
  ids never are, so the merged maps can't actually collide — `mergeNamespaced`
  (`engine-app/src/packs.ts`) and `namespacedId` (`scripts/lib/packs.mjs`) just
  make the rule explicit and order-independent. Two helpers, one rule, kept in
  sync between the browser (barrels) and Node (catalog) sides.
- **Discovery is static globs, not dynamic imports:** the barrels
  (`scenes.ts`/`effects.ts`), the test harness, and the catalog generator all add
  `packs/*/…` globs alongside the `content/…` ones. A static pattern is the Vite
  requirement and matches any installed pack automatically; the dir is absent
  until `pnpm pack:add`, so a pack-free repo is byte-for-byte unchanged
  (CATALOG.md included — the "Installed packs" section only emits when ≥1 pack is
  present).
- **`preserveSymlinks: true`** in both Vite/vitest resolve configs: a locally
  *linked* pack (`pack:add <path>` → junction under `packs/`) points out-of-tree;
  without this Vite resolves a pack file to its real path and can't find the
  host's `three`/`three/tsl` in node_modules. Keeping the symlinked path lets bare
  specifiers walk up to the repo's node_modules like local content. Cloned
  (in-tree) packs are unaffected.
- **typecheck is the real compatibility gate, `loomApi` is the fast hint** (per
  the spec's open question — both, not either). `packs/` is added to the root
  `tsconfig.json` include so pack content is typechecked exactly like `content/`.
  A pack's `test/cases.ts` (keyed by bare module name) merges into the
  completeness sweep — a pack module without a case fails tier-1 like a local one.
- **Trust: document, don't sandbox (v1).** A pack is arbitrary TypeScript run in
  the engine — the SAME trust level as editing `content/` yourself. We do not
  sandbox; `pack:add` prints the trust note and the loomApi hint. Sandboxing is a
  post-v1 question if/when packs come from untrusted marketplace authors.
- **`pack:remove` not shipped (v1):** uninstall is `rm -rf packs/<name>` + drop
  the registry entry. Add it if reviewers want symmetry.
- Gates: `pnpm typecheck` green, `pnpm test` green (+5 engine-app namespacing/
  precedence units, +4 scripts pack-discovery units), `pnpm test:content` green;
  with a linked sample pack the sweep grew to 441 (glow swept tiers 1–2) and
  CATALOG showed `samplePack/aurora|pulse|glow` namespaced while local bare
  `pulse` still won. `pnpm validate:m11` 11/11 (WebGL2 fallback; headless has no
  WebGPU). Full `pnpm validate` not run here (GPU suites).

## 2026-06-13 — PANIC + safe-scene redesign (no default hatch; opt-in scene-panic; split button)

Implements `feature-requests/panic-safe-scene-redesign.md`. Removes the
boot-default warm "panic" instance and the boring `safe.scene`; PANIC now boots
armed **hold** and **scene-panic is opt-in** — available only once the human
designates an existing instance as the SAFE target. The Console's `HOLD | SAFE
SCENE` button-group + loose `<select>` collapse into a single **PANIC split
button** (`#panic` + a `▾` `#panicmenu`). The engine's panic *machinery* is
unchanged (output-override scene-panic, hold-fallback, hold→scene escalation,
destroy/rename protection, human-only trust tier).

- **No engine logic change for "default hold" (resolved-decision #1).** The
  engine already booted hold and already degraded a target-less scene-arm to
  hold; the feature is achieved by *removing* the boot build, not adding logic.
  `main.ts` drops the unconditional `panicController.tryBuild(panicScene)`, the
  persisted-pick re-point, the `panic.scene` import, and `initialSceneName`.
- **PanicController is now designation-only.** `PANIC_ID`/`tryBuild`/the warm
  hatch lifecycle are gone; it owns only the runtime ⛑ designation
  (`setInstance`) over existing instances and a health surface derived from the
  designated instance's live `instance.error`. `instanceId()` returns null until
  designated (or when the designated target has frozen), so the engine falls
  back to hold (FR-7) exactly as before.
- **Clean "none" status (Q + Phase 2).** `PanicSceneInfo.status` gains `"none"`
  (no target designated) distinct from `"error"` (designated but broken). The
  Console reads `"none"` as "pick a SAFE target" and `"error"` as the ⚠; an
  agent reads either as "scene-panic can't fire → PANIC holds." Snapshot +
  `window.__loom` carry it unchanged in shape otherwise.
- **Designation is NOT persisted (NFR-2 — changes the 2026-06-12 decision).** A
  runtime designation over an ephemeral instance id can't auto-rebuild without
  the pointer-scene concept, so a fresh session boots to hold and the human
  re-designates per session. `StateKey.panic` and its load/save are removed.
- **Deleted `content/scenes/safe.scene.ts` AND `panic.scene.ts` (Q1).** The
  `live.scene.ts`-twin pointer is vestigial with runtime-only designation; both
  files and the pointer concept are dropped. The scene-barrel HMR block no
  longer special-cases a pinned hatch (a designated target is an ordinary
  instance: it rebuilds like any other and, if its scene file vanishes, is
  destroyed → Stage degrades scene-panic to hold).
- **Split-button DOM ids (NFR-1).** Primary `#panic` (PANIC/RESUME), the menu
  toggle `#panicmenu` (`▾`), radio items `#panic-arm-hold` / `#panic-arm-scene`
  (the scene arm is **disabled** until a target exists, Q4), and per-target
  options `[data-panictarget="<id>"]`. The validator was rewritten to drive
  these and to assert the new boot state (no pinned instance, `panicScene`
  reports `"none"`, no ⛑ tile until designation; broken-target → hold reframed as
  a designated instance that throws at render → freezes → falls back to hold).
- **Scope.** Header.tsx changes are confined to the PANIC cluster (a later
  console-ui-refactor restyles the rest). `Tile.tsx`'s ⛑ SAFE badge is unchanged
  (it simply shows less often — only after opt-in).
- Gates: `pnpm typecheck` green; `pnpm test` green (360 package = 239 runtime +
  86 engine-app + 35 sidecar; 434 content; 11 script; `panic-controller.test.ts`
  rewritten for the no-build API);
  `pnpm validate:panic` **18/18 green** (ran in-env on the WebGL2 fallback).

## 2026-06-13 — App instrumentation: structured diagnostics ring + get_diagnostics (SHIPPED)

A bounded, hot-path-safe event ring (`packages/engine-app/src/diagnostics.ts`)
plus an MCP `get_diagnostics` tool give the agent the HISTORY the snapshot
surfaces lacked (what build/swap/freeze/perf event led to a number).

- **In-house ring, no library on the hot path (NFR-1/NFR-2).** ~512-entry
  preallocated array; `push` is integer-stamp + modulo-write, WRAPPED so an
  instrumentation bug can never throw into `renderFrame`/`tick`. Serialization
  (Zod, filter, slice) happens ONLY in the request handler. `?diag=0` off switch
  mirrors `?profile=0`. In-page singleton so the future Console perf view reads
  the same ring (one pipeline, two readers).
- **Runtime keeps no engine dependency.** The NFR-2 freeze emits through a static
  `Instance.diagSink` (mirrors `Instance.profilingEnabled`); `instance.frozen` vs
  `loopguard.tripped` is distinguished by the loop-guard message prefix, factored
  into a dependency-free `loopguard-prefix.ts` so `instance.ts` never pulls the
  `typescript` compiler into the browser bundle.
- **22 `[loom]` console sites re-routed** via `logDiag` (console AND ring):
  scene.swapped/rejected, instance.rebuilt/rejected/removed/frozen,
  inputs.redefined/rejected, effects.reloaded, audio.fallback, panic.engaged/
  resumed, loopguard.tripped. Sampled + threshold perf events (FR-3) in
  `perf-events.ts` off the render tick (fps.low/recovered, frame.spike, sample).
- **Wire contract (NFR-5).** `DiagEvent`/`PerfSnapshot`/`SidecarToolStat` Zod in
  protocol.ts; `kind` is an OPEN string (new kinds emit without a protocol bump).
  `perf` block folded onto `get_session` + standalone via `get_diagnostics`;
  separate `get_diagnostics` tool for the timeline. Both read-only, agent-allowed.
- **Sidecar latency (FR-6).** `ToolMetrics` grew a per-tool p50/p95/outcome
  table; `Broker.onSettle` reports every mint→settle. `get_diagnostics
  { scope:"sidecar" }` answers it locally (no engine round-trip).
- **renderer.info (FR-7)** is best-effort (defensive read; any missing counter
  drops the whole block) — not gated, cheap.
- Gates: `pnpm typecheck` green; `pnpm test` green (302 package = 239 runtime +
  120 engine-app + 43 sidecar; 434 content; 16 script); `pnpm validate:m2`
  **24/24 green** on the WebGL2 fallback (forced bad save → `scene.rejected`
  surfaced @frame 558 on "boot", live pixels unchanged, `since` paging, sidecar
  latency table, `?diag=0` vs `?diag=1` both 60 fps).

## 2026-06-14 — Console performance & stability (SHIPPED)

The cockpit was janky/occasionally "Aw, snap" under a busy session. Root cause +
fixes (all in the Console React app + OFF-LOOP producers; the in-frame `tick()`
path and never-go-black are untouched, NFR-4):

- **The re-render storm (FR-1) was the dominant cost — but memoization alone
  didn't fix it.** `EngineLink` emitted a new snapshot identity every 10 Hz state
  tick; nothing was memoized. The durable fix is narrow **selector stores** in
  `EngineLink` (per-tile display slice / full instance slice / session-meta /
  stage-pointers / rounded fps / instance-id list / scene catalog / per-id thumb /
  connected / sticky has-session), each keeping a STABLE reference while its slice
  is unchanged, + `React.memo` on Tile/TileGrid/ParamPanel. **The non-obvious
  trap:** ConsoleApp hosts the dnd-kit `DndContext`; its 10 Hz re-render churned
  the context value, re-rendering every `useSortable` tile *through context*
  (bypassing memo entirely). Fix: ConsoleApp subscribes only to rarely-changing
  narrow stores (never the full snapshot) with a useCallback'd drag handler over
  refs, and the live-session chrome (Header/StageStrip/Rack/Preview) reads state
  in isolated SIBLING subcomponents. Live telemetry (frameMs/slowSignals) is
  quantized to display precision so a sub-threshold wiggle can't churn identity.
- **Thumbnail back-pressure (FR-2) + memory (FR-4).** `thumbnails()` caps
  non-priority readbacks per pass (`THUMB_READBACK_CAP=4`) and round-robins the
  rest, always reading live+staged+panic-pinned (PANIC stays visible).
  `readback.ts` reuses two scratch canvases (was 2 createElement/pass — canvas
  churn). `scene-thumbs.ts` got LRU + entry/byte budget (was unbounded). The
  in-memory thumbsMap prunes destroyed instances; per-id thumb subscription stops
  the all-tiles decode burst.
- **Crash (FR-5): residual risk documented.** STATUS_BREAKPOINT is a GPU/driver
  renderer abort with no WebGPU adapter headless — not reproducible in CI.
  Mitigations landed: memory eviction, single-canvas readback, and a
  single-renderer guard (`console-channel.ts` logs a one-shot `engine.duplicate`
  if two non-embedded engines broadcast on one origin — the two-WebGPU-device
  scenario). A real-browser soak on the reference machine is the open follow-up.
- **PerfOverlay (FR-6).** `src/ui/console/PerfOverlay.tsx` (PERF button + `d`
  hotkey) — read-only, reads the same `PerfSnapshot` on `session.perf` the agent
  gets via `get_diagnostics.perf` (one pipeline, two readers). No new dependency.
- **Freeze-id fix (separate commit).** `instance.frozen`/`loopguard.tripped` now
  carry the INSTANCE id (was scene name) — `Instance.instanceId` stamped by the
  session on create/rebuild/rename; scene name kept in `data.scene`.
- Evidence (10-instance headless WebGL2 harness, `scripts/perf-console.mjs`, 6 s
  window): per-tile re-renders 860 → 48–360 (ConsoleApp 60 → 0); `#uifps` mean
  50 → 60 (min 40 → 59); scene-picker p95 386 ms → ~175 ms. Headless renders the
  heavy scenes cheap so the absolute fps win understates the reference machine;
  the re-render-count drop is the machine-independent proof.
- Gates: `pnpm typecheck` green; `pnpm test` green (242 runtime + 138 engine-app +
  45 sidecar + 434 content + 16 script). Validators: see the PR (run on WebGL2).

## 2026-06-14 — Simulation sources: reaction-diffusion + the `simBuffer` field family

- **New source class — cellular GPU simulations.** `reactionDiffusion`
  (Gray-Scott) shipped first; then the ping-pong/iterate/seed/reseed boilerplate
  was extracted to **`simBuffer`** (`content/modules/_shared.ts`) — two
  HalfFloat targets, N iterations/frame, seed-on-first-frame + reseed rising
  edge, frame-clocked `phase`. `reactionDiffusion` was refactored onto it
  (behaviour-preserving) and **`waveField`** (2D wave equation) + **`automata`**
  (cyclic CA) built on it. Stateful like `feedback` (NFR-5 reset on rebuild),
  frame-clocked (no TSL `time`), seeded → fixture-deterministic.
- **`pickPalette`** (`content/palettes.ts`): scenes needed *both* global
  palettes selectable at once, which the built-in `palette.source` (one active
  at a time) can't do. A swatched int param listing primary + secondary (read
  live from the registry) + scene presets, returning the `ctx.palette`-shaped
  `color(i)`/`ramp(t)` surface. Reusable; used by `coral-bloom`/`ripple-pool`/
  `cyclic-spiral`.
- Showcase scenes: `coral-bloom`, `ripple-pool`, `cyclic-spiral`. Follow-ons in
  `feature-requests/{gpu-field-simulations,particle-agent-systems,generative-growth-grammars,domain-warp-marble}.md`
  (`fluid2d` wants multi-buffer `simBuffer`).
- Gates: `pnpm typecheck` green (75 modules, 33 scenes); `pnpm test` green (449
  content). GPU `validate:stdlib` not run (headless container, no WebGPU);
  stills rendered via `scripts/shoot.mjs` on the WebGL2 fallback.

## 2026-06-14 — More generative sources: marble + strangeAttractor

- **`marble`** (source): iterated domain-warp FBM (`fbm(p+fbm(p+fbm(p)))`) →
  agate/oil veins. Kept **grayscale** (composes with colorize/palette) rather
  than self-colouring, so the scene (`marble-slab`) ramps it through
  `pickPalette` — consistent with the other new scenes' palette-as-choice.
- **`strangeAttractor`** (geo): chaotic ODEs (Lorenz/Aizawa/Thomas/Halvorsen)
  integrated CPU-side into a vertex buffer (deterministic start, no
  Math.random), then drawn via the existing `pointCloud` + `render3d` +
  `orbitCam` path. Chose this geometry-first route over a GPU particle-state
  texture: reuses proven 3D-point rendering and is verifiable headlessly.
  Trade-off — constants bake at build (changing the system rebuilds); camera/
  spin/size/glow are the live surface. Scene `attractor-cloud`.
- Headless-verification reality: pure-shader (`marble`) and geometry-reusing
  (`strangeAttractor`) techniques verify via `shoot.mjs` on WebGL2. The
  remaining list items (`flowParticles`/`flock`/`physarum` — GPU particle
  state; `fluid2d` — multi-buffer; growth/L-systems — a line renderer) need new
  GPU infra best validated on a real WebGPU device.
- Gates: `pnpm typecheck` green (77 modules, 35 scenes); `pnpm test:content`
  green (459). Stills via `shoot.mjs` (WebGL2). Feature-request docs updated.

## 2026-06-14 — marbleWarp effect + CPU agent systems (flock, flowParticles)

- **`fbm2`** value-noise FBM hoisted into `content/modules/_shared.ts`; `marble`
  refactored onto it and the new **`marbleWarp`** effect (warps an input's UVs
  by the iterated field via `bufferPass` — the effect face of `marble`, scene
  `marble-warp`) shares it. Distinct module name since the catalog requires it.
- **CPU agent systems over GPU particle-state** (the "tractable-first" choice):
  **`flock`** (boids S/A/C, oriented cones) and **`flowParticles`** (ABC
  divergence-free flow advection, instanced octahedra) simulate on the CPU each
  frame and draw through the existing `render3d` + `InstancedMesh` path —
  seeded (mulberry32) + frame-clocked + `DynamicDrawUsage`, so fixture-replay
  safe and verifiable headlessly. Chose this over GPU position-textures because
  it reuses proven rendering and renders correctly on the WebGL2 fallback.
  Scenes `flock-swarm`, `flow-field`.
- Still OPEN from the new-viz list (need GPU infra best validated on a real
  device): `physarum` (agents + diffusing trail field), `fluid2d` (multi-buffer
  simBuffer), differential-growth / L-systems (a line/ribbon renderer), and a
  true GPU `particleState` + additive accumulation for million-point silk.
- Gates: `pnpm typecheck` green (80 modules, 38 scenes); `pnpm test` +
  `pnpm test:content` green (476 content). Stills via `shoot.mjs` (WebGL2).

## 2026-06-14 — physarum: GPU slime-mold agents on a diffusing trail field (SHIPPED)

- **`physarum`** (source): the first FULLY-GPU agent system — agents in a
  ping-ponged HalfFloat position texture (rgba = posX, posY, heading), a
  full-screen update quad senses the trail at L/C/R and steers, the trail field
  is a second ping-pong (gentle 3×3 diffuse + decay), and moved agents are
  deposited additively via an instanced `Points` pass whose `positionNode` does
  `textureLoad(agentTex, vertexIndex→texel)`. No vertex-texture-fetch guesswork,
  no shared `particleState` primitive (deferred — `simBuffer`'s per-pixel step
  can't read agent positions for the deposit, so physarum owns its 4 passes
  inline — ~231 lines, over the ~150 soft budget, mostly backend-gotcha comments
  + per-opt JSDoc). Seeded in-shader (hash, no Math.random) + frame-clocked → fixture-safe.
- **Real-WebGPU verification caught two backend bugs the WebGL2 fallback hid:**
  (1) the deposit pass camera was a bare `Camera` — WebGPU's `_renderScene` calls
  `updateProjectionMatrix` which only exists on `OrthographicCamera` (froze via
  NFR-2 on WebGPU, rendered fine on WebGL2); (2) RT Y-orientation differs
  (WebGL2 bottom-up, WebGPU top-down) so agents deposited Y-mirrored from where
  they sensed and the network collapsed to horizontal bands — fixed with a
  per-frame `depFlipY` uniform keyed off `renderer.backend.isWebGLBackend`.
- **Tuning:** a full 1/9 box diffuse + high deposit over-reinforces into a few
  fat channels; center-weighted diffuse (40% toward box avg) + low deposit (0.12)
  + 768×432 grid yields the fine leaf-venation/neuron lattice. Scene `slime-veins`
  (kick flares sensor splay + flashes deposit, bass breathes speed, `pickPalette`).
- Gates: `pnpm typecheck` green (81 modules, 39 scenes); `pnpm test` +
  `pnpm test:content` green (481 content). Verified on REAL WebGPU (headed system
  Chrome, hardware adapter) — non-black, clean console, no NFR-2 freeze; stills
  also via `shoot.mjs` (WebGL2). validate:stdlib runs WebGL2-only headless.

## 2026-06-14 — fluid2d: Stam stable-fluids smoke on a multi-buffer simBuffer (SHIPPED)

- **`simBufferMulti`** added to `content/modules/_shared.ts` (the single-field
  `simBuffer` left byte-for-byte unchanged): N *named* coupled HalfFloat
  ping-pong fields (each its own grid/wrap/seed) driven by an ORDERED pass
  pipeline — each pass writes one field, may `sample` any field (integer
  neighbour taps) or `sampleUv` it at an arbitrary uv (advection backtrace), and
  may `repeat` N sub-iterations (the Jacobi loop). Passes run sequentially,
  swapping their target's pair the instant they write, so a later pass sees
  earlier results (advect → divergence → pressure → project → advect dye). Same
  statefulness as `simBuffer`/`feedback`: frame-clocked phase, seeded, NFR-5
  reset. Existing `simBuffer` consumers (reactionDiffusion/waveField/automata/
  physarum) all still pass typecheck + test:content + validate:stdlib unchanged.
- **`fluid2d`** (source): velocity+divergence+pressure+dye on `simBufferMulti`;
  two counter-rotating orbiting jets inject a vortex force + coloured puffs on
  the kick (`inject`), bass eases `dissipation` for longer smoke; `pressureIters`
  exposes the Jacobi count. Output = dye luminance (.x, ramp it) + speed (.y).
  Scene `smoke-signals` colorizes through `pickPalette`. Tuning lesson: under
  constant test-audio kicks the dye saturates into a white blob — tight splat
  (SPOT_R2 0.0016), low dye injection, fast-sweeping jets and a vortex (not
  linear) force are what break it into curling wisps; the visible warm-gray was
  bloom amplifying near-black thin dye, fixed by scaling density into the ramp.
- Verified on REAL WebGPU (headed system Chrome, NVIDIA Turing adapter):
  non-black, instanceError null, no NFR-2 freeze, ~56 fps — AND on the WebGL2
  fallback via shoot.mjs. Both backends render the smoke correctly (no Y-flip /
  projection bug — the multi-buffer trap physarum hit). Grid 256×144.
- Gates: `pnpm typecheck` green (83 modules, 41 scenes); `pnpm test` +
  `pnpm test:content` green (493 content); `pnpm validate:stdlib` 84/84 (WebGL2).

## 2026-06-14 — family 3: lineRibbon + differentialGrowth + lsystem (SHIPPED)

- **`lineRibbon`** (geo) — the shared thin-stroke renderer both growth modules
  build on. Polylines → glowing instanced segment-quad strokes (one thin oriented
  box per edge, joined end-to-end), rebuilt every frame from a `paths()` provider
  so a *growing* vertex set re-uploads each frame (`DynamicDrawUsage` — the
  particleEmitter lesson). Returns a GeoNode; feeds `render3d`+`orbitCam`. Chose
  the GeoNode route over a 2D-stroke source to reuse the existing geo path.
- **`differentialGrowth`** (geo) — a closed polyline that repels locally
  (spatial-hash grid, O(n)), Laplacian-smooths along the chain, and inserts a
  node where an edge overstretches → coral meanders. Solver lesson: force×dt was
  a self-crossing tangle; rewrote to a Jacobi relax with per-iteration
  displacement CAPPED to ~0.45·radius + z damped near-planar + 8 iters/frame, so
  the curve stays relaxed (non-crossing) as it grows. Seeded (mulberry32),
  node-capped. Audio: bass→repulsion, kick→split rate.
- **`lsystem`** (geo) — axiom rewritten k gens (length-capped), turtle-drawn
  (F/G draw, +/- yaw, &/^ pitch, [/] branch) into disjoint 2-pt ribbon paths
  (branch jumps never connect); `reveal` draws a growing fraction → unfurl;
  `angle` re-tessellates only on change. Presets plant/koch/dragon/sierpinski/
  bush. Scenes: `coral-growth`, `grammar-garden` (bloom+vignette, palette-able).
- Verified WebGL2 only (headless + shoot.mjs) — no real-WebGPU adapter available
  this session. validate:stdlib 87/87 non-black; new modules lum≈18.
- Gates: `pnpm typecheck` (86 modules, 43 scenes), `pnpm test`,
  `pnpm test:content` (508), `pnpm validate:stdlib` (87/87) all green.

## 2026-06-14 — SHIPPED: family 4 — GPU particle "silk"
- **`particleState` + `additiveDeposit`** (`content/modules/_shared.ts`, append-only) —
  the reusable GPU particle-pool primitive that generalizes physarum's inline
  machinery: pos/vel in a ping-ponged HalfFloat √count² texture (NearestFilter),
  in-shader seeded (no Math.random), frame-clocked `phase`; `load(idx)` reads a
  particle via `textureLoad(vertexIndex)`. `additiveDeposit` splats instanced
  `Points` additively into a HalfFloat accum buffer (+ optional trail bleed) →
  soft `1-exp(-d)` tone-map. Carries the WebGL2/WebGPU RT Y-flip.
- **`silk`** source + **`silk-flow`** scene — curl-of-fbm flow OR de Jong
  attractor; bass surges force, kick breathes curl scale, palette-ramped + bloom.
- Finishing an inherited half-done draft: fixed (1) a seed-hash that exceeded
  WebGL2/ANGLE `sin` precision → sparse-grid collapse (lum 0.13), now bounded
  integer-texel ids + pre-`fract` hash; (2) too-small advection step + too-faint
  splats → dense flowing silk (lum 82). Reverted an out-of-scope `live.scene.ts`
  edit the prior agent left.
- Verified WebGL2 only (headless + shoot.mjs); real-WebGPU (float-tex additive
  blend + position `textureLoad`) needs a human eyeball — `navigator.gpu` undefined.
- Gates: `pnpm typecheck` (87 modules, 44 scenes), `pnpm test`, `pnpm test:content`
  (513), `pnpm validate:stdlib` (88/88 non-black, silk lum 82) all green.

## 2026-06-14 — multi-input / branching chain steps (BUILDABLE subset)
- **SourceRef = `{ instance } | { step } | { asset }`** (runtime `chain.ts`,
  mirrored in `sidecar/protocol.ts`). A chain step declares extra TexNode slots
  via `meta.chainInputs: [{ name, kind: "tex" }]`; `ChainStep.inputs[slot]` binds
  each to a SourceRef. Additive/optional — a classic single-input step has no
  `inputs` key and serializes byte-for-byte as before.
- **Resolution at fold time.** `{instance}` → `texNode(vec4(texture(entry.target.
  texture).rgb, 1))` via a `SourceResolver` the `SessionStore` hands to every
  ChainHost (root + per-node). `{step}` → an EARLIER step's folded TexNode
  (linear chain → small DAG). Self-tap (instance == owner) is rejected (that's
  feedback, not overlay); so is a missing instance / dangling step.
- **Ordering/cycle guard at plan time:** a `{step}` ref may only name a step
  PLANNED BEFORE it; self/forward refs throw and the whole edit is rejected.
- **NFR-5 — never go black:** an unresolvable SourceRef (missing instance, cycle,
  dangling step, or `{asset}`) makes the fold throw → `SessionStore.setChain`
  restores the previous chain and the old instance keeps rendering. Unit-covered
  in runtime/chain.test.ts and engine-app/engine-api.test.ts.
- **`over` is the reference multi-input step** (declares `overlay` + an `opacity`
  chainParam). Console `FxChain.tsx` grows an `InputSlotRow` (source picker:
  other instances / earlier steps) per declared slot.
- **DEFERRED → M10:** `{asset}` SourceRef + asset-picker UI need the M10 asset
  explorer (absent). `asset` stays in the SourceRef TYPE (forward-compat) but the
  fold/plan REJECT it ("not yet supported — needs M10"); a persisted asset source
  renders as an inert error-colored option, never silently dropped. `flyby`
  (needs asset urls, no chainParams/chainInputs) stays out of the picker.
- **Also deferred:** multi-input steps aren't yet saveable as composites
  (`serialize()` throws) or persisted into projects (`projects.ts` carries only
  id/effect/params) — both want the asset/persistence work to land first.

## 2026-06-14 — Content-sharing marketplace (Phase 1)

The DISCOVERY layer over module packs (find a pack you don't have a URL for).
Phase 1 is frictionless: a flat versioned JSON index, no backend/accounts. Phase
2 (hosted API, Console browse panel, real ratings/moderation, payments) is out
of scope. (Spec: `feature-requests/content-sharing-marketplace.md`; one-pager:
`docs/marketplace-publishing.md`.)

- **`index.json` schema FROZEN (FR-1):** `{ schemaVersion: 1, packs: [{ name,
  gitUrl, gitRef?, description, tags[], author, loomApi, rating? }] }`.
  `name`/`loomApi` mirror `loom-pack.json`; `tags` draw from the catalog
  vocabulary. Phase 2 reuses the shape with extra fields — adding optional fields
  does NOT bump `schemaVersion`, only an incompatible change does (NFR-1: the
  schema is the stable seam, the transport swappable).
- **Index location:** committed seed at `content/marketplace/index.json`;
  `LOOM_MARKETPLACE_INDEX` (a path OR an http(s) URL) overrides it so a community
  index needs no code change. Off-vocabulary tags WARN (vocabulary can grow);
  malformed entries ERROR.
- **One schema + ranker, two sources, kept in sync:** `scripts/lib/marketplace.mjs`
  (Node/CLI + schema test) and `packages/sidecar/src/marketplace.ts` (the agent
  tool). Ranking: exact name +100, name-substring/tag-eq/desc-substring per term,
  rating tie-break; `tags` is a HARD AND filter. The agent tool and the CLI
  return the SAME order by construction.
- **`search_content` MCP tool (FR-2):** read-only, agent-allowed, NO arming
  (pulls nothing), answered SIDECAR-SIDE without the engine (like
  `get_diagnostics { scope:"sidecar" }`) — so it works with no engine connected
  and `SearchContentArgs` is NOT in the engine `RequestType` enum. Result carries
  the exact `pack:add` `installHint`. Added to the canonical tool-list assertion
  in `validate-core.mjs` (the one place the tool surface is asserted).
- **`pnpm pack:search <q> [--tag t]` (FR-3)** and **`pnpm pack:fork <name>`
  (FR-6)** extend `scripts/pack.mjs`. Fork copies an installed pack into an
  editable, un-pinned `forks/<name>/` tree (committed; `.git` excluded),
  junctions `packs/<name>` to track it, and re-points the registry entry at the
  local fork with `pin: null` (reusing the existing linked-pack idiom, so
  `pack:update` treats it as always-live). Single-module override stays the
  LOCAL-WINS local-shadow rule (no new resolution code — module packs already
  ships it).
- **Install handoff (FR-4):** discovery hands off to `pnpm pack:add <gitUrl>` —
  no reimplemented loading; found packs appear namespaced in CATALOG/
  availableScenes after install (already true).
- **Git-native publish/ratings/moderation (FR-7/8/9):** publish = PR a line
  (CI-validated against the frozen schema); rating = a maintained schema field
  (star-mirror / aggregate); moderation = the index repo's merge queue.
  Documented loudly in `docs/marketplace-publishing.md`.
- **Trust UNCHANGED, louder (NFR-3):** install runs arbitrary code at
  content-edit trust; install is human-gated like commit; a rating is popularity,
  NOT a security audit; no sandbox (document, don't promise). Search is the
  `library-use` reflex aimed wider — local catalog first.
- **Offline-degrades (NFR-2):** a missing/unreachable/invalid index is a CLEAN
  error (exit 1, clear message) that never blocks already-pinned packs (they load
  offline from `packs.json`).
- Gates: `pnpm typecheck` green; `pnpm test` green (+ sidecar
  `marketplace.test.ts` ranking/schema/offline, + scripts `marketplace.test.mjs`
  schema/ranking/offline, `pack-search.test.mjs` CLI, `pack-fork.test.mjs`);
  `pnpm validate:core` 6/6 with `search_content` in the live MCP tool surface
  (WebGL2 fallback — headless has no WebGPU). `search_content` driven end-to-end
  over MCP returns ranked entries with install hints. Deferred to Phase 2: hosted
  index API, account ratings + active moderation, Console browse panel, payments.

## 2026-06-15 — Console param-panel re-render storm (FR-1 leaf fix, SHIPPED)

Reported: selecting/tweaking an instance's params dropped the Console to ~4 fps and
left the UI sluggish. The 2026-06-14 FR-1 work narrowed `ConsoleApp`/`Tile`/
`ParamPanel` off the full snapshot, but the **leaves still subscribed to the
10 Hz `useEngineState()` snapshot** — defeating the whole effort once a param panel
was open:

- **`ParamWidget` (one per param) and `ModPopover` (one per *modulatable* param,
  mounted inside every widget's popovers) both called `useEngineState()`** — the
  monolithic snapshot whose identity changes every state tick. An open panel of N
  params meant ~2N full-snapshot subscribers all re-rendering heavy MUI 10×/s, even
  at idle. `FxChain` did the same.
- **`ParamPanel` read the full instance slice (`useInstance`)**, which churns every
  tick on quantized `frameMs`/`slowSignals` telemetry — re-rendering the panel and
  cascading into every (un-memoized) child widget regardless of the leaf fix.

Fix — two more narrow selector stores in `EngineLink`, same identity-preserving
JSON-compare pattern as the rest (FR-1):

- **`controls` slice** = the rarely-changing session fields the param/FX surfaces
  read (`bindings`, `midi`, `availableEffects`, + an id→scene map for binding
  lookup). `ParamWidget`/`ModPopover`/`FxChain` read `useControls()` instead of the
  snapshot, so they wake only on a real binding/MIDI/effect change — never the frame
  tick. Scene resolution moved from `session.instances.find(...)` to `controls.scenes`.
- **`structure` slice** = one instance's `scene`/`nodes`/`chain` with telemetry
  EXCLUDED. `ParamPanel` + `FxChain` read `useStructure(id)`, so the panel re-renders
  on a chain/node edit, not the per-tick `frameMs` wiggle. `FxChain`'s other-instance
  picker reads `useInstanceIds()` (it only needs ids).

That killed the IDLE storm. The other half is **value churn**: a drag — and worse, a
running modulator whose value the engine animates every frame — rewrites that
instance's whole manifest each tick, which re-rendered `ParamPanel` and every widget
it passes `p` to. Fixed by **per-param identity preservation + `memo(ParamWidget)`**:
`EngineLink` now rebuilds each manifest reusing the prior `ParamDesc` object for every
param whose serialized value is unchanged, so only the param that actually moved gets
a new identity. `ParamWidget` is `memo`'d with a comparator that reference-compares `p`
(+ primitive props, + color-channel entries by reference), so an animating/modulated
param re-renders ONLY its own widget — not all N. `ParamPanel` still re-renders (light:
regroup + element creation; the heavy MUI widget subtrees bail). Added a `ParamWidget`
render counter (`util.countRender`) and extended `scripts/perf-console.mjs` to open a
panel, attach a sine modulator, and report `paramWidgetRenders`.

DOM contract and the `link.sendParam` write path are unchanged (`data-path`/
`data-learn`/`data-value` intact); `memo`'s comparator covers every `Props` field so it
can't go stale (identity-stable ⟺ value unchanged). Gates: `pnpm typecheck` green;
`pnpm test` green (160 engine-app incl. 3 new engine-link store tests — structure/
controls slices ignore frame churn + wake on chain/binding edits, and per-param
identity holds across a value-only tick; 543 + 41 elsewhere). Playwright Console
validators (m3/m5) + the perf harness couldn't run here — the browser CDN is blocked by
the env's network egress policy (binary not installed), not a code issue.
