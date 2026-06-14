# LOOM agent guide

You are working inside LOOM, a live-visuals instrument. A human is watching the Output window while you work — **everything you save renders live**. Start sessions from the repo root so the `loom` MCP server (.mcp.json) loads.

## Your eyes and hands (MCP tools)

- `get_session` — what's running: all instances with status, LIVE/STAGED pointers, available scenes, audio mode, BPM, fps, frame. Also carries PANIC state: `panicMode` (armed `hold`|`scene`), `panicActive` (`null` when calm), and `panicScene` (the safe scene's name + build health). **If `panicActive` is non-null, the human has hit the emergency hatch — stop touching the live path and wait for them.** The pinned panic instance appears in `instances` with `pinned: "panic"` (always warm; you can't trigger, clear, re-arm, or destroy it — those are human-only).
- `get_manifest` — every tweakable param of an instance: type, range, default, current value. Also lists the instance's **layer nodes** (`nodes: [{id, parent, chain}]`) — named grabbables wrapped with `ctx.layer()` whose rig params live at `<id>.layer.x/y/scale/rotate/opacity` (move/spin/scale/fade with plain `set_param`, never a rebuild).
- Instance ids: the boot instance (bound to `live.scene.ts`) is `"boot"`; created ones are `"<scene>-<n>"`. The id `"live"` is an **alias** that always resolves to whatever instance is currently routed to output — it's the default everywhere, so "tweak the live thing" needs no lookup.
- The pseudo-instance `"globals"` serves the **input rack** *and* the **global color palettes**: `get_manifest {instance:"globals"}` lists every channel tuning (`inputs.kick.threshold`, `inputs.bass.gain`, …) plus the two palettes' stops (`palette.primary.0`…`palette.secondary.4`, `color` params holding `"#rrggbb"`); `set_param` retunes either live for every consumer at once. Any stop can be split into modulatable H/S/V or R/G/B channels with `set_color_space` (R7.4). `get_session` carries the live channel values in `inputs` (your meters). Tunings persist across sessions (`content/state/`).
- `set_param` — change a param live (<100 ms, no recompile). Values clamp to range. Errors if the param is currently modulated — `clear_modulation` first.
- `set_params` — change **many** params on one instance at once: `{ instance?, values: { path: value, … } }`. The batched form of `set_param` — every knob lands on the **same frame** (no tearing) in one round-trip, so **prefer it whenever you're touching more than one knob**. Partial success: a bad/unknown/modulated path comes back in `errors[]` without dropping the others. Works on `"globals"` too (rack + palette stops).
- `modulate_param` — attach an LFO/stepper/audio-follower to a param: `{ type: sine|triangle|ramp|square|random|drift|cycle|audio, periodSeconds|periodBeats, lo?, hi?, ... }`. The engine animates it every frame inside the param's range. Same trust tier as `set_param` (no arming, live allowed); attaching replaces any existing modulator on that param. Use it to audition motion non-destructively before baking an `lfo` module into scene code. (Instance params — plus decomposed **palette color channels** on `"globals"`, see `set_color_space`; the input-rack tunings stay hand-driven.)
- `set_color_space` — decompose a color param into channel sliders, or collapse it back: `{ instance, path, space: hex|hsv|rgb }`. `hsv` exposes `<path>.h/.s/.v`, `rgb` exposes `<path>.r/.g/.b` — each an ordinary 0..1 float you can then `modulate_param` or MIDI-bind to retint live (the color recomposes from its channels every frame, no rebuild). `hex` removes the channels (clearing their modulators/bindings). Works on instance color params (`ctx.color(...)`) and the **global palette stops** (`palette.primary.<i>` / `palette.secondary.<i>`).
- `clear_modulation` — detach a param's modulator (no-op success if none); the param holds its last value.
- `set_modulation_enabled` — pause/resume a param's modulator WITHOUT detaching: `{ instance, path, enabled }`. Paused = the wave freezes, the param holds its last value and `set_param` works again; resume picks the wave back up. Errors when nothing is attached. (Humans can MIDI-bind the same toggle to a button from the Console's ∿ popover.)
- `set_chain` — CRUD an instance's **post-effect chain** in one idempotent call: pass the FULL desired list of `{ effect, id?, params?, mix? }` (so add/remove/reorder/insert are all expressed by what you send). `effect` is a name from `get_session`'s `availableEffects` (code primitives + saved chains). Keep a surviving step's `id` to preserve its knobs across a reorder; omit `id` for a new step. After the rebuild, tune knobs with `set_param` on `fx.<id>.<param>`; `fx.<id>.mix` is the wet/dry (0 bypassed · 1 full) — ride it with no rebuild. Every step also declares `fx.<id>.enabled` (bool toggle — flipping it fades the step to/from bypass over `fx.<id>.fade` seconds, no rebuild; MIDI-binds like any bool). `restoreDefault: true` resets to the scene's declared chain. A throwing step is rejected and the previous chain + pixels keep running (NFR-5). Pass `node: "<id>"` (a layer node from `get_manifest`'s `nodes`) to chain FX onto **just that node** — knobs land at `<node>.fx.<step>.<param>`. Node FX recolor within the node's silhouette (the wet/dry carries the layer's alpha); silhouette-expanding FX (feedback halos) go inside the wrap or on the root chain. **Editing the LIVE chain needs agent-commit armed** (sandbox instances are ungated); humans edit it freely in the Console.
- `save_chain` — save an instance's current chain as a reusable **composite effect** (`{ instance, name }`): a data file under `content/modules/effects/chains/` that then appears in `availableEffects` and drops into any chain like a primitive. Chain must be all primitives (saved chains are one level deep); live knob values are captured into the saved data.
- `screenshot` — see an instance's actual pixels (live = the Output canvas, others = their preview target). Use it after every meaningful edit; never guess what's on screen.
- `create_instance` — build a scene (by name from `availableScenes`) into a sandbox tile. This is how you build candidates without touching the audience.
- `destroy_instance` — free a sandbox tile (the LIVE instance is protected).
- `stage` — mark your candidate for the live output. Staging is always safe — it changes nothing on screen.
- `unstage` — clear the staged candidate (nothing is marked for commit). Also safe — changes nothing on screen.
- `commit` — crossfade staged → LIVE. **Human-gated by default**: unless the human armed agent commit in the Console, this errors — that's by design. Stage, then *tell the human it's ready to audition and commit*.
- `record_fixture` — record the live input rack (every channel, every frame) for N frames into `content/state/fixtures/<name>.json`. Replay it with `create_instance { inputs: "fixture:<name>" }` — the instance consumes the trace instead of the live rack (deterministic audio-reactivity). On a fixture instance, `screenshot { frames: [...] }` runs a deterministic offline pass: same fixture + frame list → byte-identical images, every call. **Never animate with TSL `time`** (wall clock, breaks this) — use `ctx.uniformOf(ctx.time.now)`; a source scan enforces it.
- `list_projects` / `save_project` / `load_project` — **set lists**: a project is the saved instance set (per instance: scene, tuned values, modulators, root + per-node chains, tile order) in `content/state/projects/<name>.json`. Loading is **audience-safe**: every project instance builds into a sandbox, LIVE keeps playing untouched; the pre-load instances cull automatically after a commit from the loaded set lands. Stage one of the created instances and hand over (or commit if armed). Agent `save_project` needs arming like commit.
- `batch` — run several of these tools in **one call**: `{ calls: [{ tool, args }, …], stopOnError? }`. They execute serially in order, sharing one round-trip — the lowest-latency way to make many changes at once (e.g. `set_params` on two instances, then `set_chain`, then `screenshot`). Each result carries its own `ok`/`result` | `ok:false`/`error`; screenshots taken inside come back as images. Per-call gates still apply (human-only verbs and live-commit arming are enforced inside the batch), and `batch` can't nest. Reach for `set_params` for the common "many knobs, one instance" case; reach for `batch` when the work spans different tools or instances.

The engine must be running (`pnpm dev`) for tools to work. `?audio=test` on the URL gives synthetic kick/hats when no mic is around. The human's cockpit is `/console.html` — they see every instance as a tile, can spawn library scenes themselves (scene picker), drag your params, PANIC, and COMMIT there.

## Rules

1. **Params before rewrites — and batch them.** To change feel (speed, intensity, color balance), first check `get_manifest`, then tune params, not code. When you're setting **more than one knob, reach for `set_params`** (the whole cluster in one frame, one round-trip) rather than a stream of `set_param`; when the work spans different tools or instances, wrap it in a **`batch`**. Single `set_param` is for a one-off nudge in a tweak→screenshot loop. Only edit code when the structure itself is wrong; when code must change, expose the new knob as a param.
2. **Never touch `packages/runtime/`** (or `packages/engine-app/`, `packages/sidecar/`) during a session. Your territory is `content/` — scenes and modules. Engine changes are human-reviewed work, not session work.
3. **Signatures first.** When building multiple modules (especially in parallel), write each module's exported interface + metadata stub first, make `pnpm typecheck` pass, then fill in implementations. Types are the coordination protocol.
4. **Trust the safety net, verify with eyes.** A bad save never blanks the output (compile errors are withheld; build throws keep the previous scene; render throws freeze the instance). After a save, `get_session` tells you if your instance errored, and `screenshot` shows what's actually rendering.
5. **Build in sandboxes, hand over for the audience.** New work goes through `create_instance` → iterate (screenshot/set_param/edit) → `stage` → ask the human to COMMIT. Editing `live.scene.ts` directly hot-swaps whatever is bound to the boot instance — fine in a solo dev session, rude mid-performance.
6. **One file is the boot scene**: `content/scenes/live.scene.ts` re-exports the scene the engine boots with. Don't delete it.
7. **Audio reactivity consumes named rack channels**: `ctx.input("kick")` etc., defined in `content/inputs.ts` (yours to grow — hot-reloads like a scene). A channel's detection meaning is owned globally; consumers get a per-instance `input.<name>.amount` trim — **hidden from the default params box** (it's auto-added, not scene-authored), revealed by the panel's "advanced" toggle and still fully tunable/MIDI-bindable. Reach for the global rack's `inputs.<name>.gain` to scale a channel for everyone; use the per-instance trim only when one instance needs a different level. A differently-tuned kick is a **new named channel** (`kickTight`), never a local re-detection. MIDI binding/learn is human-only (Console).

## Architecture map (summary — full detail in `docs/architecture.md`)

```
packages/runtime/    kernel: Signal/Events (pull-based, frame-memoized), Param/Manifest,
                     defineModule/defineScene, TexNode, BuildCtx, Instance, Time/Audio buses
packages/engine-app/ Output window: render loop, HMR, sidecar bridge   } not yours
packages/sidecar/    MCP <-> WebSocket bridge                          } to edit
content/modules/     {control,sources,effects}/  — composable typed modules   <- yours
content/scenes/      *.scene.ts + live.scene.ts re-export                     <- yours
content/inputs.ts    the input rack: named channels (defineInputs)            <- yours
content/state/       tuned state (inputs/bindings/values) — engine-written JSON
content/CATALOG.md   generated index of every module + scene — read this first
```

`CATALOG.md` regenerates automatically — the dev server rebuilds it on every module/scene save, and `pnpm typecheck` rebuilds it as the offline gate. Never edit it by hand; it is always current in a live session.

**A new module ships with its test case**: add a minimal-opts entry to `content/test/cases.ts` — `pnpm test:content` sweeps every module on disk (tier-1 contract: shape, pass ordering, honest ranges; tier-2: param-extremes NaN sweep) and its completeness test fails if your module has no case. Scenes and modules must consume `ctx.input(<channel>)`, never `ctx.audio.onset(...)` — a source scan enforces it. `pnpm validate:stdlib` smoke-renders every module for eyes-on proof (full doc: "Testing & validation" in `docs/architecture.md`).

Key kernel facts:
- Signals are pulled per frame and memoized on `f.frame`. CPU signals reach the GPU only through `ctx.uniformOf(signal)` — that registration is also what keeps stateful signals (lag, envelope) ticking.
- Signal cost is attributed: `get_session`'s `slowSignals` (per instance, smoothed ms, by param path / `input.<name>` / `palette`) breaks `frameMs` down to the specific signal eating the frame — read it when a scene feels heavy. A runaway/infinite loop in scene/module code is build-time **loop-guarded**: it throws (`[loom] loop guard:`) and freezes that instance (NFR-2) instead of wedging the render thread, so a bad loop is contained like any other throw.
- `TexNode.color` is strictly a TSL `vec4` node. Sources normalize to vec4 once.
- Stateful effects own pass ordering: return `[...input.passes, ownPass]`.
- Params: `ctx.float("name", { default, min, max, description })` → `param.signal()` → `ctx.uniformOf(...)`. Declare ranges honestly; the manifest is the human's mixing board.
- Particles (M8): `particleEmitter(ctx, { surface: <any GeoNode>, rate, lifetime, turbulence, ... })` boils particles off a mesh's SURFACE — feed `ctx.input("hats")` (scaled) to `turbulence` for the flagship look. It returns a GeoNode: put BOTH the surface and the emitter in `render3d`'s world. Seeded + frame-clocked, so fixture replays are byte-identical. `hippo-swarm` is the reference scene.
- Geo (M7): geo modules (`content/modules/geo/`: `box`/`sphere`/`torus`/`orbitCam`/`model`) return **GeoNodes/CamNodes**, not pixels; the `render3d` source renders them into the TexNode chain (`render3d(ctx, { world: [...], cam: orbitCam(ctx, {}) })`) — then chains/layers/effects apply as usual. `model` loads glTF AND FBX; external model files go through `mediaFsUrl(rootIdx, relPath)` (path-style, so FBX textures resolve). Watch `frameMs` in `get_session` (and fps in screenshot metadata) — 3D worlds are where frame budgets die.
- Layers: `ctx.layer("name", tex)` wraps any TexNode as a named, grabbable node — rig params + per-node FX for free, no pre-surfaced params needed. **Wrap the obvious grabbables** when writing a scene: every `image`/`video`, each major compositional stage. Names are per-scene unique, letters-first (`logo`, `bowl`); a node id shared with a param group (`logo.*`) merges into one Console section. Unwrapped nodes cost nothing; each wrap costs one buffer pass.
- Palettes (R7): scenes consume the global palettes via `ctx.palette.color(i)` (stop `i` as a vec3), `ctx.palette.ramp(t)` (gradient across the 5 stops, `t` in 0..1 → vec4), and `ctx.palette.own([...5 "#rrggbb"])` (scene-default stops). Using any of them auto-declares a `palette.source` int param (0 primary · 1 secondary · 2 own) — flip it with a plain `set_param`, **never a rebuild**; default is `own` when the scene called `own()`, else `primary`. Stop roles (0 bg · 1 edge · 2/3 core · 4 accent) are convention, not enforced. A color param can't be modulated directly, but `set_color_space` (R7.4) splits it into H/S/V or R/G/B channel floats that modulate + MIDI-bind like any slider — on instance colors (`ctx.color`) and the global stops alike. A palette-index slider (the cosine `colorize` selector) carries `swatches` so the Console draws a visual chooser (R7.3).

## Workflow for "make me a visual"

1. `get_session` + `screenshot` — know the starting state.
2. Write/edit the scene in `content/scenes/`, point `live.scene.ts` at it, save.
3. `get_session` — check `instanceError` is null. `screenshot` — compare against intent.
4. Iterate on code until the structure is right, then converge on feel with `set_params` — set the whole cluster of knobs at once, not one at a time. To change-and-look in a single round-trip, `batch` the tweak with its screenshot:

   ```
   batch({ calls: [
     { tool: "set_params", args: { values: { trail: 0.8, punch: 2, drift: 1.02 } } },
     { tool: "screenshot" },
   ]})
   ```
5. Report the manifest knobs you exposed so the human knows what they can ride.

See skills: **module-authoring** (writing a new module), **scene-composition** (writing/wiring scenes).
