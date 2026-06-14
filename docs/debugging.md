# LOOM instrumentation & debugging

How to see what the engine is doing — for the agent (over MCP), the human (Console
/ browser), and the developer (the test layers). Every claim below cites the file
it lives in. For the *why* behind these surfaces, grep `DECISIONS.md`
("App instrumentation", "signal robustness", "FPS counters", coverage entries);
for how it all fits together, `docs/architecture.md`.

The design rule the whole surface obeys: **instrumentation never goes black.** The
diagnostics ring's `push` is wrapped so an instrumentation bug can't throw into the
render loop, perf sampling is integer compares per frame, and profiling only
*measures* — it never feeds a value back into render, so fixture replays stay
byte-identical (`packages/engine-app/src/diagnostics.ts:120-138`,
`packages/runtime/src/instance.ts:56-71`).

---

## For the agent (via MCP)

The snapshot tools (`get_session`, `get_manifest`, `screenshot`) show you the
*present*. The diagnostics ring shows you the *history* — what build/swap/freeze/perf
event led to the number you're staring at.

### The diagnostics loop

> **act → `get_diagnostics { since: lastSeq }` → read what your action triggered → `screenshot` to confirm pixels.**

This is how you learn that a save was *rejected* when the screenshot looks
unchanged — the previous pixels are still running because the bad build never
touched the live instance (never-go-black). The tool's own description says the
same (`packages/sidecar/src/index.ts:444-457`).

### `get_diagnostics` — the event timeline

Args (`GetDiagnosticsArgs`, `packages/sidecar/src/protocol.ts:823-831`):

| arg | meaning |
|---|---|
| `scope` | `"engine"` (default) = the event timeline + perf rollup; `"sidecar"` = this process's own MCP-call latency table |
| `since` | a `seq` cursor — return events with `seq` strictly greater (page forward from a prior `now.seq`) |
| `kinds` | filter to these exact kinds, e.g. `["scene.rejected","instance.frozen"]` |
| `instance` | filter to one instance id (resolved through the `live` alias engine-side, `engine-api.ts:288-289`) |
| `level` | minimum severity (`info` < `warn` < `error`) |
| `limit` | cap returned events, newest kept, 1..512 |

Result (`scope:"engine"`, `GetDiagnosticsResult`, `protocol.ts:834-843`):

```jsonc
{
  "scope": "engine",
  "events": [ { "seq", "frame", "t", "level", "kind", "instance?", "msg", "data?" }, … ],
  "dropped": 0,            // events evicted from the ring since your `since` — you missed them (FR-4)
  "now": { "frame", "fps", "seq" },   // `now.seq` is your NEXT `since`
  "perf": { … PerfSnapshot … }
}
```

The event shape is `DiagEvent` (`protocol.ts:781-797`, mirrored at
`diagnostics.ts:36-52`): `seq` (monotonic, your cursor), `frame` (the causal
anchor — correlate cause→effect on it), `t` (`performance.now()` ms), `level`,
`kind` (open dotted name), optional `instance`, `msg` (a short English summary,
reusing the existing `[loom]` log strings), optional `data` (small structured
payload — error text, fps, frameMs, …).

**Paging:** the ring is a ~512-entry bounded buffer
(`DEFAULT_DIAG_CAPACITY = 512`, `diagnostics.ts:84`). Read `now.seq`, pass it as
your next `since`. If `dropped > 0`, the gap between your cursor and the oldest
surviving event was evicted during a quiet poll gap — you missed those events
(`diagnostics.ts:163-180`).

### The `kind` catalog (verified emit sites)

`kind` is an **open string** — new kinds emit without a protocol bump
(`protocol.ts:770-780`). The kinds the engine emits today, with their source:

