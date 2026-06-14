# LOOM — Requirements v1.0

*(working name — an engine for weaving signals into light; rename freely)*

## 1. The Spirit

Loom is a live-visuals instrument where **the primary way you build is by talking to an AI**. You describe a visual, a control, or a behavior; agents write typed code into a repo; the engine renders it on screen the moment it’s saved; you steer with words, mouse, and MIDI until it feels right; you save it; the library grows; the AI gets better at being *your* collaborator because it composes from *your* accumulated vocabulary.

The core loop, which every requirement serves:

```
  PROMPT ──► agent writes code ──► HOT-RENDER (visible instantly)
     ▲                                   │
     │            TWEAK (words / mouse / MIDI knobs)
     │                                   │
  LIBRARY ◄── save scene/module ◄── COMMIT to live (crossfade)
  (agent draws from it next time)
```

TouchDesigner gave humans a spatial canvas for composing visuals. Loom gives an AI a textual one — and gives the human real-time eyes and hands on everything the AI does.

## 2. Principles

1. **Code is the substrate.** Scenes, modules, and panels are small typed TypeScript files in a git repo. No node graph, no binary project file. The repo *is* the product’s content.
1. **Never go black.** No agent action, compile error, or bad edit can interrupt the live output. Failures are silent no-ops that keep the last good frame rendering.
1. **Types are the coordination protocol.** Every composable unit has a typed signature. `tsc` passing is what lets parallel agents work without talking to each other.
1. **The human always wins.** Live output changes only on explicit commit (unless auto-commit is deliberately armed). Manual controls and PANIC override everything, always.
1. **Claude Code is the agent platform.** v1 builds no orchestration, no chat UI, no subagent machinery — the terminal already has all of it. Loom contributes a runtime, a thin MCP server, and conventions.
1. **Simple and rebuildable.** All authored state is plain text on disk. A fresh clone plus the repo reproduces everything.

## 3. Concepts (glossary)

|Concept      |What it is                                                                                                                                                                                                  |
|-------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
|**Engine**   |The running app: render loop, Stage, InputBus, HMR loader, session store, WebSocket API.                                                                                                                    |
|**Signal<T>**|Continuous time-varying value (control rate, CPU, per frame). Numbers, vectors, colors, buffers.                                                                                                            |
|**Events<T>**|Discrete occurrences: onsets, MIDI notes, beats. Ops: gate, latch, divide, quantize (frame-resolution in v1).                                                                                               |
|**Param<T>** |Declared, typed, ranged, defaulted value. The unit of tweakability.                                                                                                                                         |
|**Manifest** |The flat set of an instance’s Params. UI, MIDI, and agents all bind to it.                                                                                                                                  |
|**TexNode**  |A node in the GPU image graph (TOP-equivalent): sources and effects compose into it.                                                                                                                        |
|**Geo**      |Meshes / points / instances (3D path; arrives mid-roadmap). `render(geo, cam)` bridges Geo→TexNode.                                                                                                         |
|**Module**   |A typed composable unit: `kind: control | source | effect | geo | output`, typed inputs/params/output, optional state factory.                                                                              |
|**Scene**    |A composition of modules: `defineScene((ctx) => TexNode)`. Scenes are modules too — they nest.                                                                                                              |
|**InputBus** |The typed world handed to every scene via `ctx`: `audio` (bands, fft, rms, onsets, bpm), `midi` (cc, notes, pads), `time` (now, dt, beatPhase, beatEvery), `osc` (later). Modules never reach outside `ctx`.|
|**Instance** |A running scene graph with its live state and manifest values.                                                                                                                                              |
|**Pane**     |A view onto an instance in the Console (later: a separate OS window).                                                                                                                                       |
|**Stage**    |The slot/commit machinery. Whichever instance is routed to output is “LIVE”. Commits crossfade.                                                                                                             |
|**Fixture**  |A recorded InputBus trace, replayable deterministically for testing and agent self-evaluation.                                                                                                              |

