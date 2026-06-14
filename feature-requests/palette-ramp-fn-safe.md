# Fn-safe palette ramp — make `ctx.palette.ramp()` work inside a TSL `Fn()`

**Status:** SHIPPED (Option A). `ctx.palette.ramp()` is now built from the stop
uniforms via an in-shader 5-stop `mix` (no LUT texture), so it works inside a
TSL `Fn()`. `mandelbulb` uses it directly inside its raymarch loop; the
golden-pattern scan now guards only raw `texture()` samples inside an `Fn()`
(the general hazard that remains). Surfaced while building `mandelbulb` (#20).

## The problem

`ctx.palette.color(i)` returns a `uniform()` node; `ctx.palette.ramp(t)` returns
a **`texture(rampTex, vec2(t, 0.5))`** sample node (`packages/runtime/src/palette.ts`).
A texture-sample node constructed **inside a TSL `Fn()` function-scope** is not
collected into the material's sampler bindings by three's node backend — the
sampler reads unbound, so the shader **silently renders black** (the build
succeeds, `instanceError` is `null`, nothing in the console). Plain `uniform()`
nodes cross the `Fn` boundary fine, which is why `color(i)` works inside an `Fn`
and `ramp()` does not.

This only bites shaders that need an `Fn` body — i.e. control flow (`Loop`/`If`/
`.toVar()`), which is exactly the raymarch/escape-time family. Every other module
samples textures at the top level of `build()`, so the hazard stayed latent until
`mandelbulb` needed both a `Loop` and a palette gradient in the same shader. It
cost a full bisecting debug session (the screenshot just shows black).

Current workaround (shipped in `mandelbulb`): capture the five
`ctx.palette.color(i)` uniforms outside the `Fn` and `mix()` a 5-stop gradient by
hand (`ramp5`). Correct, but every future raymarch author has to rediscover it.

## Proposal

Make the gradient **uniform-based instead of texture-based**, so the official API
works everywhere (top level *and* inside an `Fn`).

**Option A (preferred) — `ramp()` builds from the stop uniforms.** Drop the
256×1 `DataTexture` and compute the gradient in-shader from the five `color(i)`
uniforms via the sequential-`mix` pattern (`mandelbulb`'s `ramp5`). For 5 stops
this is visually identical to the LUT, costs ~4 `mix`es of ALU, removes a
per-frame texture upload, and has no binding-scope hazard. `finalize()` no longer
needs the `fillRamp`/`needsUpdate` path. Lowest risk to call sites — signature
(`t → vec4`) is unchanged.

**Option B (additive) — keep `ramp()`, add `rampNode(t)`.** Same uniform-based
gradient under a new name; leave the texture `ramp()` for top-level callers. More
surface area, two ways to do one thing — only worth it if some caller depends on
the exact 256-sample quantization (none do today).

Recommend **A**: one code path, the footgun disappears, and the content-side scan
can stay as a cheap backstop.

## Acceptance

- `ctx.palette.ramp(t)` called inside a `Fn(() => { … })` renders the gradient
  (not black) — add a smoke scene to `validate:stdlib` or a render check.
- Existing palette callers (`noiseField`, `gradient`, `plasma`, `paletteMap`,
  `colorize`) look unchanged (A/B screenshot diff within tolerance).
- Source switch (`palette.source` primary/secondary/own) still retints live with
  no rebuild (R7.2) — the stop uniforms already update per frame in `finalize()`.

## Out of scope / notes

- The deeper cause is upstream (three's node backend not binding function-scoped
  texture samplers); `three` is pinned exact and not ours to chase.
- Until/unless this lands, the guard (`content/test/golden-patterns.test.ts`:
  "no module/scene calls `ctx.palette.ramp()` inside an `Fn()`") + the
  module-authoring "Shader gotchas" note keep the hazard from recurring.