| kind | level | when | source |
|---|---|---|---|
| `scene.swapped` | info | the live (boot) scene hot-swapped successfully | `main.ts:628` |
| `scene.rejected` | error | a save of the live scene failed to build; previous kept | `main.ts:315,331,616` |
| `instance.rebuilt` | info | a non-live instance rebuilt on a code change | `main.ts:682` |
| `instance.rejected` | error | an instance rebuild threw; previous still running (NFR-5) | `session.ts:220` |
| `instance.removed` | warn | an instance's scene vanished from the barrel; instance destroyed | `main.ts:668` |
| `instance.frozen` | error | a render-time throw froze the instance (NFR-2) | `instance.ts:114` |
| `loopguard.tripped` | error | a runaway loop blew its iteration budget and threw (a frozen instance whose error carries the loop-guard prefix) | `instance.ts:111-114` |
| `inputs.redefined` | info | `content/inputs.ts` hot-reloaded a new rack | `main.ts:649` |
| `inputs.rejected` | error | a throwing `defineInputs`; previous rack kept | `main.ts:127,642` |
| `effects.reloaded` | info | the chainable-effect library reloaded | `main.ts:699` |
| `audio.fallback` | warn | mic acquisition failed; fell back to synthetic test audio | `main.ts:356` |
| `panic.engaged` | warn | PANIC engaged (`data.mode` = `hold`/`scene`) | `engine-api.ts:642-647` |
| `panic.resumed` | info | RESUME cleared PANIC | `engine-api.ts:652` |
| `perf.fps.low` | warn | fps dropped below 50 (edge) | `perf-events.ts:57` |
| `perf.fps.recovered` | info | fps recovered above 57 (edge) | `perf-events.ts:65` |
| `perf.frame.spike` | warn | an instance's frameMs crossed ~25 ms (1.5× budget) | `perf-events.ts:81` |
| `perf.sample` | info | periodic heartbeat, every 60 frames (~1 s) | `perf-events.ts:97` |

> **`instance.frozen` / `loopguard.tripped` carry the instance id.** The kernel
> `Instance` is built knowing only its scene name, so the engine stamps the
> owning entry's id onto `Instance.instanceId` after create/rebuild/rename
> (`session.ts`); the freeze/loop-guard emit uses that id (falling back to the
> scene name only when unset — headless kernel use), and keeps the scene name in
> the event's `data.scene` (`instance.ts`). So `get_diagnostics { instance:<id> }`
> matches a freeze even on a sandbox whose id ≠ scene name. (Asserted in
> `packages/runtime/test/instance-freeze-id.test.ts`.)
>
> Known gap (escalation): in the WebGL2 validator a render-time freeze's
> console.error fires but no `instance.frozen` reaches the diagnostics ring (only
> `perf.*` events do) — so the `Instance.diagSink` → ring delivery for an NFR-2
> freeze isn't observable end-to-end there, even though `Instance.profilingEnabled`
> (the sibling static set the same way in main.ts) clearly applies to content
> instances. The id fix above is correct and unit-proven; making the freeze event
> actually arrive in the ring is a separate, pre-existing follow-up.

The two `perf.fps.*` thresholds (50/57) and the spike high-water mark
(`FRAME_BUDGET_MS * 1.5`, ~25 ms) are the *edge* emitters that let you find a sag
without polling every frame; `perf.sample` is the heartbeat
(`perf-events.ts:4-15,46-102`).

### The `perf` rollup (`PerfSnapshot`)

The at-a-glance "is the engine healthy" block. It is delivered two ways:

- folded onto **`get_session.perf`** (`protocol.ts:659-665`, built at
  `engine-api.ts:964`), and
- carried on **`get_diagnostics`** results alongside the timeline (`protocol.ts:841`).

There is **no separate `get_perf` MCP tool** — those are the only two readers.
Fields (`PerfSnapshot`, `protocol.ts:590-620`):

- `fps`, `clockSource` (`"raf"` visible / `"worker"` hidden tab), `frameBudgetMs`
  (~16.7), `frame`.
- `instances[]`: per-instance `{ id, frameMs, slowSignals: [{label, ms}] }`.
- `worstFrameMsRecent`: the worst single-instance frameMs across the recent
  sampling window (`perf-events.ts:40-42,73-75`).
- `renderer` (optional): three's `renderer.info` counters
  (`geometries`/`textures`/`drawCalls`) — best-effort leak detection across
  rebuilds, **dropped whole if any counter is missing** (`engine-api.ts:987-1002`).
  The WebGL2 headless fallback may not expose them.

Per-instance cost also lives directly on the snapshot's `InstanceInfo`:
`frameMs` and `slowSignals` (`protocol.ts:518-527`).

