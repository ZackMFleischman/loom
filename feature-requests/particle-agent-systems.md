# Particle & agent systems — flow, flocking, attractors, slime mold (post-v1 candidates)

**Status:** PARTIALLY SHIPPED. **`strangeAttractor`** shipped (geo module,
scene `attractor-cloud`) — but via a simpler route than this doc's
`particleState`: the trajectory is integrated CPU-side into a vertex buffer and
drawn through the existing `pointCloud` + `render3d` path (no GPU particle-state
texture, no accumulation buffer). **`flowParticles`, `flock`, `physarum`** —
and the `particleState`/accumulation primitive they'd share — remain open.
Sibling family to `gpu-field-simulations.md`.

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

### `attractor` — strange-attractor point cloud ✅ SHIPPED (as `strangeAttractor`)
Shipped the geometry-first route: the chaotic ODE (Lorenz/Aizawa/Thomas/
Halvorsen) is integrated **CPU-side** into a vertex buffer (deterministic from a
fixed start), then drawn as glowing points through the existing `pointCloud` +
`render3d` + `orbitCam` path — no GPU particle-state texture, no accumulation
pass. The camera orbit reveals the 3D structure; spin/size/glow ride live.
Trade-off vs the original sketch: the constants are **baked at build** (changing
the system rebuilds), where a `particleState` version could morph them live and
do the additive-density "silk" look. A future `attractorField` could add that
once `particleState` exists.

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
