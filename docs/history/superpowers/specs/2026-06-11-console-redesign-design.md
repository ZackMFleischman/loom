# Console UI redesign — design spec

Date: 2026-06-11. Requested by Zack (voice notes); design decisions made autonomously per his
"use your best judgement, don't ask for feedback" instruction. Scope: `packages/engine-app/src/ui/`
(+ two small engine-app changes), `scripts/validate-m3.mjs`, `scripts/validate-m4.mjs`.

## Problem

The console works but looks thrown together: BPM readout and TAP are separate controls, the
audio picker and rack button crowd the header, FPS is an afterthought next to a huge PANIC,
the scene picker + "+ instance" button live awkwardly in a second strip, stage/commit ceremony
gets in the way, tiles are static with always-visible chrome, the param panel is fixed-width,
palettes are a clunky table, and nothing says "LOOM".

## Design

### Visual language

Keep the dark cockpit palette (`#0b0c10` / `#14161c`, `#3ddc97` accent). Density pass everywhere:
base font 12px, tighter paddings (`px: 1.25 / py: 0.5` bars), grid `minmax(240px)` with `gap: 1`,
small controls. Numbers and the wordmark get a monospace stack (`ui-monospace, Consolas`) for a
technical-instrument feel. One header row + one slim stage bar; no wasted vertical space.

### Header (one dense row)

`LOOM` wordmark (letterspaced, accent color) · tappable BPM chip · RMS meter · audio source
select · MIDI status · RACK toggle · ··· spacer ··· · prominent FPS readout · "output ⧉" /
"staged ⧉" new-tab links · PANIC.

- **BPM chip** consolidates the readout and TAP: a single button showing `120 BPM`; clicking it
  taps tempo. Keeps `#tap` (the button) and `#bpm` (the number span).
- **FPS** becomes a first-class readout: larger monospace `60 FPS` plus dim frame counter,
  keeps `#fps`.
- **New-tab links**: `<a target="_blank">` styled as buttons → `/` (output) and `/staged.html`.
- Keep `#audiomode` (native select with `mic:` option values) and `#panic` (text PANIC/RESUME)
  — validator contract.

### Stage bar (slim, doubles as the drop-to-go-live target)

`LIVE ▸ name` (red) · `STAGED ▸ name` (amber) · palette-source toggle when staged · crossfade
info · spacer · `agent commit` checkbox · `unstage` · `COMMIT`.

- The scene picker and `+ instance` button move out (see New-instance tile).
- **Drop = stage + commit**: dropping a tile (`text/loom-instance`) on the bar stages it and
  immediately commits (human-sourced, so never gated). Highlight says "drop to go live".
- **Agent commit defaults armed**: `main.ts` boots `agentCommitArmed: qs.get("agentCommit") !== "0"`.
  `?agentCommit=0` opts back into gating; the checkbox still disarms live. The gate mechanism is
  unchanged — only the default flips.
- Keeps `#stagestrip`, `#livename`, `#stagedname`, `#fadeinfo`, `#armagent`, `#unstage`, `#commit`.

### Tiles

- Chrome moves onto the thumbnail as overlays: LIVE chip top-left (red) + **red border** on the
  tile; STAGED chip (amber) + amber border; status dot with error tooltip; **destroy X top-right,
  visible only on hover** (never on the LIVE tile). Name row below stays one slim line:
  `id · scene` + small `stage`/`unstage` text button.
- DOM contract preserved: `.tile[data-id]`, child `<img>`, `.live-badge`/`.staged-badge` always
  in the DOM with `show` toggling, `.stagebtn` exact text `stage`/`unstage`, drag carries
  `text/loom-instance`.
- **Drag-to-rearrange**: tiles reorder via HTML5 drag-over within the grid; order persists to
  `localStorage` (`loom.tileorder`), new instances append. The same drag, released over the stage
  bar, stages+commits — one gesture, two targets.
- Double-click solo unchanged.

### New-instance tile

A ghost tile (`#newinstance`) renders at the end of the grid: dashed border, big `+`, "new
instance". Click → popover with the scene list (`.scenerow[data-scene]`, searchable by just being
short). **Hovering a scene row live-previews it**: after a 300 ms debounce the console calls
`create_instance` for real and shows that instance's streaming thumbnail in a preview pane beside
the list; moving to another row destroys the previous preview instance and builds the new one.
Clicking a row keeps the instance (creating it on the spot if the debounce hadn't fired), selects
it, and closes. Closing any other way destroys the orphan preview. Previews are real sandbox
instances — same cost as `+ instance` today, just earlier; never more than one preview alive.

### Param panel

Resizable drawer: 4 px grab handle on its left edge, drag to resize (min 240 px, max 60 vw),
width persisted to `localStorage` (`loom.panelw`). Keeps `#panel`, `#paneltitle`, `#widgets` and
all `ParamWidget` DOM (`data-path`, `data-learn`, `data-value`).

### Rack & palettes

Rack rows keep their structure (`.rackrow[data-name]`, `.rackfill`) with tightened spacing.
Palettes become **swatch-only rows**: `primary` / `secondary` label + five bare
`<input type="color">` swatches (no index labels, no hex text). Hex shows in the native tooltip
(`title`). The inputs carry `data-path="palette.<source>.<i>"` directly inside `#palettes` /
`.paletterow[data-name]` — exactly what validate-m6 queries — but are rendered by `Palettes.tsx`
itself instead of `ParamWidget` (color params have no learn/modulate anyway).

### Staged page depth

`thumbnails()` in `engine-api.ts` renders the **staged** instance's readback at 640×360 (tiles
stay 320×180, live tile stays loop-mirrored). `staged.html` then shows real detail instead of an
upscaled tile thumb. No protocol change — same data-URL map.

## Validator changes (acceptance criteria moved, not loosened)

- **validate-m3**: § 6 now asserts `agentCommitArmed === true` by default, then *disarms* via
  `#armagent` and proves agent commit is blocked (gate coverage kept) before the human `#commit`.
  § 9b uses the new picker: click `#newinstance`, click `.scenerow[data-scene="pulse"]`.
  § 10 inverts: `?agentCommit=0` boots disarmed (blocked agent commit), then a plain reload
  proves the armed default end-to-end (create → stage → agent commit lands).
- **validate-m4**: § 5 drag-onto-strip now expects stage **and** commit (`live === cid`).
  §§ 6–8 re-stage `boot` (then `cid`) via MCP so the unstage-button, staged-page empty/preview/
  COMMIT, and unstage checks keep their coverage with the new flow.
- All other validators untouched and must stay green.

## Out of scope

Output window, sidecar protocol, runtime kernel, MIDI learn UX, rack channel semantics.

## Testing

`pnpm typecheck`, `pnpm test`, then `validate:m0` → `validate:m6` + `validate:modulators` all
green before merge.