### Sidecar call latency (`scope:"sidecar"`)

The one telemetry layer the engine can't see: how slow your *own* MCP calls are.
`get_diagnostics { scope:"sidecar" }` is answered locally by the sidecar — no
engine round-trip (`index.ts:675-686`). Result
(`GetSidecarDiagnosticsResult`, `protocol.ts:846-852`):

```jsonc
{ "scope": "sidecar", "engineConnected": true,
  "tools": [ { "tool", "count", "ok", "error", "timeout", "p50", "p95", "max", "lastError" }, … ] }
```

Latency is measured mint→settle in the broker (`broker.ts:42-49,65-72,98-101`)
and accumulated per tool with a 200-sample window for percentiles
(`metrics.ts:99-132`). The table is sorted by call count.

### Worked example — a rejected save

You edit `content/scenes/live.scene.ts` and save, but the screenshot looks
identical. Did it land?

```jsonc
// 1. act: (the file save hot-swaps the boot instance)
// 2. read what it triggered:
get_diagnostics { "since": 557 }
// →
{
  "events": [
    { "seq": 558, "frame": 558, "level": "error", "kind": "scene.rejected",
      "instance": "boot",
      "msg": "scene \"pulse\" rejected; keeping previous",
      "data": { "scene": "pulse", "error": "<the build error>" } }
  ],
  "dropped": 0,
  "now": { "frame": 560, "fps": 60, "seq": 559 },
  "perf": { "fps": 60, … }
}
// 3. confirm:
screenshot { }   // shows the PREVIOUS pixels — proof the bad build never went live
```

