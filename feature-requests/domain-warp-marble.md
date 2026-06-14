# Domain-warp marble — iterated fbm warping (post-v1 candidate)

**Status:** SOURCE SHIPPED — `marble` (grayscale iterated domain warp, scene
`marble-slab`). The chainable **effect** face (warp an input's UVs by the same
field, via `bufferPass`) remains the open item. Pure shader, no state — the
cheapest of the brainstorm batch.

## The gap

LOOM has `noiseField` (a fractal noise *texture*) and `displace` (warp UVs by a
map). It does not have **iterated domain warping** — IQ's `fbm(p + fbm(p +
fbm(p)))` — where the noise field warps *itself* recursively. That self-warp is
what turns flat fbm into the marbled, paint-swirled, liquid-agate look; one more
warp level reads completely differently from a single octave, and neither
existing module produces it.

## The idea

Ship `marble` in two faces off the same core warp function:

- **as a `source`** ✅ SHIPPED — outputs the grayscale fold value; the scene
  ramps it through `pickPalette` (so the marble palette is a live choice). Kept
  grayscale rather than self-colouring so it composes with `colorize`/`paletteMap`.
- **as a chainable `effect`** (still open) — warp an input's UVs by the iterated
  field. Since an effect can't re-sample its input as a function of UV, it
  buffers the input first via `bufferPass` (the `displace`/`glitch` reference
  pattern) and samples `texture(rt.texture, warpedUv)`. Would need a distinct
  module name (e.g. `marbleWarp`) since module names are unique in the catalog.

Knobs: warp `octaves`, `scale`, `lacunarity`, per-level `warpAmount`, and a
frame-clocked `evolve` (a third noise dimension via `ctx.uniformOf(ctx.time.now)`
— never TSL `time`). Audio: `warpAmount` / `scale` on the bass for a breathing
marble; a kick can punch an extra warp octave in.

## Why it's cheap

No render targets, no ping-pong, no state — a stateless TSL function plus the
two standard wrappers (source `texNode`, effect `bufferPass`). It declares
`chainParams` so it drops straight into any instance's FX chain (the
`displace`/`levels` pattern), and the determinism rules are satisfied by
construction (frame-clock evolve, no TSL `time`). Realistically a single
focused module + a showcase scene + its `content/test/cases.ts` entry — the
lowest-risk, highest-polish item of the batch.
