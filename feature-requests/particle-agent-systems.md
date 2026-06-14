# Particle & agent systems — flow, flocking, attractors, slime mold (post-v1 candidates)

**Status:** SHIPPED. CPU-side agent systems (drawn through `render3d` +
`InstancedMesh`, seeded + frame-clocked): **`strangeAttractor`** (scene
`attractor-cloud`), **`flock`** (boids, scene `flock-swarm`), **`flowParticles`**
(ABC-flow advection, scene `flow-field`). **`physarum` ✅ SHIPPED** the GPU route
(2026-06-14): agents in a ping-ponged position texture, additive deposit via
instanced points reading that texture, diffuse+decay in a second ping-pong —
the diffusing trail field. Scene `slime-veins`. **`particleState` +
`additiveDeposit` + `silk` ✅ SHIPPED** (2026-06-14): the reusable GPU
particle-pool primitive + the million-point "silk" payoff. Scene `silk-flow`.
Sibling family to `gpu-field-simulations.md`.

## DECISIONS SHIPPED (2026-06-14) — family 4: GPU particles "silk"
- `_shared.ts`: `particleState(ctx, {count, spawn, update, respawn, reseed, seed})`
  — pos/vel in a ping-ponged HalfFloat √count² texture (NearestFilter), seeded
  in-shader (no Math.random), frame-clocked; `load(idx)` reads a particle via
  `textureLoad(vertexIndex)`. `additiveDeposit(ctx, {particles, positionUv,
  color, exposure, persistence, ...})` — instanced `Points` additive splat into a
  HalfFloat accum buffer (+ optional trail bleed) → soft `1-exp(-d)` tone-map.
  Generalizes physarum's inline machinery incl. the WebGL2/WebGPU RT Y-flip.
- `silk` source: curl-of-fbm flow OR de Jong attractor field; bass surges force,
  kick breathes curl scale (scene `silk-flow`). Params expose count, field,
  force, curlScale, evolve, churn, persistence, exposure, glow (per-splat
  brightness), size, reseed, seed. Existing `_shared` consumers
  (reactionDiffusion/waveField/automata/physarum/fluid2d) untouched + still green.
- Fixes finishing the inherited draft: (1) the per-particle seed hash blew past
  WebGL2/ANGLE `sin` precision (uv*side*salt → 10^5), collapsing the pool onto a
  sparse grid (lum 0.13) — reworked to bounded integer-texel ids + a
  pre-`fract`-reduced hash; (2) advection step was ~0.0002/frame (particles never
  spread) and per-splat deposit ~0.02 with low persistence (density never built)
  — retuned to a proper finite-difference curl velocity, ~1px/frame step, glowing
  splat + 0.82 trail persistence. Result: dense flowing silk (lum 82).
- Gates: typecheck + `pnpm test` (513 content + 442 pkg) green; `validate:stdlib`
  88/88 WebGL2-verified non-black (silk lum 82). Real-WebGPU (float-tex additive
  blend + `textureLoad` position-tex) needs a human eyeball — `navigator.gpu`
  undefined on this host.

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

### `physarum` — slime-mold agents on a trail field ✅ SHIPPED (GPU)
Agents live in a ping-ponged HalfFloat **position texture** (rgba = posX, posY,
heading); a full-screen update quad has each agent **sense** the trail at three
points ahead (left/center/right of heading), steer toward the strongest, and
advance. The trail field is a second ping-pong: **diffuse** (3×3 box) + **decay**
each frame, then the freshly-moved agents are **deposited** additively via an
instanced `Points` pass whose `positionNode` does `textureLoad(agentTex, idx)` —
no vertex-texture-fetch guesswork, just `vertexIndex → texel`. Grows living vein
/ neuron / leaf-venation networks. Beat drives sensor splay (the colony flares
open + re-knits on the kick) and the deposit flash; bass breathes the agent
speed. Frame-clocked + deterministically seeded (in-shader hash, no
Math.random) → fixture-replay-safe. Scene `slime-veins`. NOTE: did NOT reuse
`simBuffer` — its per-pixel `step` can't read agent positions for the deposit,
so physarum owns its four passes inline (~231 lines — over the ~150 soft budget,
mostly backend-gotcha comments + per-opt JSDoc).

## Why later / scope

`particleState` + the accumulation pass is the gating refactor (like `simBuffer`
for the field family). Once it exists, **`attractor`** and **`flowParticles`**
are small and high-impact — build those first. **`flock`** is independent (CPU,
reuses `spriteSwarm`) and can come anytime. **`physarum`** wants both this
doc's particle infra and the field doc's `simBuffer`, so it lands after both.
No engine changes: instanced rendering already exists for `particleEmitter`;
these are new `geo`/`source` modules using the same `render3d`/instancing path.
