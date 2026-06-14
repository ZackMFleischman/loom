# Particle & agent systems — flow, flocking, attractors, slime mold (post-v1 candidates)

**Status:** MOSTLY SHIPPED — via a simpler route than this doc's GPU
`particleState`: agents simulated **CPU-side** each frame, drawn through the
existing `render3d` + `InstancedMesh` path (seeded + frame-clocked, no GPU
particle-state texture, no accumulation buffer). Shipped: **`strangeAttractor`**
(scene `attractor-cloud`), **`flock`** (boids, scene `flock-swarm`),
**`flowParticles`** (ABC-flow advection, scene `flow-field`). **`physarum`**
(agents writing a diffusing trail field — genuinely wants the GPU route) remains
open, as does a real `particleState`/additive-accumulation primitive for the
million-point "silk" looks. Sibling family to `gpu-field-simulations.md`.

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

### `flowParticles` — flow-field advection ✅ SHIPPED (silky streams)
Shipped CPU-side: positions advected through an **ABC (Arnold–Beltrami–
Childress) flow** — a closed-form divergence-free field — so streamlines never
clump; respawn on lifetime, drawn as glowing instanced octahedra via
`render3d`. Bass drives flow speed (scene `flow-field`). A future GPU
`particleState` version could swap ABC for true curl-of-fbm noise and add the
additive-trail "silk" pass for huge counts.

### `flock` — boids ✅ SHIPPED
Shipped CPU-side: separation / alignment / cohesion over a ~240-agent flock
(O(n²) neighbour search), drawn as oriented cones (each points along its
heading) via `render3d`. The three weights ride live as signals; bass gathers
the flock, kick flares the bloom (scene `flock-swarm`). A GPU spatial-hash
upgrade for larger counts remains a later option.

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