State has three layers, kept distinct: **definitions** (code, in git) → **tuned state** (param values per scene, MIDI bindings — JSON in `state/`, written by “save”) → **instance state** (GPU pools, feedback textures, op memories — ephemeral, owned by the running instance).

## 4. What you can do (functional requirements)

### R1 — Prompt to pixels

- **R1.1** Ask the agent for a visual in natural language; it writes/edits scene and module files; the result renders in a pane within ~1–2 s of file save (HMR).
- **R1.2** The agent can *see its own output*: it captures frames from any instance and iterates against your stated intent without you describing the screen.
- **R1.3** The agent can spawn parallel subagents to implement multiple modules concurrently: signatures are written first, implementations fan out, the scene compiles the moment all contracts are satisfied.
- **R1.4** A type error or failed compile rejects the hot update; the previous good version keeps rendering, with a visible ✗ chip on the pane.

### R2 — See everything

- **R2.1** The Console shows one live-rendering tile per instance — including instances created by subagents mid-build — so generation is watchable in real time.
- **R2.2** A status bar shows transport (playing/paused), BPM, audio level, MIDI connection, fps — legible from three feet in a dark booth.
- **R2.3** The agent has the same awareness via `get_session`: transport, instances, panes, manifest values, devices, fps.

### R3 — Tweak until it feels right

- **R3.1** Selecting a pane shows an auto-generated param panel from its manifest: sliders (ranged floats), steppers (ints), toggles, color swatches. Fully mouse-operable. No hand-built per-scene UI, ever.
- **R3.2** The agent tweaks the same params via `set_param` — sub-second, no recompile. Param changes and code changes are separate operations; agents converge on feel via params before rewriting structure.
- **R3.3** MIDI-learn: tap a param, move a knob, bound. Bindings persist per scene/panel in `state/bindings/`.
- **R3.4** “Save that as *bass-tunnel*” persists wiring **and** current tuned values as a named scene; “pull the feedback chain out as its own module” factors and registers a new module.
- **R3.5** You can ask for a **panel** — “a UI panel for erraticness, palette, tessellation, kick strength, mapped to my controller” — and the agent emits a declarative panel file: an ordered subset of manifest params with widgets and MIDI bindings. Opening the panel activates its bindings.

### R4 — Perform

- **R4.1** The Stage holds a LIVE instance and staged candidates. COMMIT crossfades on a frame boundary. That button (and PANIC) are the only controls that touch the audience.
- **R4.2** PANIC: one control that holds the last good frame / cuts to a designated safe scene.
- **R4.3** Output is a chrome-free fullscreen window on a chosen display, independent of the Console.
- **R4.4** Audio (interface/loopback via input device), MIDI, and clock are available to every scene through the InputBus — the standing input abstraction. Adding a new input class (e.g., OSC) extends the bus, not the scenes.
- **R4.5** The instrument works with the agent absent or mid-task: library scenes, MIDI, mouse params, and commit all function offline.

### R5 — Library that grows

- **R5.1** A **standard library** ships with the engine: the TD-vocabulary baseline (see §6).
- **R5.2** A **custom library** is just more modules in the repo (`modules/custom/` or per-project dirs) with the same metadata contract.
- **R5.3** A **catalog** (generated JSON: name, kind, signature, description, tags, example) is built from module metadata by a script and on save. The agent’s library skill instructs: *search the catalog before writing new code; register new modules after writing them.* This is the entire “awareness” mechanism — no embeddings or services in v1; the catalog rides into context.
- **R5.4** Fixtures let any agent test a module deterministically: instantiate with `fixture:techno-loop-1`, screenshot frames N, compare before/after.
- **R5.5** Library items carry tags (energy, mood, palette, bpm-range) the agent uses when selecting or generating.

## 5. The agent contract

- **v1 agent = Claude Code in a terminal** beside the Console. Build mode and perform mode are the same thing in v1.
- **MCP server (thin, the only new agent surface):**
  - `get_session()` — full typed session snapshot
  - `get_manifest(instance)` — params with types/ranges/current values
  - `set_param(instance, path, value)`
  - `screenshot(instance, {frames?})` — returns images; with a fixture input, frame numbers are reproducible
  - `create_instance({scene|module, harness?, inputs: live|fixture:…})` / `destroy_instance(id)`
  - `stage(instance)` / `commit()` — and nothing else can touch LIVE
