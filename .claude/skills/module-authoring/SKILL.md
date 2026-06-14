---
name: module-authoring
description: Use when writing a new LOOM module (source, effect, or control) in content/modules/ — covers the defineModule contract, TexNode/Signal rules, params, and the golden example.
---

# Module authoring

A module is one typed, composable unit in `content/modules/<kind>/<name>.ts`. Budget: ≤ ~150 lines, fully typed, metadata written for the next agent to find and reuse.

## The contract

```ts
export const myModule = defineModule(
  {
    name: "myModule",            // must match the export
    kind: "source",              // control | source | effect | geo | output
    description: "One line, concrete, says what it looks like / does.",
    tags: ["pattern", "organic"], // searchable vocabulary
    example: 'myModule(ctx, { scale: 3 })',
  },
  (ctx: BuildCtx, opts: MyModuleOpts = {}): TexNode => { ... },
);
```

- Export a named `Opts` interface; every option documented with a one-line comment.
- Options that should react to the world are `SignalLike` (number | Signal). Bridge them with `ctx.uniformOf(opt ?? default)` — that returns a TSL uniform usable in shader code and keeps stateful signals pulled.
- **Sources** return `texNode(vec4(...))` — color is strictly vec4; normalize once.
- **Effects** take `input: TexNode` and must propagate passes: a stateless effect returns `texNode(newColor, input.passes)`; a stateful one (render targets) returns `texNode(color, [...input.passes, ownPass])`. Order is composition order — no scheduler.
- **Effects should be chain-ready.** Declare the knobs `set_chain` exposes via `meta.chainParams: [{ name, type?, default, min, max, step?, description? }]` — each `name` must match an `Opts` key that's a `SignalLike`, so the chain feeds `param.signal()` straight in. With that, the effect is selectable in any instance's FX chain (the Console picker + MCP `set_chain`) and gets an automatic `fx.<id>.mix` wet/dry. See `glitch`/`feedback`/`levels`. An effect with no `chainParams` still works in scene code but won't appear as a chain step.
- **Controls** return a `Signal<number>` and run on the CPU; they must be cheap (called every frame).
- **Geo modules** (`content/modules/geo/`, kind `"geo"`) return a `GeoNode` (`{ object: Object3D }`) or a `CamNode` (`{ camera }`) — never pixels. Animate via `ctx.updaters.push((f) => …)` (frame-clock, fixture-deterministic). Pixels happen in the `render3d` bridge (a source): `render3d(ctx, { world: [geoNodes], cam: orbitCam(ctx, {}) })` → TexNode, after which everything 2D (chains, layers, effects) applies. Loaded models (`model`, glTF/FBX) normalize their materials to `MeshStandardMaterial` — exotic loader materials can throw in the render backend and freeze the instance.
- Modules never reach outside `ctx` — no globals, no direct bus access beyond `ctx.audio`/`ctx.time`.
- Modules may compose other modules (`pulseRings` wraps `noise` for its grain) — just propagate the inner module's passes through your returned `texNode`.
- A look that two scenes want is a module, not copy-pasted TSL. Extract the shared identity (`pulseRings` and `glitch` were both born this way) and let scenes differ in wiring and params.

## Shader gotchas (hard-won — each of these cost a debugging session)

