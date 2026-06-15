# Audio input monitoring (hear the input on your speakers)

**Date:** 2026-06-15
**Status:** Approved design — pending implementation plan
**Branch:** `feature/audio-input-monitor`

## Problem

When a VJ feeds an audio loopback (e.g. VB-Cable out) into LOOM as the mic
input, LOOM analyzes it for audio-reactivity but never plays it back. The mic
source connects only to the analyser node (`packages/runtime/src/inputbus/audio.ts`,
`startMic`: `src.connect(this.analyser!)`), and the analyser is never wired to
`ctx.destination`. So the operator cannot hear the music they're driving visuals
with.

We want a **monitor toggle** in the Console that routes the input to the
speakers, with a **volume control** that appears on hover.

## Goals / non-goals

- **Goal:** A human-driven Console toggle that plays the *mic* input through the
  speakers, with an adjustable monitor level.
- **Non-goal:** Monitoring the synthetic `test` signal (it is deliberately muted;
  the toggle is disabled in test mode).
- **Non-goal:** Agent/MCP control. This is a human cockpit affordance only — it
  is not added to the sidecar MCP tool surface.

## Architecture

The signal path inside `AudioBus` becomes:

```
micSource ─┬─→ analyser                      (analyzed — unchanged)
           └─→ monitorGain ─→ ctx.destination (heard — new, when gain > 0)
```

### Unit 1 — `AudioBus` monitor path (`packages/runtime/src/inputbus/audio.ts`)

State:
- `private monitorGain: GainNode | null` — created lazily in `ensureContext`,
  `gain.value = 0`, connected once to `ctx.destination` and left connected for
  the context's life.
- `monitorEnabled = false` and `monitorLevel = 0.8` (public, read by the snapshot).

Methods:
- `setMonitor(opts: { enabled?: boolean; level?: number }): void` — updates the
  fields (clamping `level` to 0..1) and sets
  `monitorGain.gain.value = monitorEnabled ? monitorLevel : 0`. Toggle and level
  are independent: you can pre-set the level while muted, and flipping the toggle
  re-applies the stored level. Lazily calls `ensureContext()` so it works before
  any source is started.

Wiring:
- `startMic`: after `src.connect(this.analyser!)`, also `src.connect(this.monitorGain!)`
  (the gain node persists across source swaps, carrying the current setting — no
  re-apply needed).
- `stop()`: the existing `sourceNodes` disconnect loop already detaches `src`
  from both targets; `monitorGain` stays alive on the context. Monitor *state*
  (`monitorEnabled`/`monitorLevel`) is preserved across a `set_audio` device
  switch, since `setMonitor` was last called independently.
- `test` mode is unaffected — its synthetic graph routes through its own muted
  gain and never touches `monitorGain`.

### Unit 2 — Engine plumbing (`packages/engine-app/src/engine-api.ts`, `debug-surface.ts`)

- `EngineDeps.audio` type gains `setMonitor`, `monitorEnabled`, `monitorLevel`.
- New request verb `set_monitor { enabled?: boolean; level?: number }` validated
  with a zod `SetMonitorArgs` schema, calling `this.deps.audio.setMonitor(...)`
  and returning the new `{ monitorEnabled, monitorLevel }`. Added to the
  `HUMAN_ONLY` set as belt-and-braces (it is also *not* registered as an MCP
  tool in the sidecar, so agents have no path to it).
- `SessionSnapshot` gains `monitorEnabled: boolean` and `monitorLevel: number`;
  the snapshot builder reads them from `this.deps.audio`.
- `debug-surface.ts` mirrors them onto `window.__loom` for validators.

### Unit 3 — Console UI (`packages/engine-app/src/ui/console/Header.tsx`)

A new `MonitorControl` component placed next to `AudioPicker`:
- A `🔊 MON` toggle button — `variant="contained"` (primary) when on, `"outlined"`
  when off. **Disabled when `s.audioMode === "test"`** (with a tooltip explaining
  monitoring applies to a mic/loopback input).
- On **hover** of the button (or its wrapper), a floating MUI `Popover`/`Popper`
  appears anchored to the button containing a vertical/horizontal volume
  `Slider` (0..1). It hides on mouse-out.
- Clicking the button calls `set_monitor { enabled: !current }`; dragging the
  slider calls `set_monitor { level }` (debounced/throttled like other live
  knobs).
- State follows the engine snapshot (`s.monitorEnabled`, `s.monitorLevel`) unless
  mid-interaction, mirroring the `AudioPicker` focus-guard pattern.
- Persistence: the chosen enabled/level persist in `localStorage`
  (`loom.monitor`) and re-apply on first connect via `set_monitor`, mirroring the
  `PanicControls` re-arm-on-connect pattern in the same file.

## Defaults & safety

- **Monitor defaults OFF** on boot to avoid a surprise blast / acoustic feedback
  if a real microphone is monitored through speakers. (VB-Cable loopback has no
  feedback risk, but off-by-default is the safe general choice.)
- **Level default 0.8** so the first enable is audible but not at unity.

## Testing

- **Runtime unit test** (`packages/runtime/test/`): construct an `AudioBus`,
  assert `monitorGain.gain.value === 0` when disabled, `=== level` when enabled,
  that `level` clamps to 0..1, and that the setting survives a `stop()` /
  `startMic()` cycle (using a stubbed/mocked `AudioContext`, matching existing
  runtime audio test conventions).
- `pnpm typecheck` and `pnpm test` stay green; `pnpm validate` unaffected
  (no MCP surface change). If `validate:m1`/`m4` assert on the snapshot shape,
  extend their fixtures for the two new fields.

## Review note

This touches `packages/runtime/` and `packages/engine-app/` — human-reviewed
engine territory (not session/content work). It ships on a branch with the unit
test, for review before merge.
