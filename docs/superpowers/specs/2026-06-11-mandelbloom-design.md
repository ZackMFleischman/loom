# mandelbloom — palette-showcase scene design

**Date:** 2026-06-11
**Status:** approved-pending-spec-review
**Author:** agent session (palette showcase)

## Goal

A new LOOM scene, **`mandelbloom`**, that showcases the M6 global color palette
system (`ctx.palette.color(i)` / `ctx.palette.ramp(t)` / `ctx.palette.own([...])`
+ the live `palette.source` switch) by rendering a Mandelbrot set whose **exterior
filaments** are colored through the palette *ramp* and whose **black interior**
hosts a separate living visual ("garden") tinted with discrete palette *stops*.
Flipping `palette.source` (own / primary / secondary) live-retints filaments,
interior, and boundary rim together — the headline showcase moment.

Along the way: one new reusable module (`paletteMap`) and one existing module
(`mandelbrot`) made abstract enough to self-dive.

## Why this showcases palettes well

The Mandelbrot module already emits grayscale where **interior (in-set) pixels are
exactly black** (`escaped == 0`) and exterior pixels carry a smooth brightness
`b ∈ (0,1]`. That gives a free, crisp mask (`inSet = b ≈ 0`) to color the two
regions with completely different palette surfaces:

- Exterior → `ramp(b)`: the full 5-stop gradient flows along the escape bands.
- Interior → discrete `color(2)/color(3)` core + `color(4)` accent bloom.
- Boundary → a bright `color(4)` rim guaranteeing interior/exterior contrast in
  any palette.

All three consume the **same** global palette, so one `set_param` on
`palette.source` recolors the whole frame coherently.

## Components

### Extend module: `mandelbrot` (source) — `content/modules/sources/mandelbrot.ts`

Rather than a second module, the dive mechanics fold into the **existing**
`mandelbrot` module, making it abstract enough to be either a raw renderer or a
self-diving fractal. The escape-time core is unchanged; new **optional** opts add
center-glide and an internal ping-pong zoom integrator. Returns the grayscale
fractal `TexNode`.

**Opts (all `SignalLike` unless noted; back-compatible — existing callers unaffected):**
- `cx`, `cy` — view-center target (existing).
- `scale` — static half-extent, used when `dive` is absent (existing behavior).
- `iterations` — escape-time cap (existing).
- `glide?` — lag seconds for `cx`/`cy` (default `0` = snap; set >0 to glide between targets).
- `dive?` — when provided, **overrides `scale`**: zoom speed in octaves/sec,
  ping-ponging between `0` and `depth`. Absent ⇒ static `scale` (unchanged).
- `depth?` — max zoom depth in octaves for the ping-pong (default ~14; f32 GPU limit ~18).
- `baseScale?` — half-extent at the top of the dive (default 1.25).

**Internals (only active when `dive` is provided):** identical math to the current
`mandelbrot.scene.ts` (optionally lag centers by `glide`, integrate `zoomAcc`, fold
to a `0..depth` triangle wave, `scale = baseScale * 2^-octaves`). Stateful signals
are created inside the module via `ctx` (lag, integrator) — legal; modules receive
`BuildCtx`.

**Why fold in (not a new module):** the dive is scene-agnostic and currently
duplicated into exactly one scene; mandelbloom needs the same behavior. A single
abstract `mandelbrot` (static *or* diving) keeps the stdlib surface small and the
abstraction in one place. Default behavior (no `dive`) is byte-identical, so no
existing consumer changes.

### New module: `paletteMap` (effect) — `content/modules/effects/paletteMap.ts`

Maps an input's luminance through the **global** palette ramp — the palette-native
sibling of `colorize` (which only knows the cosine `PALETTES` presets, not the M6
global palettes).

**Opts:**
- `input: TexNode` — any source.
- `shift?: SignalLike` — scroll offset added to the lookup coordinate (wraps).
- `gain?: SignalLike` — luminance multiplier before lookup (default 1).

**Behavior:** `lum = dot(input.rgb, vec3(0.299,0.587,0.114))`; returns
`ctx.palette.ramp(fract(lum * gain + shift))`, preserving `input.passes`. Because
it calls `ctx.palette.ramp`, **any scene using it auto-declares `palette.source`**
and is live-retintable for free.

### New scene: `mandelbloom` — `content/scenes/mandelbloom.scene.ts`

Composes everything. Data flow:

1. **Base** — `mandelbrot` (dive mode: `dive`+`depth`+`glide`) with a *shallow,
   slow* default dive so the set body
   (chunky black interior) stays on screen — the garden needs interior to live in.
   (Deep dives are available via params but shrink the interior off-screen; a
   documented tradeoff.)
2. **Brightness / mask** — `b = fractal.color.r`; `inSet = 1 - smoothstep(0, rim+ε, b)`.
3. **Exterior** — `paletteMap({ input: fractal, shift: scrollPhase })`: filaments
   flow through the 5-stop ramp.
