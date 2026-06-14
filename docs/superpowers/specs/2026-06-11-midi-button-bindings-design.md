# MIDI button bindings: modes + action pseudo-scene

**Date:** 2026-06-11 · **Status:** approved
**Driver:** the nanoKONTROL2's S/M/R button rows (CC 32–39 / 48–55 / 64–71, momentary
127-press / 0-release) and transport ◀◀/▶▶ (CC 43/44) should be performable controls:
radio-select an enum option, cycle/toggle a param, and step the live output through
the running tiles. Today every binding is implicitly "absolute" (CC → min..max), which
makes buttons slam params between extremes, and there is no MIDI path to stage/commit.

## Decision

Button semantics are a property of the **binding** — not the param, not a modulator.
Modulators were considered and rejected: they are agent-tier time/audio animators that
lock the param against writes; MIDI-learn is a human-only physical gesture and bindings
are durable per-scene where modulators are ephemeral per-instance. Hardware-side
programming (Kontrol Editor custom values) was rejected: config outside git, no cycle,
no scene-nav, and custom device modes were the root cause of the original "sliders
won't bind" bug.

## 1 · Data model (`packages/runtime/src/bindings.ts`)

`BindingSchema` gains:

```ts
mode:  z.enum(["absolute", "set", "cycle"]).default("absolute"),
value: z.number().optional(),   // set-mode target (real param value); refine: required iff mode === "set"
```

- Old `bindings.json` entries parse as `absolute` and behave exactly as today.
- `BindingStore` keeps a per-`(ch,cc)` last-value map. `set`/`cycle` fire **only on a
  rising edge** (prev < 0.5 ≤ now); `absolute` stays continuous. Releases never fire.
- Learn replacement: `set` bindings replace only same `(scene, path, value)` so radio
  options accumulate (S→0, M→1, R→2 on one param). Other modes replace by
  `(scene, path)` as today. `unbind` without `value` clears all bindings on the path;
  with `value` it clears one radio option.

## 2 · Routing (`main.ts` CC router)

`handleCc(e, ops)` takes three callbacks; the host owns param math (it owns manifests):

- `write(scene, path, v01)` — absolute, unchanged (`setNormalized`).
- `setValue(scene, path, value)` — `param.set(value)`; the param's clamp applies.
- `step(scene, path)` — int: +1 wrapping max→min; bool: flip; float: no-op (UI never
  offers cycle on floats; hand-edited JSON is harmless).

All three work on instance scenes and `"globals"` (a button can toggle
`inputs.kick.enabled`). Per-scene/globals persistence triggers fire as today.

### Actions pseudo-scene

Scene `"actions"` (precedent: `"globals"`), paths `live.next` / `live.prev`, always
edge-triggered. The router does not touch a manifest: it computes the next/previous
**ok-status** instance from the current live pointer (session tile order, wrapping,
skipping frozen/rejected/live-itself), stages it, and runs the existing commit pipeline
as source `"human"` — same crossfade as the Console COMMIT button. Never-go-black holds
trivially: only already-built instances are eligible. A press deliberately clobbers an
agent-staged candidate (performer gesture wins). One healthy instance → no-op.

## 3 · Console UX

- Plain float sliders: unchanged — click M, move control, bound absolute.
- Enum ints (params with `labels`, e.g. `palette.source`) and bools: clicking M opens a
  small popover: `absolute · cycle · set: <label per option>` (bools show `toggle`
  instead of `cycle`). Picking arms learn for that mode (chip pulses `···`). The
  popover lists existing bindings (`set primary ← cc32 ✕`) with per-binding unbind.
  Unlabeled ints get `absolute · cycle`.
- Stage strip gains two learn chips — `◀ prev` / `next ▶` — arming learn for the two
  action paths, next to the LIVE/STAGED controls they affect.
- Chip text: one binding → `cc37`; several → `cc×3` with hover listing all.

## 4 · Protocol & persistence

- `MidiTargetArgs` gains optional `mode` / `value`; `midi_learn` / `midi_unbind` remain
  HUMAN_ONLY (actions can change what's live — doubly so).
- `MidiBinding` snapshot schema mirrors `mode` / `value` so the Console renders modes.
- `resolveMidiTarget` accepts pseudo-instance `"actions"` alongside `"globals"`.
- `content/state/bindings.json` persists the new fields; no migration needed.

## 5 · Testing & validation

- **Unit (runtime, TDD):** rising-edge semantics (release inert, two presses = two
  steps), cycle wrap + bool flip, radio accumulation + per-value replacement,
  back-compat `load()`, action bindings routed to the action callback, ch-pinned vs
  any-channel edges.
- **Acceptance:** extend `validate-m5` via the `midiInject` mock path — radio via three
  injected CCs, cycle wrap on `palette.source` with no rebuild, release ignored,
  `live.next` switching live between two tiles with a crossfade, mode/value surviving
  reload.
- **Gates:** `pnpm typecheck`, unit tests, full `pnpm validate` before merge.

## Out of scope

- Velocity/aftertouch semantics, long-press, double-tap chords.
- Hardware-toggle buttons (Kontrol Editor "toggle" mode): rising-edge assumes
  momentary, the factory default. Documented, not engineered around.
- MIDI feedback to the controller's button LEDs (needs sysex/output — post-v1
  candidate if wanted).