- **Conventions live in the repo:** `CLAUDE.md` (architecture, rules: signatures-first for parallel work, params-before-rewrites, never edit `runtime/` during a session) plus skills: *module-authoring*, *scene-composition*, *library-use*, *panel-authoring*.
- **Later (post-v1): perform-mode chat pane** embedded via the Claude Agent SDK — same harness, same MCP tools and skills, with session state auto-injected and proposals surfaced as commit buttons. The WebSocket/MCP boundary is designed so this is an additive client, not a rewrite.

## 6. Standard library v1 (the TD vocabulary, ported)

- **Control (CHOP-land):** `lag`, `math` (add/mul/range-map), `envelopeFollower`, `lfo` (sine/saw/square, beat-syncable), `sampleHold`, `beatDivide`, `quantize` (frame-resolution), `smooth`, `trigger` (events→AR envelope signal)
- **Sources (TOP-land):** `osc`, `noise` (value/simplex/fbm), `gradient`, `solid`, `videoClip`, `webcam`, `shader` (escape hatch: raw WGSL/TSL with typed uniforms)
- **Effects:** `blur`, `feedback` (stateful), `kaleid`, `mirror`, `displace`, `paletteMap`, `levels`, `pixelate`, `edge`, `composite`/`blend`, `crossfade`
- **Geo (arrives at the 3D milestone):** `gltf`, `primitives`, `particleEmitter` (surface-sampled, GPU-instanced), `orbitCam`, `render`
- **Output/util:** `switcher` (event-driven clip cuts), `mixer2`

Bar for inclusion: each module ≤ ~150 lines, fully typed metadata, one-line description, one usage example in its header — written as much for the agent as for you.

## 7. Non-functional requirements

- **NFR-1** Render loop is deterministic and agent-free; target 60 fps @ 1080p on the dev machine (define exact GPU at M0).
- **NFR-2** Engine cannot be crashed by content: module/scene exceptions are caught per-instance; a throwing instance freezes its tile, never the app.
- **NFR-3** Save→visible ≤ 2 s; `set_param`→visible ≤ 100 ms; COMMIT crossfade glitch-free.
- **NFR-4** Everything authored is plain text; `git clone` + install + run reproduces the instrument minus ephemeral state.
- **NFR-5 (v1 simplification)** Instance state policy: **any code change rebuilds the instance** (params reapplied from tuned state; feedback/pools reset). Predictable over clever. State-preserving hot-swap is explicitly post-v1.

## 8. Out of scope for v1

NDI/Syphon/Spout output · OSC input · projection mapping/multi-output · voice control · embedded chat pane (Agent SDK) · look-ahead/beat-accurate event scheduling · embeddings-based library search · generative-video sources (Mirage/StreamDiffusion) · pop-out OS-window panes · Electron shell (v1 is browser + Node sidecar) · collaborative/multi-user anything.

Each of these has a designed seam (InputBus, source module kind, Pane abstraction, MCP boundary) so adding it later is additive.

## 9. Success criteria — the magic test

From a fresh clone, with music playing and a MIDI controller attached, within **15 minutes** you can:

1. Say *“make me a dark tunnel that breathes with the bass, with a slowly shifting teal-to-magenta palette”* → watch it appear and self-correct in a workbench tile;
1. Say *“slower rotation, punchier kick response”* → see it change in under a second; drag two sliders yourself;
1. Say *“give me a panel for palette, intensity and kick strength, mapped to my controller”* → turn physical knobs and feel it;
1. Hit COMMIT → it crossfades to the output display;
1. Say *“save it as bass-tunnel”* → and next session, *“something like bass-tunnel but harder”* works because the library remembers.

If a step needs you to read engine code or babysit a compile error, that step has failed the spirit.

## 10. Open questions (parked, not blocking)

