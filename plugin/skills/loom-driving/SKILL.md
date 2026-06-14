---
name: loom-driving
description: Use whenever you are driving a LOOM live-visuals rig with the loom MCP tools — making a visual, tuning a scene, switching scenes, staging/committing, screenshotting. Covers the MCP tool surface, the live-performance rules, and the "make me a visual" workflow.
---

# Driving LOOM

LOOM is a live-visuals instrument. A human is watching the Output window while you
work — **everything you save renders live**. Your eyes and hands are the `loom`
MCP server's tools; the engine (the LOOM Output window) must be running and dialed
in to this plugin's sidecar for those tools to work.

## Connecting: the engine dials YOU

The plugin's MCP server is a WebSocket **server**; the LOOM engine is the **client
that connects to it**. You don't "find" the engine — it finds you on a shared port.

- The sidecar listens on `LOOM_WS_PORT` (this plugin's `ws_port` config; default
  **7341**). The user's LOOM engine must point at the same port (its `?ws=` URL
  param / `LOOM_WS_PORT`). If they disagree, no tools will work.
- When no engine is connected, every tool returns a clean error:
  **"engine not connected — start LOOM"**. That is not a plugin bug — tell the
  user to launch their LOOM Output window and confirm the port matches.
- `get_diagnostics { scope: "sidecar" }` reports `engineConnected` and the
  sidecar's `protocolVersion`. If the engine warns of a PROTOCOL MISMATCH in its
  logs, the plugin and the engine are on different protocol generations — they
  must be updated to match.

## Your eyes and hands (MCP tools)

- `get_session` — what's running: all instances with status, LIVE/STAGED pointers, available scenes, audio mode, BPM, fps, frame, plus PANIC state (`panicMode`, `panicActive`, `panicScene`). **If `panicActive` is non-null, the human hit the emergency hatch — stop touching the live path and wait.** You can't trigger/clear/arm/designate panic; those are human-only.
- `get_manifest` — every tweakable param of an instance: type, range, default, current value. Also lists the instance's **layer nodes** (`nodes: [{id, parent, chain}]`) — named grabbables wrapped with `ctx.layer()` whose rig params live at `<id>.layer.x/y/scale/rotate/opacity` (move/spin/scale/fade with plain `set_param`, never a rebuild).
- Instance ids: the boot instance is `"boot"`; created ones are `"<scene>-<n>"`. The id `"live"` is an **alias** that always resolves to whatever instance is currently routed to output — the default everywhere, so "tweak the live thing" needs no lookup.
- The pseudo-instance `"globals"` serves the **input rack** *and* the **global color palettes**: `get_manifest {instance:"globals"}` lists every channel tuning (`inputs.kick.threshold`, `inputs.bass.gain`, …) plus the two palettes' stops (`palette.primary.0`…`palette.secondary.4`). `set_param` retunes either live for every consumer at once. `get_session` carries the live channel values in `inputs` (your meters).
- `set_param` — change a param live (<100 ms, no recompile). Values clamp to range. Errors if the param is modulated — `clear_modulation` first.
- `set_params` — change **many** params on one instance at once: `{ instance?, values: { path: value, … } }`. Every knob lands on the **same frame** in one round-trip — **prefer it whenever you touch more than one knob**. Partial success: a bad path comes back in `errors[]` without dropping the others. Works on `"globals"` too.
- `modulate_param` — attach an LFO/stepper/audio-follower to a param: `{ type: sine|triangle|ramp|square|random|drift|cycle|audio, periodSeconds|periodBeats, lo?, hi?, ... }`. Animates every frame inside the param's range. Same trust tier as `set_param` (no arming, live allowed); attaching replaces any existing modulator.
- `set_color_space` — decompose a color param into channel sliders (`hsv` → `.h/.s/.v`, `rgb` → `.r/.g/.b`), or collapse it back (`hex`). Each channel is an ordinary 0..1 float you can then `modulate_param` to retint live. Works on instance color params and the global palette stops.
- `clear_modulation` — detach a param's modulator (no-op success if none); the param holds its last value.
- `set_modulation_enabled` — pause/resume a param's modulator WITHOUT detaching: `{ instance, path, enabled }`. Paused = the wave freezes and `set_param` works again.
- `set_chain` — CRUD an instance's **post-effect chain** in one idempotent call: pass the FULL desired list of `{ effect, id?, params?, mix? }`. `effect` is a name from `get_session`'s `availableEffects`. Keep a surviving step's `id` to preserve its knobs across a reorder; omit `id` for a new step. After the rebuild, tune with `set_param` on `fx.<id>.<param>`; `fx.<id>.mix` is wet/dry. Pass `node: "<id>"` to chain FX onto just that layer node. `restoreDefault: true` resets to the scene's declared chain. **Editing the LIVE chain needs agent-commit armed** (sandbox instances are ungated).
- `save_chain` — save an instance's current chain as a reusable **composite effect** (`{ instance, name }`) that then appears in `availableEffects`. Chain must be all primitives.
- `get_diagnostics` — the engine's structured event TIMELINE (the history a snapshot can't show). Run the loop: act → `get_diagnostics { since: <last now.seq> }` → see what your action triggered → `screenshot` to confirm. Events carry a dotted `kind` (`scene.swapped`, `scene.rejected`, `instance.rejected`, `instance.frozen`, `loopguard.tripped`, `perf.*`, …). Page forward with `since`; `dropped` tells you how many events were evicted. Carries a `perf` rollup; `scope:"sidecar"` shows your own MCP-call latency + connection/protocol state. **Read it after you act — it's how you learn a save was rejected when the screenshot looks unchanged.**
- `screenshot` — see an instance's actual pixels. Use it after every meaningful edit; never guess what's on screen.
- `create_instance` — build a scene (by name from `availableScenes`) into a sandbox tile — build candidates without touching the audience.
- `destroy_instance` — free a sandbox tile (the LIVE instance is protected).
- `stage` / `unstage` — mark/clear your candidate for the live output. Always safe — changes nothing on screen.
- `commit` — crossfade staged → LIVE. **Human-gated by default**: unless the human armed agent commit, this errors — by design. Stage, then *tell the human it's ready to audition and commit*.
- `record_fixture` / `create_instance { inputs: "fixture:<name>" }` — record the live input rack for N frames, then replay it deterministically. On a fixture instance, `screenshot { frames: [...] }` runs a deterministic offline pass: same fixture + frame list → byte-identical images.
- `list_projects` / `save_project` / `load_project` — **set lists**: a saved instance set (scenes, tuned values, modulators, chains, tile order). Loading is **audience-safe**: every project instance builds into a sandbox, LIVE keeps playing. Agent `save_project` needs arming like commit.
- `batch` — run several tools in **one call**: `{ calls: [{ tool, args }, …], stopOnError? }`. Serial, one round-trip — the lowest-latency way to make many changes spanning different tools/instances. Per-call gates still apply; `batch` can't nest.

