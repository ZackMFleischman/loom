# GPU field simulations — fluid, waves, cellular automata (post-v1 candidates)

**Status:** PARTIALLY SHIPPED. The `simBuffer` primitive, **`waveField`** (wave
equation) and **`automata`** (cyclic CA) shipped — `reactionDiffusion` was
refactored onto `simBuffer` to prove it. **`fluid2d` remains** the open item.
Spawned from the `reactionDiffusion` work (PR #18) — it proved the pattern.

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

### `fluid2d` — Stam stable-fluids smoke/ink (highest impact, heaviest)
Velocity field (RG) + dye (RGB) buffers. Per frame: semi-Lagrangian **advect**
→ add forces → **divergence** → ~20–40 Jacobi **pressure** iterations →
subtract gradient (project to divergence-free) → advect dye through velocity.
Inject dye + a force impulse at a point on the kick and it billows. The
canonical VJ smoke. Cost lives in the Jacobi loop — keep the grid ~256² and
expose iteration count as a param. Needs `simBuffer` to host multiple coupled
fields (velocity + dye + pressure scratch), the main reason to design the
helper around *named* buffers rather than a single RG pair.

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
`cyclic-spiral`). **`fluid2d` is the remaining prize** and the most work — the
Jacobi pressure solve, multiple coupled buffers (velocity + dye + pressure
scratch), and perf tuning at 60 fps. `simBuffer` today owns a single ping-pong
pair; fluid wants *named* coupled buffers, so the first fluid step is extending
the helper (or a `simBufferMulti`) to host them. Still no engine changes — a
source returning a `TexNode`, coloured through `pickPalette`, dye/force injected
from `ctx.input(...)`.

See also `particle-agent-systems.md` — **physarum** uses this field buffer for
its trail map, bridging the two families.
