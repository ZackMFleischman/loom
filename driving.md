# Driving LOOM — VJ session lessons

Hard-won notes from live-driving the rig with the `loom` MCP tools. Read alongside
the `loom-driving` / `library-use` skills.

## The golden rule: verify the LIVE output, not the sandbox

- **A sandbox preview is NOT proof the look is good on the live canvas.** Scenes
  render differently once live — different resolution (output is 1080p, sandbox
  previews are 640×360), so bloom/feedback spread more and bright cores **clip to
  white** at full res. A look that's vivid in its tile can be washed out, blown
  out, or dark on the wall.
- **After every `commit`, `screenshot { instance: "live" }`** and look. Then
  re-check periodically during a long look.
- **A crossfade + immediate screenshot catches the OUTGOING scene mid-fade.**
  Re-shoot once after the crossfade finishes to see what actually settled.
- **Two-shot to confirm motion.** Take two live screenshots a moment apart — if
  the frame is identical, the scene is frozen/converged. If it changed, it's alive.

## Params clamp silently — always read the manifest

- `set_params` clamps every value to the param's real range and **returns the
  clamped value** — read the result, don't assume your number landed. We repeatedly
  set "0.7" expecting a 0..1 knob and got the param's min/max instead
  (e.g. `stripes.freq` floored at 2, `sense.reach` floored at 3, `color.spread`
  collapsed to 1 — all of which killed the look).
- `get_manifest` first when a scene is new to you. Default values are usually the
  scene author's intended good look — restore toward them when a knob looks wrong.

## Modulators: range + period gotchas

- `lo`/`hi` must sit **inside the param's declared range** or the call errors
  (e.g. `shape.morph` is ±0.4, not 0..1). Check the manifest range first.
- Clocked types (`sine`, `triangle`, `ramp`, `square`, `cycle`) and **`drift`**
  all need exactly one of `periodSeconds | periodBeats`.
- `cycle` on a **float** param needs an explicit `values: [...]` list (ints get
  lo..hi steps for free).
- Modulators are the cheapest way to "modify it while live" — attach a slow LFO
  (morph/zoom/rotate) and the scene keeps evolving on-air between explicit tweaks.

## Effects can crush or blow out a look

- An `hsv` step with default channels crushed `coral-bloom` to near-black on output
  (looked fine in sandbox). Be cautious adding grading effects with default values.
- `bloom` + a long `trail`/`feedback` at 1080p **builds to white** over time,
  especially on near-white palette cores (the "primary" palette core is ~`#f8f6ff`).
  Lower `fx.glow.mix`/intensity, shorten the trail, or pick a warmer palette.
- `feedback` smears distinct elements (e.g. lava blobs) into pale mush — drop it
  if you want crisp structure.

## Scene picker: know what holds the floor when the room is quiet

With the mic quiet (no kick energy), whole categories fall flat:

- **Audio-dependent → dark/flat when quiet:** `geo-rave`, `prism-array`,
  `ripple-pool` (waits for kicks to splash). The 3D rave scenes also go black when
  their shapes drift off-camera.
- **Sparse-by-nature → read dark:** `slime-veins` (thin veins on black, and an
  agent-count change *rebuilds/reseeds* the sim), `coral-bloom`.
- **Converges then FREEZES:** `cyclic-spiral` (cyclic CA settles into a static
  attractor — its color-cycling stops). Not for sustained live; no `instance.frozen`
  event fires because it isn't crashing, it's just done evolving.
- **Reliable full-frame, self-animating winners:** `lava`, `silk-flow`, `biolume`,
  `marble-warp`, `noise-flow`, `plasma-wall`, `neon-bloom`, `star-anise`, `julia`,
  and the broth of `pho-nebula`. These don't need audio to stay bright and moving.

`pho-nebula` is a literal neon "PHỞ" noodle-soup scene — the badge text persists
even at `badge.opacity 0`; strip badge + garnish for the clean swirling-broth abstract.

## Fast workflow: bench + batch

- **Keep a bench of pre-built, pre-verified instances** so cuts are instant
  (no build latency). `create_instance` ahead of time, tune, screenshot-verify.
- **Cut with quick crossfades** (`commit { durationFrames: 30 }`).
- **One `batch` should do live-work AND bench-prep together:** e.g. cut to a ready
  tile + tune a not-ready one + screenshot — one round-trip.
- **If the live one breaks, cut to a known-good bench item AND repair the broken
  one off-air in the SAME batch.** The audience never sees the broken one resolve.
- Refill the bench as you consume it; destroy consumed/off-live tiles to free tiles
  (the LIVE tile is protected — destroy fails until the crossfade fully lands).

## Pacing & variety

- For variety, pull **fresh, unused** scenes each cycle rather than recycling the
  same handful; let modulators carry continuous motion within each ~30s window.
- The self-pace wake timer **floors at 60s**, so exact 30s autonomous cadence isn't
  possible solo — either run ~60s windows or have the human nudge the cuts.