- **Never import TSL `time`** — it reads the renderer's WALL clock, bypassing LOOM's frame clock, which breaks fixture-replay determinism (and a paused virtual clock would keep animating). Animate with `const t = ctx.uniformOf(ctx.time.now)` instead, or for a phase that accumulates a rate, `ctx.uniformOf(integrateSignal(rateSig, { wrap }))` — `wrap` keeps long-running phases float-precise. A golden-pattern scan rejects `time` imports.
- **Warping effects: use `bufferPass` from `../_shared`** — `const { rt, pass } = bufferPass(opts.input)` buffers the input into a destination-sized target so you can `texture(rt.texture, warpedUv)`; return `[...input.passes, pass]`. It has hooks for idle gates (`skip`), sibling targets (`onResize`/`onDispose`) and extra quad passes (`afterRender`) — see `blur`/`bloom`. Only history-keeping effects (feedback/echo/glitch) own FIXED-size buffers instead (history doesn't need destination resolution, and VRAM dies fast at 1080p×N frames).
- **Never hardcode `16 / 9`** in TSL math — use `surfaceAspect()` from `../_shared` (resolves the actual destination per draw: 1080p output, 640×360 previews, whatever comes later). CPU-side layout math (JS loops placing sprites) can't use a shader node — those modules take an explicit `aspect` opt, documented as such.
- **Instanced/vertex buffers you rewrite per frame need `setUsage(DynamicDrawUsage)`** — the WebGL backend only re-uploads static-usage buffers inside the rAF loop, so fixture offline passes silently freeze without it (a giant identity-matrix mesh is the tell).
- **Seed every randomness source.** `Math.random` is banned (scenes/modules); `MeshSurfaceSampler` defaults to it internally — call `setRandomGenerator(seededPrng)` (runtime API; @types/three omits it) or fixture replays stop being byte-identical. Use a mulberry32 with a fixed seed (see `particleEmitter`).
- **Loaded model materials get normalized** — loader-specific materials (FBX phong with layered textures) can throw inside the render backend and freeze the instance (NFR-2). `model` converts everything to `MeshStandardMaterial` (color + diffuse map); do the same in any new loader.

- **Never put a plain JS number as the FIRST argument of TSL math.** `mix(1.0, node, node)` or `step(0.0, node)` builds a shader that silently fails to compile — the instance reports ok but its render target never gets written (`screenshot` errors with "reading 'format'"). Wrap leading literals: `mix(float(1), …)`.
- **Derivative poisoning:** guarding invalid UV regions with a huge sentinel (mix to 1e6) collapses texture sampling to the lowest mip everywhere (giant mosaic). Guard by adding a SMALL node-first offset instead: `local.add(behind.mul(10))`.
- **Warping effects can't re-evaluate `input.color` at a shifted UV** — the input is a node graph, not a function of UV. Render the input into an owned RenderTarget, then sample `texture(rt.texture, warpedUv)`; `content/modules/effects/glitch.ts` is the reference.
- **Never sample a `texture()` inside a TSL `Fn()` closure — including `ctx.palette.ramp()`.** A texture-sample node built inside an `Fn` function-scope isn't collected into the material's sampler bindings (three's node backend), so the sampler reads unbound and the shader silently renders **BLACK** (build ok, `instanceError` null — nothing tells you). `uniform()` nodes (`ctx.palette.color(i)`) cross the `Fn` boundary fine; texture samples do not. So build texture samples at the **top level** of `build()` and pass the value in; when you need a palette gradient inside an `Fn` (e.g. a raymarch loop that needs `Loop`/`If`), capture the five `ctx.palette.color(i)` uniforms outside and `mix()` the ramp by hand — see `mandelbulb`'s `ramp5` helper. A golden-pattern scan rejects `palette.ramp(` inside an `Fn(`.

## Golden example (source)

`content/modules/sources/osc.ts` is the reference: typed opts with doc comments, `ctx.uniformOf` for every reactive option, vec4 normalization, complete metadata. For a stateful effect, `content/modules/effects/feedback.ts` shows render-target ownership and pass ordering.

## Checklist before you're done

1. `pnpm typecheck` passes.
2. Metadata complete (name/kind/description/tags/example) — the generated catalog (auto-rebuilt on save by the dev server) is the library's search surface.
3. Exercise it from a scene (wire into `live.scene.ts`), `screenshot`, confirm it does what the description claims.
4. If it has tunable feel, expose params in the *scene* that uses it (params live in scenes; modules take Signals/opts).
