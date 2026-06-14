# GPU field simulations — fluid, waves, cellular automata (post-v1 candidates)

**Status:** SHIPPED. The `simBuffer` primitive, **`waveField`** (wave equation),
**`automata`** (cyclic CA) and now **`fluid2d`** (Stam stable-fluids) have all
shipped — `reactionDiffusion` was refactored onto `simBuffer` to prove it.
`fluid2d` extended the helper into **`simBufferMulti`** (N named coupled fields +
an ordered pass pipeline) for its velocity/divergence/pressure/dye buffers,
leaving the single-buffer `simBuffer` API byte-for-byte unchanged. Spawned from
the `reactionDiffusion` work (PR #18) — it proved the pattern.

## The opportunity

`reactionDiffusion` added LOOM's first *simulation* source: a chemical field
stepped several iterations a frame in ping-ponged HalfFloat render targets
(`content/modules/sources/reactionDiffusion.ts`, same statefulness model as
`feedback`/`echo`). That same skeleton — **a double-buffered state field you
integrate forward each frame** — is the engine behind a whole family of
classic generative looks LOOM doesn't have yet. Building them one-off would
copy ~100 lines of buffer plumbing each time; extracting the plumbing once
makes each new sim a small module.

## Shared primitive first: `simBuffer` (SHIPPED)

Lives in `content/modules/_shared.ts` (outside the swept module folders, so
discovery ignores it — same as `bufferPass`):

```ts
simBuffer(ctx, {
  width, height,              // fixed sim grid (small; HalfFloat)
  iterations,                 // SignalLike — steps per frame
  seed:  (uv) => vec4Node,    // initial state, run on frame 0 + on reseed
  step:  (sample, texel) => vec4Node, // one integration step; `sample(offset)` taps neighbors
  reseed?: SignalLike,        // rising past 0.5 re-seeds
  wrap?: "repeat" | "clamp",  // toroidal vs reflecting boundaries
}) => { tex: TexNode-ish, read: () => Texture }
```

It owns the two RTs, the per-iteration ping-pong, seed-on-first-frame, the
reseed rising-edge, and a frame-clocked `phase` uniform — all the boilerplate
currently inlined in `reactionDiffusion`. Refactoring RD onto it (no behaviour
change) is the proof it's right. Everything below is then ~40 lines.

Determinism travels for free: frame-clock only (never TSL `time`), seeded
hashes, and a code change resets the field (NFR-5) exactly like `feedback`.

## The sims

### `fluid2d` — Stam stable-fluids smoke/ink (SHIPPED)
Velocity field (RG) + divergence (R) + pressure (R) + dye (RGB) buffers. Per
frame: semi-Lagrangian **advect** velocity → add vortex forces → **divergence**
→ N Jacobi **pressure** iterations (`pressureIters` param, default 30) →
subtract gradient (project to divergence-free) → advect dye through velocity +
fade + inject coloured puffs. Two counter-rotating orbiting jets inject dye + a
force impulse on the kick and it billows; bass eases dissipation for longer
smoke. The canonical VJ smoke. Cost lives in the Jacobi loop — grid is 256×144
and iteration count is a param. Drove the **`simBufferMulti`** helper (N *named*
coupled fields + an ordered pass pipeline with per-pass `repeat` sub-iteration
for the Jacobi loop, plus a continuous `sampleUv` for advection backtrace) —
distinct from the single-field `simBuffer`, which is untouched. Showcase scene
`smoke-signals`; colorized through `pickPalette`. Verified on real WebGPU
(NVIDIA hardware) AND the WebGL2 fallback — multi-buffer sims are exactly where
backend bugs (Y-flip, projection) hide, and both render clean.

### `waveField` — wave-equation ripple tank (SHIPPED, cheap, hypnotic)
Height `h` + previous height in one buffer. Step: `a = c²·∇²h`,
`v += a·dt·damp`, `h += v`. Drop impulses on kicks → **real interference**
and reflections (a true simulation where today's `ripples` is procedural
rings). Output: height → palette ramp, or finite-difference normal → shaded
caustics. `wrap:"clamp"` gives reflecting walls; an absorbing border ring kills
edge ringing.

### `automata` — cyclic cellular automata (SHIPPED, nearly free)
Discrete CA on the grid: Life (survive 2–3, born 3), Brian's Brain, or a
**cyclic** rule (a cell at state `s` advances if a neighbour is `(s+1)%n`) that
self-organises into rotating spiral fronts. One integration step per frame (or
sub-step on the beat for a rhythmic march); reseed a region on the kick. State
quantised into a channel; colour via the palette ramp. The cheapest entry and a
great palette-cleanser.

## Why later / scope — what's left

`simBuffer` + `waveField` + `automata` shipped as the first slice (each sim is
a dozen lines of step math on the helper; showcase scenes `ripple-pool` and
`cyclic-spiral`). **`fluid2d` then shipped** as the prize and the most work — the
Jacobi pressure solve, four coupled buffers (velocity + divergence + pressure +
dye), and perf tuning (held ~56 fps at 256×144, 30 Jacobi iters on real
WebGPU). It got the named-buffer helper it needed: `simBufferMulti` generalizes
the single ping-pong pair into N named coupled fields driven by an ordered pass
pipeline (with per-pass `repeat` for the Jacobi loop). No engine changes — a
source returning a `TexNode`, coloured through `pickPalette`, dye/force injected
from `ctx.input(...)`. The whole family is now SHIPPED.

See also `particle-agent-systems.md` — **physarum** uses this field buffer for
its trail map, bridging the two families.