4. **Interior garden** — domain-warped `noise` + drifting `blobs`, composited into
   a *darkened* base (`color(0)` dimmed) with garden elements tinted
   `mix(color(2), color(3), …)` and an `color(4)` accent bloom that swells on the
   kick. Dark base + glowing life reads distinct from the structured exterior.
5. **Rim** — at the mask transition, paint `color(4)` (accent) — a bright outline
   that separates regions in every palette (the explicit contrast guarantee).
6. **Composite** — `mix(exterior, interiorGarden, inSet)` then add the rim.
7. **Effects chain** — `feedback` (modest trails that smear the dive) →
   kick-driven `glitch` burst (low default) → `levels` (final grade).
8. **Palette defaults** — `own([...5 authored stops])` so it boots on its own
   look; `palette.source` defaults to `own`. Flipping to primary/secondary
   retints the whole frame.

**Audio:** `ctx.audio.onset({ band: "bass" })` → envelope drives interior accent
bloom + a small zoom punch + the glitch burst amount.

**Params (the mixing board):** `dive`, `depth`, `iter`, `scroll` (ramp scroll),
`warp` (interior domain-warp depth), `garden` (interior element intensity),
`bloom` (kick accent strength), `rim` (boundary width), `trail` (feedback),
`glitch` (kick burst).

### Refactor: `mandelbrot.scene.ts`

Replace its inline dive math (POINTS glide + zoom integrator) with a single
`mandelbrot(ctx, { cx, cy, glide: 1.2, dive, depth, iterations })` call now that
the module owns that logic. **Param surface stays byte-for-byte identical**
(`point`, `dive`, `depth`, `iter`, `palette`, `drift`, `cycle`, `bands`) so nothing
downstream changes; the POINTS table stays in the scene (scene-specific), feeding
`cx`/`cy` into the module. This proves the extraction and removes duplication.

## Data flow diagram

```
                         ┌── exterior: paletteMap(ramp) ──┐
mandelbrot (dive mode) ──┤                                ├─ mix(by inSet) ─┐
   │  b = color.r        └── interior: noise+blobs+stops ─┘                 │
   └─ inSet = 1-smoothstep(0, rim, b) ──────────────────────────────────── + rim(accent)
                                                                             │
                                          feedback → glitch(kick) → levels ──┴─→ output
```

## Error handling / safety (never-go-black)

- No `packages/` changes — pure `content/` (modules + scenes). Agent territory.
- New modules add no render-path risk beyond their own TSL nodes; `paletteMap`'s
  per-frame work is the existing palette updater (string-key early-out).
- A bad edit is contained by the standard three layers (compile withheld / build
  throw keeps previous / render throw freezes instance).
- Build the scene in a **sandbox** (`create_instance`) and `stage` it — do not
  hot-swap `live.scene.ts` mid-session. Hand over to the human to COMMIT.

## Testing / acceptance

- `pnpm typecheck` (regenerates `content/CATALOG.md` — commit it) and `pnpm test`
  stay green.
- Modules are pure content; no new unit tests required (the kernel is unchanged).
  Existing `validate:m6` already covers the palette plumbing; this scene is an
  additional consumer, not a contract change.
- **Eyes-on acceptance** (via MCP, the LOOM way):
  1. `create_instance { scene: "mandelbloom" }` → `screenshot`: set body black-ish
     with a living interior, colored filaments outside, bright rim between.
  2. `get_manifest` → `palette.source` present, default `2` (own).
  3. `set_param palette.source = 0/1` → `screenshot`: whole frame retints, **no
     rebuild** (`builds` stays 1).
  4. Edit a `globals` stop (`palette.own`/`primary`) → consumer retints.
  5. With `?audio=test`: kick → interior accent bloom visible.
  6. Re-run the existing mandelbrot scene (sandbox) → looks identical to before
     the refactor.
- Re-run prior gates: `pnpm validate:m6` (and the m0–m5/modulators suite if the
  refactor touched anything shared — it doesn't, but verify).

## Out of scope (YAGNI)

- No kernel/`packages` changes.
- No new global palette presets or palette UI changes.
- No kaleidoscope on the fractal (muddies it); effects limited to feedback /
  glitch / levels.
- Deep-dive interior-preservation heuristics (auto-recentering on set body) — the
  default is just shallow; documented.

## Files

- Modify: `content/modules/sources/mandelbrot.ts` (optional glide + dive mode)
- Create: `content/modules/effects/paletteMap.ts`
- Create: `content/scenes/mandelbloom.scene.ts`
- Modify: `content/scenes/mandelbrot.scene.ts` (consume the diving `mandelbrot`)
- Regenerate: `content/CATALOG.md` (via `pnpm typecheck`)