The `error` in `data` is the actual build message. Fix the scene, save again, and
expect a `scene.swapped` at a higher `seq` (page from `now.seq` = 559). This exact
flow is what `validate:m2` asserts (DECISIONS.md SHIPPED entry: "forced bad save →
`scene.rejected` surfaced @frame 558 on boot, live pixels unchanged").

---

## For the human (Console / browser)

### Keyboard shortcuts & the `?` cheatsheet

The Console has a real hotkey layer (feature: keyboard-shortcuts): one delegated
`keydown` listener driven by a data-driven registry
(`src/ui/console/keybindings.ts`), with a centralized typing guard (keys are
ignored while focus is in an input/select/textarea/contenteditable) and scope
resolution (an open popover/dialog wins; else global). **Press `?` to open the
cheatsheet** — `src/ui/console/HotkeyCheatsheet.tsx`, the **canonical, always-current
reference for every binding**. It renders the registry directly, so it can never
drift: adding a binding adds a cheatsheet row for free (a unit test enforces the
one-row-per-binding invariant). `?` or `Esc` (or a backdrop click) closes it.

Highlights: `i` rack · `p` preview · `a` advanced params · `t` tap · `[`/`]`
step LIVE · `j`/`k` (or ←/→) select tile · `f` solo · `s` stage/unstage · `u`
unstage · `c`/`Enter` COMMIT (press-again to confirm) · `.`/`Shift+P` PANIC
(no confirm — speed is the point) · `x`/`Del` destroy (press-again) · `Shift+S`
self-capture. The **PerfOverlay toggle is now a registry hotkey (`d`)** like the
others — folded into the keymap rather than a separate listener — so it appears
in the cheatsheet and its tooltip hint stays in sync with the registry. Hotkeys
are suspended while a MIDI-learn is armed and never fire while typing.

### FPS meters

LOOM has three independent render rates, each with its own readout:

- **Output window render rate** — the engine's render loop. `FpsMeter`
  (`fps.ts:1-21`) writes `"<n> fps"` into `#fps`. On the bare Output page the
  element is kept in the DOM (validators gate readiness on its text) but is
  invisible unless `?hud=1` adds the `.show` class (`main.ts:62-65`). Surfaced in
  the Console header as `#fps`, labeled "out" (`Header.tsx:136-139`).
- **Console UI paint rate** — the React app's own paint loop, independent of the
  engine. `useRenderFps` drives a pure `FrameRateCounter` off rAF
  (`ui/fps-meter.ts:11-80`); shown as `#uifps` ("ui") in the header, going amber
  below 30 (`Header.tsx:121-135`). This is the meter that shows Console jank
  (React re-rendering every engine frame, many preview canvases) while Output
  stays smooth.
- **Per-tile render rate** — derived, no new engine plumbing: `tileFps(frameMs,
  engineFps, frozen)` = the engine fps capped by the tile's CPU budget
  (`1000/frameMs`), or 0 for a frozen instance (`ui/fps-meter.ts:51-58`). Rendered
  as `.tilefps` plus a `.framems` (per-frame CPU submit cost) on each grid Tile
  (`Tile.tsx:213-233`), and `#preview-fps` in PreviewMode (`PreviewMode.tsx:121-128`).

`.framems` goes amber above 8 ms; `.tilefps` amber below 30 fps, red when frozen
(`Tile.tsx:221,234`).

### The PerfOverlay — the human reader of the perf rollup

The Console has a toggleable, **read-only** perf-diagnostics panel
(`src/ui/console/PerfOverlay.tsx`, `#perfoverlay`): the human's window into the
SAME instrumentation the agent reads over MCP — **one pipeline, two readers**.
It consumes the `PerfSnapshot` that rides on the broadcast `session.perf` (built
by `EngineApi.perfSnapshot()`, the exact block `get_diagnostics.perf` /
`get_session.perf` deliver) plus the Console-local meters; it builds no competing
pipeline (NFR-5).

- **Toggle:** the header **PERF** button (`#perfbtn`) or the **`d`** hotkey
  (consistent with the existing `i` rack / `p` preview hotkeys); `Esc` closes it
  alongside preview.
- **Surfaces:** Console UI fps (`#uifps`), Output fps + clock source, the
  thumbnail-pass wall time (`perf.thumbPassMs` — the back-pressure meter; nearing
  the 150 ms thumb interval means the round-robin cap is saturating), worst recent
  frame, instance count, a coarse JS heap readout (`performance.memory`, Chromium
  only), three's `renderer.info` counts when exposed, and the costliest instance's
  `frameMs` + `slowSignals` (the per-signal cost attribution from the snapshot).

### `window.__loom` — the in-page debug surface

The object validators (and pre-MCP agent eyes) read; keep it updated when adding
engine state (a repo convention, root `CLAUDE.md`). Shape: `LoomDebug`
(`debug-surface.ts:7-48`). It carries:

- **Scalars, refreshed every frame:** `sceneName`, `audioMode`, `bpm`, `rms`,
  `onsetCount`, `instanceError`, `frame`, `fps`, `clockSource`, `live`, `staged`,
  `mix`, `panicked`, `panicMode`, `panicActive`, `panicScene`, `agentCommitArmed`,
  `inputs` (rack channel values), `palettes` (palette tunings)
  (`debug-surface.ts:115-138`).
- **`instances[]`, refreshed every ~6 frames (~100 ms):** the allocation-heavy
  array — per instance `id`, `scene`, `status`, `builds`, `pinned`, `modulators`,
  `chain`, and `slowSignals` (`debug-surface.ts:139-153`,
  `INSTANCES_EVERY = 6` at line 158). The cheap scalars stay per-frame fresh so a
  tightly-polled field is never stale.
- **Hooks:** `midiInject(cc, ch, value01)` (feeds the same path as a real CC
  message — mocked hardware) and `resumeAudio()` (the Console forwards a click
  gesture to unsuspend audio) (`debug-surface.ts:44-47`).

### The loop guard

A build-time AST pass (`packages/runtime/src/loopguard.ts`) injects a per-loop
iteration budget (`DEFAULT_LOOP_BUDGET = 5_000_000`, line 29) into every loop in
**content/ only** (the Vite `loom:loop-guard` plugin, `enforce:"pre"`). A runaway
loop *throws* with the prefix `[loom] loop guard: ` (line 79) instead of wedging
the single render thread; NFR-2 then freezes that instance, converting "never
halts" into "never go black". It is **count-based, not time-based on purpose** so
the throw/no-throw decision is identical on every machine and every replay
(deterministic fixtures, lines 14-22). A trip surfaces as a `loopguard.tripped`
diagnostics event (distinguished from a plain `instance.frozen` by the message
prefix, `instance.ts:111`).

### Reading a heavy scene (`frameMs` / `slowSignals`)

When a scene feels choppy:

1. **`frameMs`** (per instance, smoothed EMA CPU submit cost) tells you *that* an
   instance is heavy. It is the per-instance frame-time HUD: a `0.9/0.1` EMA over
   `renderFrame` cost (`instance.ts:21-22,122`), surfaced on tiles (`.framems`),
   in `get_session`'s `InstanceInfo.frameMs`, in `window.__loom`, and in the perf
   rollup.
2. **`slowSignals`** tells you *which signal* — per-signal cost attribution. With
   profiling on (default), `runUpdatersProfiled` times every uniform updater (EMA
   ms) keyed by its label — a param path, `"palette"`, `"input.<name>"`, or
   `uniform#<i>` for unlabeled ones (`instance.ts:126-148`). `slowSignals(n)`
   returns the costliest, descending. This turns "the scene is choppy" into
   "param X is 14 ms". Surfaced on `InstanceInfo.slowSignals`, in the perf rollup,
   and in `window.__loom`.

`screenshot` results also carry `fps` at capture time so an agent can self-police
perf (`protocol.ts:759-761`).

### URL knobs (Output page, `?...`)

Verified against `main.ts` (and where noted, the Console / sidecar). All are
read at boot from `location.search` (`main.ts:44`).

| knob | effect | source |
|---|---|---|
| `?profile=0` | turn OFF per-signal cost attribution (`slowSignals` goes empty); default on, overhead is microseconds | `main.ts:46-48`, `instance.ts:38` |
| `?diag=0` | turn OFF the diagnostics ring entirely (mirrors `?profile=0`) | `main.ts:50-54`, `diagnostics.ts:194-200` |
| `?diag=<n>` | set the ring capacity to `n` (default 512) | `diagnostics.ts:195-199` |
| `?hud=1` | reveal the Output `#fps` readout (the element is always in the DOM) | `main.ts:65` |
| `?res=WxH` | render at a fixed internal resolution (default 1920×1080), CSS `object-fit: cover` scales it | `main.ts:67-72` |
| `?bpm=<n>` | initial transport BPM (default 120) | `main.ts:76` |
| `?audio=test` | use synthetic kick/hats instead of the mic (also the automatic fallback when getUserMedia fails) | `main.ts` (AudioBus); arch.md |
| `?state=off` | disable AMBIENT tuned-state load+save (validators use it; explicit save/load still work) | `main.ts:153`, `state.ts:49`, `projects-controller.ts:18` |
| `?agentCommit=1` / `?agentCommit=0` | arm / restore the human gate for agent `commit` at boot | `main.ts:571`, `engine-api.ts:301,617` |
| `?ws=<port>` | dial an isolated sidecar WS port (default `DEFAULT_WS_PORT` 7341) — validator port isolation | `main.ts:581-583`, `protocol.ts:10` |
| `?embedded=1` | mark the Console's hidden-iframe engine (solo mode, stands down if a real Output appears) | `main.ts:585-587` |
| `?embed=0` | (Console page) disable the embedded engine entirely — validators use it | `ConsoleApp.tsx:86-88` |

> **Not present in the code** (despite occasional mention): there is no
> `LOOM_RES` env var (resolution is `?res=`), and no `forceWebGL2` knob. The
> backend is WebGPU with three's automatic WebGL2 fallback; headless Chromium has
> no WebGPU adapter, so automated runs exercise WebGL2 with no flag needed
> (architecture.md "Testing & validation"). The only env override of note is
> `LOOM_WS_PORT` for the sidecar (CLAUDE.md / arch.md).

---

## For the developer (verification layers)

LOOM's verification is four layers, cheapest first, plus a coverage gate. The full
description — what each layer can and can't see, when to run what — is the
**"Testing & validation"** section of `docs/architecture.md`. Do not duplicate it;
the summary:

1. **Typecheck** (`pnpm typecheck`) — regenerates `content/CATALOG.md`, then
   `tsc --noEmit` over `packages/*` + `content/`. The contract gate.
2. **Package unit tests** (`pnpm -r test`) — kernel (fake clock), sidecar
   (protocol + tool surface), engine-app (a `node` and a `happy-dom` `ui` vitest
   project).
3. **Stdlib content tests** (`pnpm test:content`) — every module built through the
   real `BuildCtx`; tier-1 contract, tier-2 robustness sweep, golden-pattern
   scans, harness self-test.
4. **Acceptance validators** (`pnpm validate`, or `pnpm validate:<x>`) — Playwright
   + headless Chromium, one suite per shipped milestone (the eyes-on layer).

**Coverage gate** — `pnpm test:coverage` (`vitest.coverage.config.ts`), a
**`packages/`-only** v8 run. The scope is *physically incapable* of measuring
`content/`: `include` is `packages/*/src/**` and `content/**` is excluded outright
(`vitest.coverage.shared.ts:16-30`), mirroring the packages-vs-content line in
`biome.json`. Thresholds are a **ratchet floor** = the current measured coverage
(raise deliberately, never lower; current floors lines 50 / statements 49 /
functions 39 / branches 36, `vitest.coverage.shared.ts:43-48`). The gate lives
ONLY in `pnpm test:coverage` (and CI) — `pnpm test`, `pnpm typecheck`, and the MCP
creative loop are untouched, so building visuals stays a single round-trip with no
coverage step.

**Which validator covers the instrumentation surface** (file:line in
`scripts/validate-*.mjs`; see arch.md's per-suite list):

- `validate:m2` — the MCP e2e suite, including `get_diagnostics`: a forced bad save
  → `scene.rejected` surfaced, live pixels unchanged, `since` paging, the sidecar
  latency table, `?diag=0` vs `?diag=1` both at 60 fps (DECISIONS.md SHIPPED:
  "App instrumentation").
- The `builds` counter on each session entry (`get_session` + `window.__loom`) is
  the "no rebuild happened" assertion every validator uses (arch.md).

---

## Planned / in-progress (NOT in main — do not rely on)

- **`screenshot_console`** — an MCP tool to capture the Console's pixels (not just
  instance render targets) is being built in a sibling branch. It is **not on
  main**; there is no such tool in `protocol.ts`'s `RequestType` or
  `sidecar/src/index.ts`. Mentioned here only so the doc doesn't imply it exists.
- ~~**Console PerfOverlay / perf view** does not exist yet.~~ SHIPPED
  (console-performance-stability): `src/ui/console/PerfOverlay.tsx` is the human
  reader of the perf rollup (PERF button / `d` hotkey) — see "The PerfOverlay" in
  the "For the human" section above. It reads the `PerfSnapshot` carried on the
  broadcast `session.perf` (the same block the agent's `get_diagnostics.perf`
  delivers), not the raw event timeline — that timeline is still consumed only by
  the MCP `get_diagnostics` path and the DevTools console (`logDiag` dual-writes,
  `diagnostics.ts:219-235`). Broadcasting the event ring to the Console reader is
  a future step.

---

## Gaps / inaccuracies found while documenting

These are signals worth a follow-up, surfaced by writing this doc against the code:

1. ~~**`instance.frozen` / `loopguard.tripped` report scene name, not instance
   id.**~~ FIXED (console-performance-stability): the engine now stamps the
   entry id onto `Instance.instanceId` after create/rebuild/rename and the emit
   uses it (scene name preserved in `data.scene`). `get_diagnostics
   { instance:<id> }` matches a freeze on any sandbox. See the "For the agent"
   note above and `packages/runtime/test/instance-freeze-id.test.ts`.
2. **No `get_perf` tool exists**, despite being referenced as a surface. The perf
   rollup is delivered only via `get_session.perf` and `get_diagnostics.perf`.
   This doc says so explicitly so an agent doesn't try to call it.
3. **`panic.*` and the perf-event kinds are emitted via `diag.push` directly, not
   `logDiag`** (`engine-api.ts:642`, `perf-events.ts:55`), so unlike the other
   kinds they do NOT also print to the DevTools console. Intentional for the
   per-frame perf path (no console spam), but means a human watching DevTools
   won't see a PANIC line — only the agent's ring does. Worth confirming that's
   desired for `panic.engaged`.
