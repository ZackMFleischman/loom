# Console performance & stability

Status: requested (2026-06-13) · Owner: unassigned

## Summary

The Console (`/console.html`, the human cockpit served from `packages/engine-app`)
is janky and occasionally crashes. Four symptoms reported from a live session:
an "Aw, snap" **STATUS_BREAKPOINT** renderer crash; not all instance previews
loading; dropdown/popover options appearing **seconds** after the click; and
generally **very low FPS** in the cockpit itself. None of this touches the
*Output* window (the audience never sees it) — it's the React app that drives the
tiles, param panels, and pickers that's struggling.

This request is to **debug methodically, find the root cause(s), fix them, and
make the Console robust under a busy session** (many tiles, heavy scenes, popovers
open). A prior investigation already pinned the dominant cause and *deliberately
deferred the fix* to avoid colliding with concurrent PRs (see "What's already
known"); this picks that up and carries it through. Secondary goal: give the human
**in-UI ways to see and diagnose perf problems** — building on the meters that
already exist and feeding naturally into [[app-instrumentation]].

## Why it's slow today (the re-render storm)

The Console is a React app (`src/ui/console/main.tsx` → `ConsoleApp`) wired to the
engine over `BroadcastChannel("loom")` through `EngineLink`
(`src/ui/engine-link.ts`). Three independent broadcast streams arrive on a worker
clock from `src/console-channel.ts`:

- **state** every `STATE_MS = 100` ms (~10 Hz) — session + manifests
  (`console-channel.ts:5`, `:71`).
- **thumbs** every `THUMBS_MS = 150` ms (~6.6 Hz) — per-instance JPEG data-URLs
  (`console-channel.ts:6`, `:77`).
- **preview** every `PREVIEW_MS = 120` ms (~8 Hz) — only while a preview overlay
  is open (`console-channel.ts:7`, `:95`).

The dominant cost is the **state** stream. On every state message `EngineLink`
builds a *brand-new* snapshot object (`engine-link.ts:205-213`) and calls
`emit()`, which notifies the `useEngineState()` subscribers. Because the snapshot
identity changes every tick, `ConsoleApp` re-renders ~10×/s, and with it **every
descendant**: `Header`, `StageStrip`, `TileGrid`, every `Tile`, and `ParamPanel`
(`ConsoleApp.tsx:124-157`). Nothing is memoized — `Tile` is a plain function
component (`Tile.tsx:49`), `TileGrid` maps the full instance list each render
(`TileGrid.tsx:90`), and there's no `React.memo` anywhere in the tree (grep:
zero matches). So 10 times a second the Console rebuilds its entire DOM diff
regardless of what actually changed, while MUI's `sx`-prop styling re-evaluates
per element. This is the documented "dominant Console CPU cost" (DECISIONS.md,
"FPS counters", 2026-06-13).

That single fact explains three of the four symptoms:

- **Very low FPS** — the React paint loop is saturated by the 10 Hz full-tree
  reconcile. The Console already *measures* this: `#uifps` in the Header
  (`Header.tsx:32`, `:103`, via `useRenderFps`/`FrameRateCounter` in
  `src/ui/fps-meter.ts`) is exactly the meter that drops here.
- **Dropdown/popover options super-delayed** — MUI `Popover`/`NativeSelect` mount
  their (sometimes heavy) children *while* the 10 Hz re-render storm competes for
  the main thread. The scene picker (`NewInstanceTile.tsx:185`), the effect picker
  (`FxChain.tsx:364`), and the ∿ modulation popover (`ModPopover.tsx:132`) all
  open into that contention. The open gesture and the mount get queued behind
  reconcile work, so the list appears late. DECISIONS.md reaches the same
  conclusion: "a symptom of the re-render cost above, not an independent bug."
- **Not all previews loading** — see the next section; partly the same starvation,
  partly the thumbnail pipeline's own back-pressure.

## Why previews don't all load

