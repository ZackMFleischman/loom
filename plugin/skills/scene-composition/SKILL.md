---
name: scene-composition
description: Use when writing or editing a LOOM scene (content/scenes/*.scene.ts) — covers defineScene, the InputBus, params as the tuning surface, and going live via live.scene.ts.
---

# Scene composition

A scene composes modules into the picture: `defineScene({ name, description, tags, build(ctx) => TexNode })` in `content/scenes/<name>.scene.ts`.

**Where to write it.** Cloned the monorepo? write `content/scenes/<name>.scene.ts`. Installed LOOM as a dependency (no writable `content/`)? write the scene into a **module pack** (`<pack>/scenes/<name>.scene.ts`), registered with `pack:add` — see the **library-use** skill. Pack scenes appear in `availableScenes` namespaced as `<pack>/<name>`. "Going live" differs: a pack can't edit the engine's `content/scenes/live.scene.ts`, so to put a pack scene on the boot output use `create_instance { scene: "<pack>/<name>" }` → `stage` → ask the human to commit (the MCP control surface), rather than re-pointing `live.scene.ts`.

**Scenes are wiring, not shaders.** A scene's job is params + InputBus signals routed into catalog modules. If a build() grows more than a few lines of inline TSL, the visual identity belongs in a module — extract it (see module-authoring) so other scenes can reuse it, then wire it here. The `pulseRings` source and the `glitch` effect were both extracted this way (two scenes wanted the same look) rather than staying baked into one scene. Duplicated TSL across scenes is the smell that a module is missing.

## Shape of a good build()

```ts
build(ctx) {
  // 1. Params — the human's knobs. Honest ranges, good defaults, descriptions.
  const punch = ctx.float("punch", { default: 1.2, min: 0, max: 3, description: "kick hit strength" });

  // 2. World — consume named input-rack channels (content/inputs.ts).
  const kickEnv = ctx.input("kick");                          // bass onsets -> tuned envelope
  const bass = ctx.input("bass");                             // lagged bass energy
  const beat = lfo(ctx, { shape: "sine", periodBeats: 16 });  // beat-synced drift

  // 3. Bridge CPU -> GPU once per value.
  const kickU = ctx.uniformOf(kickEnv);
  const punchU = ctx.uniformOf(punch.signal());

  // 4. Compose catalog modules: sources -> effects. Inline TSL only for one-off glue.
  const src = pulseRings(ctx, { energy: kickEnv, hue: beat });
  const trails = feedback(ctx, { input: src, amount: 0.9 });
  return levels(ctx, { input: trails, gain: bass.map((b) => 1 + b) });
}
```

`content/scenes/pulse.scene.ts` is the golden example of all four steps.

## Rules of thumb

- **Params are the contract with the human.** Anything they'll want to ride live (intensity, speed, color drift, persistence) is a `ctx.float/int/bool`, not a constant. Tune via `set_param` before touching code again.
- **Audio reactivity goes through the input rack**: `ctx.input("kick"|"hats"|"bass"|"energy")` — named channels defined in `content/inputs.ts`, tuned once globally (manifest instance `"globals"`: `inputs.kick.threshold`, …), consumed late-bound (retuning never rebuilds your scene). Each `ctx.input` auto-declares an `input.<name>.amount` trim param. **Trims, not overrides** — if you need a differently-detected kick, add a new named channel to `content/inputs.ts` (e.g. `d.onset("kickTight", …)`); don't retune `kick` to fit one scene.
- Raw bus access (`ctx.audio.band/rms/onset` + `lagSignal`/`envelopeSignal`) still exists for experiments, but a detection idiom worth keeping belongs in the rack where the human can tune and meter it (Console drawer on `i`).
- Time: `ctx.time.beatPhase`, `ctx.time.beatEvery(n)`, or `lfo(ctx, { periodBeats })` for beat-locked motion.
- Check `content/CATALOG.md` (generated one-line index of every module + scene, auto-rebuilt on every save while the dev server runs) before writing inline shader code — compose existing modules first; if the look you need isn't there, add a module rather than inlining it.
- Combining several signals (e.g. `energy = kickEnv * punch + bass * 0.6`)? Build one derived signal: `new Signal((f) => kickEnv.get(f) * punchSig.get(f) + bass.get(f) * 0.6)` and pass it to a module opt — pulling it through `uniformOf` keeps every stateful input ticking.
- Scene throws at build are contained but waste an iteration: prefer typecheck-clean saves.

## Deterministic iteration with fixtures

When you're iterating on an audio-reactive scene and the test signal's timing luck keeps moving the goalposts: `record_fixture { name, frames }` captures the rack once, `create_instance { scene, inputs: "fixture:<name>" }` replays it identically forever, and `screenshot { instance, frames: [30, 90] }` renders byte-identical frames offline — so "did my edit improve frame 90" is answerable. The same trick isolates parallel subagents from each other's audio.

## Video decks

`video(ctx, { url, speed, scrubbing, scrub, loop })` plays a clip exactly where an `image` would sit (same placement, muted). The media controls are SignalLike — wire them to scene params so the human retimes/scrubs on faders with no rebuild. Clips OUTSIDE the repo go through `mediaUrl("C:\\abs\\path.mp4")` (served by the `loom:media` middleware; the path must live under a root registered in `content/state/media-roots.json`). A missing/undecodable file stays transparent — Chrome plays H.264/VP9 mp4/webm, NOT MJPEG `.mov`. Wrap every video in `ctx.layer(...)`.

## Layer nodes — wrap the grabbables

`ctx.layer("name", tex)` wraps any TexNode as a named node the human (and you) can grab later without new scene code: rig params appear at `<name>.layer.x/y/scale/rotate/opacity` (identity defaults, plain `set_param`, never a rebuild) and `set_chain { node: "<name>" }` chains FX onto just that node (knobs at `<name>.fx.<step>.<param>`).

```ts
const badge = ctx.layer("logo", image(ctx, { url: LOGO_URL }));   // a grabbable logo
return over(ctx, { input: ctx.layer("core", composed), overlay: badge });
```

- **Wrap the obvious grabbables**: every `image`/`video` source and each major compositional stage. Skip throwaway intermediates — each wrap costs one buffer pass; unwrapped nodes cost nothing.
- Names are per-scene unique, letter-first (`logo`, `bowl`, `flock`); reusing a param-group name (`logo.*`) merges node + group into one Console section — usually what you want.
- Node FX recolor within the node's silhouette (the chain's wet/dry carries the layer's alpha). Silhouette-expanding FX (feedback halos, trails) go *inside* the wrap (`ctx.layer("x", feedback(ctx, {...}))`) or on the root chain.

## Palettes (R7)

Two global 5-stop palettes (`primary`/`secondary`) live on the `"globals"` manifest and retint every consuming scene at once. Consume them instead of hardcoding colors so the human can recolor a scene live:

- `ctx.palette.color(i)` — stop `i` (0..4) as a vec3, usable directly in TSL math.
- `ctx.palette.ramp(t)` — a gradient lookup across all 5 stops, `t` in 0..1 → vec4.
- `ctx.palette.own([...5 "#rrggbb"])` — your scene's default stops (the `own` source). Call at most once per build.

Using any of them auto-declares a `palette.source` int param (`0` primary · `1` secondary · `2` own) — flipping it is a plain `set_param`, resolved per frame, **never a rebuild**. Default is `own` if you called `own()`, else `primary`. Stop roles are convention: `0` bg · `1` edge · `2`/`3` core · `4` accent. Color params can't be modulated.

The minimal ramp consumer — a scrolling gradient (`content/scenes/gradient.scene.ts`):

```ts
import { defineScene, Signal, texNode } from "@loom/runtime";
import { fract, uv } from "three/tsl";

export default defineScene({
  name: "gradient",
  description: "Scrolling horizontal gradient across the active palette's five stops.",
  build(ctx) {
    const speedS = ctx.float("speed", { default: 0.02, min: 0, max: 0.5 }).signal();
    let phase = 0;
    const phaseU = ctx.uniformOf(new Signal((f) => (phase = (phase + f.dt * speedS.get(f)) % 1)));
    return texNode(ctx.palette.ramp(fract(uv().x.add(phaseU))));
  },
});
```

Stops as discrete colors — set scene defaults with `own()`, then build with `color(i)` (from `lava.scene.ts`):

```ts
const pal = ctx.palette;
pal.own(["#161238", "#76102c", "#f37627", "#da3089", "#ffc15e"]); // bg · edge · core · core · accent
const lavaCore = mix(pal.color(2), pal.color(3), hueU);
const rgb = mix(pal.color(0), mix(pal.color(1), lavaCore, glow), body)
  .add(pal.color(4).mul(glow).mul(kickU)); // accent flash on the kick
```

## Going live

`content/scenes/live.scene.ts` re-exports the active scene — switch with that one line. After saving: `get_session` (instanceError null? scene name right?) then `screenshot` to compare against intent. Iterate structure in code; converge feel with `set_param`; tell the human which knobs exist.

A brand-new `*.scene.ts` hot-registers automatically (the dev server watches `content/`). If `create_instance` still reports the scene unknown, touch `packages/engine-app/src/scenes.ts` to force the barrel glob to re-expand.