1. Auto-commit cadence for agent-driven sets — design once manual commit feels right (post-M4).
1. Beat-accurate quantization (InputBus look-ahead clock) — revisit when frame-resolution cuts feel sloppy in practice.
1. Catalog scaling — flat JSON until it measurably stops working; then embeddings.
1. When the Geo path lands, do Hydra-style one-liner chains still earn a convenience wrapper, or is TSL ergonomic enough alone?

## 11. v1.1 additions (post-M3)

Adopted after the M3 design review; these extend v1 scope without touching §8 (everything below rides existing seams — InputBus, Param/Manifest, the MCP boundary, sibling pages on `BroadcastChannel`). Implementation plan v1.1 maps them to milestones M4–M6.

- **R6 — The input rack.** Every input the instrument reacts to is a *named, tunable channel* in one global registry (audio-derived: `kick`, `hats`, named tuned variants like `kickTight`; MIDI CCs when hardware is present).
  - **R6.1** Channels are code-defined in `content/inputs.ts` (typed, in git, agent-growable); the Console tunes existing channels but does not create them.
  - **R6.2** Channel tunings (threshold, decay, gain, enable) live on a global manifest — same param machinery as instances, addressed as pseudo-instance `"globals"` — and persist across sessions.
  - **R6.3** Modules consume channels by name (`ctx.input("kick")`); retuning a channel never rebuilds an instance. Each consumer gets a per-instance *trim* (gain) param; detection meaning is owned globally — a differently-detected kick is a new named channel, not a local override.
  - **R6.4** The Console has a rack view (hotkey) showing every channel with a live meter and its tuning widgets — tune the inputs while the music plays.
- **R7 — Global color palettes.** Two global palettes (*primary*, *secondary*), each five ordered color stops, adjustable live from the Console and the agent.
  - **R7.1** Scenes consume stops by index or as a gradient ramp; index roles (bg/primary/accent) are documented convention, not kernel vocabulary.
  - **R7.2** Each palette-consuming instance has a live `palette.source` param: primary / secondary / its own defaults. Switching is instant (no rebuild) and choosable from the stage strip when the instance is staged.
  - **R7.3** A palette-index slider (a scene param that selects among preset gradients, e.g. the cosine `colorize` palettes) may carry `swatches` — one gradient preview per option — and the Console renders a visual chooser from them: pick a palette by seeing its colors, not by guessing a number. The slider still rides fractional blends between presets.
  - **R7.4** Any color param — an instance color (`ctx.color`) or a global palette stop — can be decomposed live into three modulatable, MIDI-bindable channels (H/S/V or R/G/B) via `set_color_space`; the color recomposes from its channels every frame (no rebuild), and collapsing back to a flat picker clears the channels' modulators/bindings. Decompositions persist and survive rebuilds.
- **R8 — Post-effect chains.** Any running instance can have a chain of post-effects attached, removed, and reordered at perform time, without code edits.
  - **R8.1** Chain edits can never blank the instance: a failing edit leaves the previous pixels running (same containment as code rebuilds, NFR-5 semantics — feedback state resets on a successful edit).
  - **R8.2** Each chain step exposes its params on the instance manifest (stable per-step paths; reordering preserves tuned values). The Console shows the chain for the selected instance: select a step, tweak, drag to reorder, collapse.
  - **R8.3** Humans may edit the LIVE instance's chain directly; agents need the same arming gate as `commit` to touch the LIVE chain.
  - **R8.4** Module outputs are explicitly typed (texture / signal / events, geo later); chainable effects are texture→texture and declare their chain-tunable params in metadata.
- **R9 — Pure output & staging flow.**
  - **R9.1** The Output window renders pixels only — no textual overlay (diagnostics opt-in via query flag). Controls that lived there (audio source selection) move to the Console.
  - **R9.2** Output never warps: fixed internal render resolution, scaled to fill the window preserving aspect (cover: match the smaller dimension, center, crop overflow).
  - **R9.3** Staging is direct: drag a tile to the stage strip to stage it; a staged tile's stage control becomes unstage; a dedicated `/staged` page (second tab/display) shows the staged visual large with its own COMMIT and unstage.