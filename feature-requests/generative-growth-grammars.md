# Generative growth & grammars — differential growth, L-systems (post-v1 candidates)

**Status:** ideas, not scheduled. Spawned from the `reactionDiffusion` work
(PR #18) — the *vector* cousins of its organic growth.

## The opportunity

Reaction-diffusion grows organic structure in a **raster** field. The same
appeal — watching form emerge and evolve — has a whole **vector/grammar**
lineage LOOM has none of: rules that rewrite and a turtle that draws, or points
that repel and split into meandering lines. These produce coral, coastlines,
plants, snowflakes and Penrose tilings — line art that *grows on screen*,
which raster sims can't do crisply.

## Shared primitive: line/ribbon geometry + a growth clock

Both techniques below are **CPU procedural geometry advanced over time**, and
both need the same two things LOOM lacks:

1. **A thin-line / ribbon renderer.** `tube` draws fat cylinders; these want
   anti-aliased *strokes*. Either a 2D premultiplied-stroke source (composites
   like `noodles`/`neon`, bloom-friendly) or a `lineRibbon` GeoNode (instanced
   segment quads or expanded strips) feeding `render3d`. Pick one and both
   techniques share it.
2. **A growth clock** — frame-clocked accumulation (`ctx.uniformOf(ctx.time.now)`
   or an integrated rate, never TSL `time`) that advances the structure; the
   geometry is **stateful** (persists frame to frame) so it resets on rebuild
   like any sim, and is seeded (mulberry32) for fixture determinism. The
   per-frame rebuild of a growing vertex buffer needs `DynamicDrawUsage` (the
   `particleEmitter` lesson).

## The techniques

### `growth` — differential growth (coral / coastline meander)
A polyline where every node **repels** neighbours within a radius, **attracts**
along the chain (spring to its two neighbours), and a new node is **inserted**
wherever an edge stretches past a threshold — so the line lengthens and crumples
into space-filling organic meanders. Optional attraction toward a silhouette /
field grows it *into* a shape (a logo, a `text` mask). Audio: insertion rate and
repulsion radius on the energy. The literal vector sibling of reaction-diffusion.

### `lsystem` — L-system botanicals (plants, snowflakes, tilings)
An axiom + production rules rewritten `k` generations, interpreted by a turtle
(`F` draw, `+`/`-` turn, `[`/`]` push/pop) into segments. Animate either by
drawing a growing **fraction** of the path each frame (a plant unfurling) or by
advancing a generation **on the beat** (a snowflake crystallising step by step).
A small rule library (Koch, fractal plant, Penrose, dragon) selectable like the
palette presets. Branching depth / angle exposed as params.

## Why later / scope

The renderer (#1 above) is the real prerequisite and a genuine engine-adjacent
addition — worth its own small design pass on whether to go 2D-stroke or
`lineRibbon` GeoNode (2D is cheaper and composites with the existing chain;
3D opens orbit-cam framing). Once it exists, `lsystem` is mostly bookkeeping
(rewrite + turtle) and `growth` is a tidy O(n) relaxation per frame with a
spatial grid for the neighbour query. Both are `content/`-only modules + a
showcase scene; no kernel changes beyond the shared stroke renderer.
