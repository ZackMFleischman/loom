# Particle & agent systems — flow, flocking, attractors, slime mold (post-v1 candidates)

**Status:** ideas, not scheduled. Sibling family to `gpu-field-simulations.md`;
spawned from the `reactionDiffusion` simulation work (PR #18).

## The opportunity

LOOM has `particleEmitter` (M8) — particles boiled off a mesh **surface**,
rendered as instanced points through `render3d`. What it doesn't have is
particles whose **motion is the simulation**: advected through a field,
steering off neighbours, or iterating a chaotic map. These are the
silk-and-smoke and swarm looks. They share an infrastructure distinct from the
field sims: **particle state lives in a texture, advanced by an update pass,
and drawn by an instanced render pass that pulls each instance's position from
that texture.**

## Shared primitive: `particleState` + additive accumulation

Two reusable pieces in `content/modules/_shared.ts`:

1. **`particleState(ctx, { count, update, spawn })`** — packs position/velocity
   into the RGBA of a `ceil(√count)²` HalfFloat texture, ping-ponged; `update`
   is a TSL step run per frame, `spawn` reseeds dead/oob particles. Mirrors the
   `simBuffer` shape (see the field-sims doc) but indexed per-particle, not
   per-pixel.
2. **An additive accumulation + tone-map pass** — splat particles into a float
   buffer with additive blending, then log/Reinhard tone-map → the filamentary
   "silk" density look. Reusable by attractors and flow alike.

Lessons already paid for by `particleEmitter` carry over: seed every RNG with a
mulberry32 (no `Math.random`), `setUsage(DynamicDrawUsage)` on per-frame
instance buffers (or fixture offline passes silently freeze), frame-clock only.

## The systems

### `flowParticles` — curl-noise advection (silky smoke streams)
Positions advected by a **divergence-free curl-noise** field (curl of an fbm
potential → no sources/sinks → streamlines that never clump). Respawn on
lifetime; render as additive points with a faded trail. Distinct from the
static `noiseField` texture — this is the *motion*. Audio scales field force /
scale / spawn rate. Reuses `particleState` + accumulation directly.

### `flock` — boids (separation / alignment / cohesion)
Legible swarm motion. Naive neighbour search is O(n²); for v1 a few-hundred-agent
**CPU** flock feeding an instanced sprite renderer (the `spriteSwarm` path) is
honest and cheap, with a GPU spatial-hash version as a later upgrade. Energy
widens cohesion, the kick scatters the flock. Ships as a GeoNode (instanced) or
a 2D overlay source.

### `attractor` — strange-attractor splatting (Lorenz / Clifford / de Jong)
Each particle iterates a chaotic map; splat millions of points into the additive
density buffer and tone-map → filamentary silk. **No neighbour interaction**, so
it's cheap per point and scales to huge counts. Morph the map constants live
(like Julia's `c`) for continuous metamorphosis. Pure win on the accumulation
infra; arguably the best wow-per-line in this list.

### `physarum` — slime-mold agents on a trail field (the crossover)
Thousands of agents (a `particleState` texture) **deposit** into a trail map,
**sense** three points ahead, and steer up the gradient; the trail field
diffuses + decays each frame. Grows living vein / neuron / leaf-venation
networks. This is the technique that uses BOTH families: agents from here, and
the diffusing trail field is exactly a `simBuffer` from
`gpu-field-simulations.md`. Beat drives sensor angle / deposit strength.

## Why later / scope

`particleState` + the accumulation pass is the gating refactor (like `simBuffer`
for the field family). Once it exists, **`attractor`** and **`flowParticles`**
are small and high-impact — build those first. **`flock`** is independent (CPU,
reuses `spriteSwarm`) and can come anytime. **`physarum`** wants both this
doc's particle infra and the field doc's `simBuffer`, so it lands after both.
No engine changes: instanced rendering already exists for `particleEmitter`;
these are new `geo`/`source` modules using the same `render3d`/instancing path.