Thumbnails are produced by `EngineApi.thumbnails()` (`engine-api.ts:953`): it loops
**every instance** in the session and, for each non-live one, does a
`readRenderTargetPixelsAsync` GPU readback + a 2D-canvas resize + a JPEG
`toDataURL` (`engine-api.ts:961-964`, `readback.ts`). The live tile reads a cheaper
pre-mirrored 2D canvas (`engine-api.ts:963`, `liveMirror`). This whole loop runs
on the engine side behind a `thumbsBusy` guard (`console-channel.ts:77-90`): if one
pass takes longer than the 150 ms interval, the next tick is **dropped**, not
queued. So as instance count and scene cost rise, the per-pass time grows linearly
and the effective thumbnail rate collapses — some tiles refresh slowly or, on a
slow pass that partially `catch`-skips (`engine-api.ts:965`), don't update that
round at all. There is **no cap on how many instances get read back per pass** and
no prioritization (visible vs. offscreen tiles all cost the same).

On the receiving side, every `thumbs` message is spread into one map and
re-emitted to *all* thumb listeners (`engine-link.ts:215-219`,
`subscribeThumbs`). `useThumb` is correctly isolated as its own external store
(`hooks.ts:21`), so a thumb tick doesn't trigger the full state re-render — but it
*does* wake every mounted `Tile`'s `useThumb` subscriber at once, and each Tile's
`<img src={dataUrl}>` swap decodes a fresh ~tens-of-KB JPEG (`Tile.tsx:115-120`).
With many tiles that's a burst of image decodes 6.6×/s.

## Why it can crash (STATUS_BREAKPOINT)