`?audio=test` on the engine URL gives synthetic kick/hats when no mic is around. The human's cockpit is the Console — they see every instance as a tile, drag your params, PANIC, and COMMIT there.

## Rules

1. **Params before rewrites — and batch them.** To change feel (speed, intensity, color), first check `get_manifest`, then tune params, not code. Setting more than one knob? reach for `set_params` (one frame, one round-trip). Work spanning tools/instances? wrap it in a `batch`. Only edit code when the structure itself is wrong; when code must change, expose the new knob as a param.
2. **Trust the safety net, verify with eyes.** A bad save never blanks the output (compile errors are withheld; build throws keep the previous scene; render throws freeze the instance). After a save, `get_session` tells you if your instance errored, and `screenshot` shows what's actually rendering.
3. **Build in sandboxes, hand over for the audience.** New work goes through `create_instance` → iterate (screenshot/set_param/edit) → `stage` → ask the human to COMMIT. Editing the boot scene directly hot-swaps the live output — fine in a solo session, rude mid-performance.
4. **Read the diagnostics after you act.** The snapshot tools show the present; `get_diagnostics` shows the history. After any action that touches the build/swap/render path, run **act → `get_diagnostics { since }` → read → `screenshot`**. This is how you learn a save was *rejected* when the screenshot looks unchanged (a `scene.rejected`/`instance.rejected` event with the build error in its `data`).
5. **Audio reactivity consumes named rack channels**: `ctx.input("kick")` etc. A channel's detection meaning is owned globally (`"globals"`: `inputs.<name>.gain`); consumers get a per-instance `input.<name>.amount` trim. A differently-tuned kick is a **new named channel**, never a local re-detection. MIDI binding/learn is human-only.

## Workflow for "make me a visual"

1. `get_session` + `screenshot` — know the starting state.
2. Write/edit the scene (see the **scene-composition** skill), point the boot scene at it, save.
3. `get_session` — check the instance error is null. `screenshot` — compare against intent.
4. Iterate on code until the structure is right, then converge on feel with `set_params` — set the whole cluster at once. To change-and-look in one round-trip, `batch` the tweak with its screenshot:

   ```
   batch({ calls: [
     { tool: "set_params", args: { values: { trail: 0.8, punch: 2, drift: 1.02 } } },
     { tool: "screenshot" },
   ]})
   ```
5. Report the manifest knobs you exposed so the human knows what they can ride.

See the companion skills: **library-use** (search the catalog, reuse before rewriting), **module-authoring** (writing a new module), **scene-composition** (writing/wiring scenes).