`STATUS_BREAKPOINT` ("Aw, snap") is a Chrome **renderer-process** abort, most
often a `RESULT_CODE_HUNG_RENDERER` follow-on or an out-of-memory / GPU-process
fault — not a JS exception (those wouldn't crash the tab). The prior investigation
could not reproduce it headlessly (no WebGPU adapter in headless Chromium) and
flagged it as "most likely GPU/driver-side under many simultaneous live preview
canvases" (DECISIONS.md). Grounded in the code, the credible suspects are:

1. **Retained data-URL growth (memory).** Two `localStorage`-backed caches hold
   JPEG/PNG data-URLs forever: `scene-thumbs.ts` (`loom.scenethumbs`, one per
   scene, persisted) and the in-memory `thumbsMap` (one per instance). `scene-thumbs`
   has *no eviction* — every scene ever previewed keeps its latest full data-URL in
   a JSON blob that's re-`JSON.stringify`'d every 3 s (`scene-thumbs.ts:26-34`).
   localStorage has a ~5 MB quota; a few dozen 640×360 JPEGs can approach it
   (the writes are wrapped in try/catch so they fail *silently*,
   `scene-thumbs.ts:31-33`, but the in-memory blob keeps growing and the 3 s
   re-stringify keeps getting more expensive). This is a slow leak, not an instant
   crash, but it's the kind of unbounded retention that precedes an OOM abort in a
   long session.
2. **Off-thread canvas churn.** Each thumbnail/preview readback creates **two**
   throwaway `<canvas>` elements via `document.createElement("canvas")` and a 2D
   context every pass (`readback.ts:20`, `:27`). At up to ~6.6 Hz × N instances
   that's a lot of short-lived canvas/context allocation pressure on the GC; under
   a driver with a low canvas/context ceiling this is a plausible contributor.
3. **Single shared WebGPU renderer is fine; the embedded engine is the risk.**
   The Console can boot a *second* engine in a hidden iframe if no Output window
   says hello (`ConsoleApp.tsx:88-95`, `:167-185`, `?embedded=1`). That iframe runs
   a full `WebGPURenderer` (`main.ts:66`). If the standing-down handshake
   (`console-channel.ts:36-55`) ever races — two engines briefly both rendering on
   the same origin — you get two WebGPU devices competing, which is exactly the
   "many simultaneous live preview canvases" GPU-pressure scenario. Worth ruling in
   or out explicitly.
4. **Hung-renderer escalation.** A sufficiently long main-thread stall (the 10 Hz
   storm + a heavy popover mount + an image-decode burst landing in one frame) can
   trip Chrome's unresponsive-renderer watchdog. STATUS_BREAKPOINT is one of the
   abort codes that path produces.

The honest position: **(1) is verifiable from code today and should be fixed
regardless; (3) and (4) are reproduction targets, not yet confirmed.** The crash
is the one symptom we must *reproduce* before claiming a fix (see Phase 0).

## What's already known (don't re-litigate)

The 2026-06-13 "FPS counters" work in DECISIONS.md already:

- **Built the three meters** this request's secondary goal would otherwise add:
  Console UI paint rate (`#uifps`), Output engine fps (`#fps`, relabeled "out"),
  and per-tile fps (`.tilefps`, via `tileFps()` in `fps-meter.ts:51`) plus the
  existing `.framems` per-tile cost (`Tile.tsx:250-263`). So a chunk of the
  diagnostics surface exists — this request *extends* it, doesn't invent it.
- **Pinned the re-render storm as the dominant cost** and named the safe fix
  (memoize tiles, split the snapshot into narrower selectors) but **deferred it**
  because sibling PRs were concurrently editing Header + FxChain.
- **Declared the thumbs store already well-isolated** (`useThumb`), so leave its
  *wiring* alone — the work is in the producer (cap/prioritize) not the React side.

This request's job is to **execute the deferred fix** and chase the crash, now that
the concurrent PRs have landed.

## Concepts

- **Selector stores.** Instead of one monolithic `EngineSnapshot` that changes
  identity every tick, expose narrow external stores so a component re-renders only
  when *its* slice changes — the same pattern `useThumb` already demonstrates
  (`hooks.ts:21`). A `Tile` should wake on its own instance's fields, not on every
  state broadcast.
- **Render budget / back-pressure.** The thumbnail producer should bound work per
  pass (cap instances read back, prioritize visible/selected tiles) and the
  consumer should bound decode bursts — degrade gracefully instead of stalling.
- **A diagnostics overlay.** A single keyboard-toggled panel that surfaces the
  meters that already exist plus a few new ones (re-render count, memory, thumb
  pass time), so the human can *see* a perf problem instead of feeling it.

## Requirements

### Functional

- **FR-1** The Console must not re-render its full tree on every 10 Hz state
  broadcast. A `Tile` re-renders only when its own instance's relevant fields
  (status, frameMs, live/staged/selected/solo, scene, pinned) change; `Header`,
  `StageStrip`, and `ParamPanel` likewise re-render only on the slices they read.
- **FR-2** The thumbnail producer (`EngineApi.thumbnails()`) bounds work per pass:
  a cap on instances read back per tick and prioritization of visible/selected
  tiles over offscreen ones, so total thumb latency degrades gracefully (the
  newest/most-relevant tiles stay fresh) rather than collapsing uniformly.
- **FR-3** The Console must remain responsive (UI fps and popover-open latency
  within target, see NFR-1/NFR-2) with a realistic busy session — **≥ 8 instances**
  including heavy scenes — popovers opening promptly.
- **FR-4** Bounded memory: the `loom.scenethumbs` cache and any in-memory data-URL
  retention are capped (LRU eviction by scene, or a hard entry/byte budget), so a
  long session can't grow them without bound (`scene-thumbs.ts`).
- **FR-5** Reproduce the STATUS_BREAKPOINT crash in a controlled harness, identify
  the mechanism, and fix it so a soak session (see NFR-3) does not crash. If the
  crash proves GPU/driver-specific and unreproducible, document the residual risk
  and the mitigation (e.g. the canvas/renderer-count guard from Phase 2) rather
  than silently closing it.
- **FR-6** A toggleable **in-UI perf-diagnostics overlay** (e.g. a Header button /
  hotkey, consistent with the existing `i`/`p` hotkeys, `ConsoleApp.tsx:99-113`)
  that surfaces, at minimum: Console UI fps (exists), Output fps (exists), per-tile
  fps + frameMs (exist), the costliest instance's `slowSignals`
  (`InstanceInfo.slowSignals`, already in the snapshot — `engine-link.ts`/protocol
  `:524`), thumbnail pass time, and a coarse memory readout
  (`performance.memory.usedJSHeapSize` where available). Read-only; never disturbs
  the live path.

### Non-functional

- **NFR-1** Target Console UI paint rate ≥ 50 fps (`#uifps`) on the reference
  machine during a busy session; the meter that proves it already exists.
- **NFR-2** Popover open-to-options-visible latency under ~100 ms at p95 during a
  busy session.
- **NFR-3** A soak session — the roadmap's "90-minute soak test … memory/VRAM
  stability, HMR churn" (`docs/roadmap.md:109`) — with the Console open, tiles
  churning, and popovers exercised, ends with no crash and bounded heap growth.
- **NFR-4** No change to the never-go-black contract or the render-loop frame
  ordering (`render-service.ts` class doc). All perf work is in the Console React
  app and the *off-loop* thumbnail/preview producers; the in-frame path
  (`tick()`, `render-service.ts:145`) is not touched.
- **NFR-5** No new heavyweight dependency for diagnostics — reuse the existing
  `FrameRateCounter`/`tileFps` primitives and the snapshot fields already on the
  wire.

## Surfaces

### Console (React)

- `src/ui/hooks.ts` — new narrow selector hooks (e.g. `useInstance(id)`,
  `useSessionMeta()`, `useStagePointers()`) alongside the existing
  `useEngineState`/`useThumb`/`usePreviewFrame`.
- `src/ui/engine-link.ts` — the store side: keep a stable snapshot where unchanged
  slices keep their identity, or expose per-slice `subscribe`/`getSnapshot` pairs.
- `src/ui/console/Tile.tsx` — wrapped in `React.memo` (or switched to a selector
  hook) so it re-renders on its own data only.
- `src/ui/console/Header.tsx` — the diagnostics-overlay toggle lives here next to
  the existing `#uifps`/`#fps` readouts.
- New `src/ui/console/PerfOverlay.tsx` — the diagnostics panel (FR-6).
- `src/ui/scene-thumbs.ts` — eviction (FR-4).

### Engine (off-loop only)

- `src/engine-api.ts` `thumbnails()` — the per-pass cap + prioritization (FR-2).
  The Console can pass a "which tiles are visible/selected" hint up the existing
  request channel, or the engine can prioritize the live + staged + most-recently
  touched instances.
- `src/console-channel.ts` — optionally expose thumb-pass timing in the broadcast
  so the overlay can show it (FR-6); no cadence change.

## Implementation plan

### Phase 0 — reproduce & measure (do this first)

1. Stand up a **busy-session harness**: a script (extend the `validate:m3` Console
   path, which already drives a real Console page) that spawns 8–12 instances
   across heavy scenes, opens/closes the pickers in a loop, and leaves it running.
2. Capture a baseline: `#uifps`, popover-open latency, thumb pass time, heap size
   over time, tab count of live WebGL/WebGPU contexts.
3. Attempt to reproduce STATUS_BREAKPOINT on the reference (WebGPU-capable)
   machine — headless can't (no adapter), so this is a real-browser repro. Record
   what it takes to trip it (instance count? preview overlay open? embedded engine
   racing?). **No fix lands before there's a measurement to move.**

### Phase 1 — kill the re-render storm (FR-1, the big win)

1. Make `Tile` a memoized component keyed on the fields it reads
   (`Tile.tsx`), and/or introduce a `useInstance(id)` selector store so a tile
   subscribes to its own instance slice (mirror `useThumb`, `hooks.ts:21`).
2. Split `EngineSnapshot` so unchanged slices keep identity across ticks
   (`engine-link.ts:205-213`): session-meta (bpm/fps/frame), stage pointers
   (live/staged), the instance list, and manifests as separate stores. Components
   read only what they use (`ConsoleApp.tsx`, `Header.tsx`, `ParamPanel.tsx`).
3. Re-measure `#uifps` against the Phase 0 baseline — this should be the dominant
   improvement and should also fix the popover-open delay (FR-2 confirmation).

### Phase 2 — thumbnail back-pressure + memory (FR-2, FR-4, crash mitigation)

1. Cap instances read back per `thumbnails()` pass and prioritize live/staged/
   selected/visible (`engine-api.ts:953`); round-robin the rest so every tile still
   eventually refreshes.
2. Reuse a single offscreen canvas in `readback.ts` instead of
   `createElement`-ing two per pass (`readback.ts:20`, `:27`) — removes the
   per-frame canvas/context allocation churn.
3. Add LRU/byte-budget eviction to `scene-thumbs.ts` (FR-4) and cap the in-memory
   `thumbsMap` to live instances (drop entries for destroyed ones —
   `engine-link.ts:215`).
4. Optionally throttle/limit concurrent `<img>` decodes on the consumer side.

### Phase 3 — chase the crash to ground (FR-5)

1. With Phases 1–2 in, re-run the soak (NFR-3). If the crash is gone, attribute it
   (most likely the memory growth from Phase 2.3 or the storm-induced hung
   renderer from Phase 1).
2. If it persists, instrument the **embedded-engine** path (`ConsoleApp.tsx:167`,
   `console-channel.ts:36-55`): assert at most one rendering engine per origin, add
   a guard/log if two ever broadcast state simultaneously, and consider not booting
   the embedded engine while a real Output exists.
3. Document the mechanism and fix in DECISIONS.md; if it's irreducibly
   GPU/driver-specific, document the residual risk + mitigation per FR-5.

### Phase 4 — perf-diagnostics overlay (FR-6, secondary goal)

1. `PerfOverlay.tsx`: a toggled panel (Header button + hotkey) showing the meters
   that already exist (`#uifps`, `#fps`, per-tile fps/frameMs) plus heap size,
   thumb pass time, and the costliest instance's `slowSignals`
   (`InstanceInfo.slowSignals`). Read-only.
2. A lightweight **re-render counter** per major component (dev-only) so future
   regressions in FR-1 are visible, not felt.
3. This is the natural client for [[app-instrumentation]]: when that lands, the
   overlay reads structured metrics from it instead of ad-hoc fields.

## Edge cases & interactions

- **PANIC.** The live tile keeps its last good mirror during hold/scene-panic
  (`engine-api.ts:265-273`); the thumbnail cap (Phase 2.1) must keep the live and
  panic-pinned instances in the priority set so the cockpit never loses sight of
  the safe state. Don't touch the in-frame panic path (NFR-4).
- **Preview overlay open.** Adds the `preview` stream (`console-channel.ts:95`) and
  the full-res readback on top of thumbs — the busiest state, and a prime crash
  repro condition (Phase 0.3). The fps ladder already adapts the *downscale*
  (`engine-api.ts:1037-1055`); the thumb cap must not starve the preview or vice
  versa.
- **Embedded engine.** Validators run `?embed=0` (`ConsoleApp.tsx:88`) so they
  never boot the iframe engine; the crash repro and soak must run *with* it
  (the human's real default) to exercise the two-engine handshake.
- **Hidden tab.** The worker clock keeps state/thumbs flowing when the Output tab
  is hidden (`worker-clock.ts`, `console-channel.ts:71`); the re-render storm runs
  even hidden. Memoization (FR-1) helps here too. Consider whether the Console
  should slow its own paint when not focused.
- **Many tiles + drag.** dnd-kit sortable wraps every Tile (`Tile.tsx:59`,
  `TileGrid.tsx:89`); memoization must not break drag transforms (they're inline
  `style`, not `sx`, so they're fine, but verify after Phase 1).
- **Manifests churn.** `ParamPanel` reads `manifests[selected]`; splitting the
  snapshot must keep manifests a stable reference when only the session changed,
  or the panel re-renders on every tick anyway.

## Open questions

1. **Selector store vs. memo-only.** Cheapest correct fix might be just
   `React.memo(Tile)` + memoizing the sorted list; the fuller selector-store split
   is more invasive but more durable. Recommend: start with memo (Phase 1.1),
   measure, add the store split only if the storm persists. (Leaning: both —
   memo for tiles, store split for Header/ParamPanel.)
2. **Where does the prioritization hint live?** Engine-side heuristic
   (live/staged/recent) needs no new protocol; a Console→engine "visible tiles"
   hint is more precise but adds a message. Recommend the heuristic first.
3. **Is the embedded engine worth keeping?** It's a convenience (Console works with
   no Output window) but it's the most likely multi-context crash source. Option:
   keep it but never run it alongside a real Output, and tear it down the instant
   one appears (partially already done — `onYield`, `console-channel.ts:36`).
4. **Can the crash even be reproduced off the reference machine?** If not, Phase 3
   becomes "harden the suspects + document residual risk" rather than "confirm root
   cause." That's an acceptable outcome per FR-5, but should be an explicit
   decision, not a default.
5. **Diagnostics overlay scope vs. [[app-instrumentation]].** Build a minimal
   self-contained overlay now (reusing existing fields), or wait and build it on
   the instrumentation layer? Recommend minimal-now; it's cheap and the soak work
   needs it anyway.

## Out of scope

- Engine-side render-loop optimization (the Output window's fps is a separate
  concern; this is about the *cockpit*). Frame-ordering and never-go-black are
  untouched (NFR-4).
- A full telemetry/metrics pipeline — that's [[app-instrumentation]]; this request
  consumes it if present but doesn't build it.
- Reworking the thumbnail *cadence* or the preview ladder (already tuned;
  DECISIONS.md 2026-06-13 "preview fidelity").
- The `useThumb` store wiring — already isolated and declared good as-is.
