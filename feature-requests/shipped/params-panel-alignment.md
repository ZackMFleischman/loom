# Params panel — slider alignment

**Status:** requested (2026-06-13) · Owner: unassigned

## Summary

In the Console param panel, every param renders as its own independent flex row, so
the label takes exactly as much width as its text (capped at a hard `96px` for
sliders). A short name like `gain` and a long one like `feedbackAmount` therefore push
their sliders to *different* x-positions, and the panel reads as a ragged staircase
instead of a clean column. The ask: give the panel a **shared label column** sized to
the longest name (up to a max), **wrap** names that exceed the max, and let every
slider/button/value start at the same x — aligned vertically down the panel.

This is a focused layout fix inside `ParamWidget` + `ParamPanel`; it changes no engine
behavior, no manifest shape, and no validator DOM contract. It is a natural slice of
the broader [[console-ui-refactor]].

## Current state (why labels don't align)

Each param is one row, built per-widget — there is no element that spans rows to
enforce a common label width.

- **The row is a per-widget `Stack direction="row"`** — `ParamWidget` returns a `Box`
  whose only child is a horizontal `Stack` (`packages/engine-app/src/ui/console/ParamWidget.tsx:141-146`).
  Each widget is laid out in isolation; nothing ties one row's label width to the next.
- **The label sizes to its own text** — for sliders the label `Typography` is
  `flex: "0 0 auto", maxWidth: 96, minWidth: 0`; for everything else (bool/color/
  labelled-int selectors) it is `flex: 1, minWidth: 0`
  (`ParamWidget.tsx:157-164`). So a slider label is "as wide as the name, clamped at
  96px", and a selector/bool label is "all remaining space" — two *different* sizing
  rules in the same panel, neither shared across rows.
- **`noWrap` truncates instead of wrapping** — the label is `<Typography noWrap …>`
  (`ParamWidget.tsx:158`), so a name longer than the column is ellipsized (the full
  text only survives in the hover tooltip, `ParamWidget.tsx:147-156`), the opposite of
  the requested wrap-past-max behavior.
- **The control's start x floats** — sliders are `flex: 1, minWidth: 56, mx: 0.5`
  (`ParamWidget.tsx:303`); the value readout is `minWidth: 48, textAlign: right`
  (`ParamWidget.tsx:340-344`). Because the label ahead of them is variable-width, the
  slider's left edge lands at a different x on every row. Net effect: misaligned
  sliders and a ragged right gutter.
- **The panel just stacks widgets** — `ParamPanel` maps params straight into
  `<ParamWidget>` siblings inside `#widgets` and inside each group's
  `AccordionDetails` (`ParamPanel.tsx:230-238`, `:273-282`, `:304-312`); it passes no
  width/column information down. There is no grid or shared column anywhere in the
  param-rendering path (theme has no relevant rule — `packages/engine-app/src/ui/theme.ts`).

**Diagnosis:** alignment is impossible today because label width is decided *inside
each row from that row's own text*. To line sliders up, the column width must be
decided **once for a set of rows** and applied to all of them.

## Requirements

### Functional

- **FR-1 Shared label column.** Within one contiguous group of rows (see FR-5 for
  scope), all labels occupy a single column whose width is the **widest label in that
  group**, so every control starts at the same x.
- **FR-2 Max width + wrap.** The label column is capped at a maximum (recommend
  ~120px / ~14ch — see open questions). A name wider than the cap **wraps to a second
  line** within the column rather than truncating; the row grows taller and the control
  stays in its column, top-aligned to the first line.
- **FR-3 Aligned controls and values.** With labels in a fixed column, the slider/
  toggle/selector/color control and the numeric readout line up vertically down the
  panel: one control column, one right-aligned value gutter.
- **FR-4 Tooltip + full name preserved.** The description tooltip
  (`ParamWidget.tsx:147-156`) stays. Because names now wrap instead of truncate, the
  tooltip is no longer the *only* way to read a long name — but keep it for the
  description.
- **FR-5 Per-section columns.** Each group/accordion (and the flat top section) sizes
  its own column independently. A short-named node group should not be widened by a
  long name in an unrelated group across the panel (see edge cases).

### Non-functional

- **NFR-1 No DOM-contract break.** Validators key off `data-path` on the control's real
  `<input>`, `data-learn`, `data-value`, `.widget`, `.rackrow[data-name]`,
  `.rackfill`, `data-node`, `data-transform` (`ParamWidget.tsx:42-51`, `:134`,
  `Rack.tsx:12`). The layout change must preserve every one of these — change geometry,
  not structure or attributes.
- **NFR-2 No reflow on drag.** The column width must not depend on the live *value*
  (only on label text), so dragging a slider or typing a value never re-lays-out the
  column. Today `drag` state already isolates the value readout; keep width independent
  of it.
- **NFR-3 Resizable panel.** The drawer is user-resizable (240px–60vw,
  `ParamPanel.tsx:62-87`). The label-column cap is fixed; the *control* column flexes
  with the panel width as it does today.

## Recommended approach

Three options, recommended first.

### Option A (recommended) — CSS Grid label column, max-content-clamped

Make each section a CSS grid with a label column sized
`minmax(0, min(max-content, var(--label-max)))` and let the browser do the
"widest-up-to-a-cap" math with no JS measurement.

- Wrap a section's rows in a grid container:
  `display: grid; grid-template-columns: minmax(0, min(max-content, var(--label-max))) 1fr; column-gap; row-gap;`.
  `max-content` makes the first column as wide as the **widest label in the grid**
  (exactly FR-1); `min(…, --label-max)` caps it (FR-2); `minmax(0, …)` lets a capped
  label wrap instead of overflowing.
- Each `ParamWidget` becomes a row of grid cells (its label is cell 1; the control +
  trailing buttons + value are cell 2, or split into more explicit columns — see open
  questions). The current per-widget inner `Stack` (`ParamWidget.tsx:141`) is what
  changes; the outer `.widget` `Box` can stay as the row marker.
- The label `Typography` drops `noWrap` and `maxWidth: 96` and instead gets
  `overflow-wrap: anywhere` (or `word-break: break-word`) so long names wrap inside the
  clamped column (FR-2).
- Set `--label-max` once on the section container (one value, all rows share it).

Why recommended: pure CSS, exact "widest label up to a max, then wrap" semantics, no
measurement pass, no resize listener, survives panel resize and font changes for free.
Cost: `ParamWidget` must emit cells into a parent grid (it currently emits a
self-contained flex row), which is a real-but-contained refactor of the widget's markup
and is shared with the [[console-ui-refactor]] direction.

### Option B — `ch`-based fixed column (simplest, least faithful)

Give the label a fixed `width: min(<longest>ch, <max>ch)` so all rows match. Simple,
but it does **not** auto-fit the actual longest name (you either hardcode a width or
compute the longest name's length in JS), and a single fixed width across the whole
panel violates FR-5 (per-section sizing). Acceptable as a quick interim if Option A's
grid refactor is deferred, but it trades correctness for speed.

### Option C — measured column (`max-content` via JS)

Measure the longest rendered label per section in a layout effect and set the column
width. Functionally like Option A but reintroduces a measurement pass, resize/font
re-measurement, and SSR/initial-paint jitter. Only worth it if grid `max-content`
turns out not to compose with the accordion/MUI markup. Prefer A; keep C as fallback.

## Implementation plan

1. **Introduce a section grid.** In `ParamPanel`, wrap each rendered run of widgets —
   the flat top run (`ParamPanel.tsx:230-238`), each group's `rest` run
   (`:273-282`), and each rig "transform" run (`:304-312`) — in a grid container
   carrying `--label-max`. (`Rack` and `FxChain` are separate call sites with their own
   `dense`/`fill` rows — leave them out of scope unless we want the same treatment;
   see edge cases.)
2. **Convert `ParamWidget` to emit grid cells.** Replace the inner `Stack` with
   markup that places the label in column 1 and the control cluster in column 2 (or
   2..n if we split value/buttons into their own tracks). Keep `.widget` as the row
   wrapper and `display: contents` it into the grid, or have the parent map provide the
   grid and the widget render plain cells.
3. **Drop `noWrap` + `maxWidth: 96`** on the slider label; add `overflow-wrap`.
   Reconcile the two label sizing rules (slider vs. selector/bool, `ParamWidget.tsx:160`)
   into the single column rule.
4. **Keep all `data-*` hooks and class names** on the same elements (NFR-1); run
   `pnpm test` (`packages/engine-app/test/console-logic.test.ts`) and the Console-driving
   validators (`validate:m3`, `validate:layers`).
5. **Eyeball it** with a long-name scene and a node section (the `[[console-screenshot]]`
   tool, once it exists, or a manual screenshot) to confirm alignment and wrapping.

Estimated size: widget markup ~30–50 lines changed, panel wrappers ~15 lines, plus the
grid CSS. No new files; no engine/protocol/manifest changes.

## Edge cases & interactions

- **Very long names.** Names past the cap wrap (FR-2). Confirm wrap point with
  `overflow-wrap: anywhere` so an unbroken token (e.g. `feedbackAmountMax`) still wraps
  rather than overflowing the column.
- **Nested node sections.** Inside a group, labels are already group-stripped
  (`ParamPanel.tsx:279` passes `label={path.slice(group.length + 1)}`) and the rig
  "transform" sub-group strips `layer.` too (`:310`), so the column only ever sizes to
  the short tail — good. Per-section columns (FR-5) mean a node's `transform` sub-grid
  sizes independently of its parent's params; verify the nested accordion's
  `AccordionDetails` doesn't fight the grid.
- **Advanced / hidden trims.** Toggling "advanced" (`ParamPanel.tsx:324-339`) injects
  the per-instance input trims (`input.<name>.amount`) into their groups. With a
  `max-content` grid the column **re-fits when they appear** — acceptable (they share
  the cap), but note the column can widen on toggle. If that jump is unwanted, size the
  column off the always-visible set only (open question).
- **Selectors, bools, colors.** These currently use the `flex: 1` label rule, not the
  `maxWidth: 96` slider rule (`ParamWidget.tsx:160`). Folding them into the shared
  column is the whole point (so a bool row and a slider row align) — but their controls
  are intrinsic-width (toggle group, color swatch), not flexible like a slider, so the
  control column should be `1fr` with the control left-aligned, not stretched.
- **Labelled-int selectors wrap today.** The row sets `flexWrap: "wrap"` only when
  `p.labels != null` (`ParamWidget.tsx:145`) — a multi-button selector can already
  wrap under its label. In a grid this becomes "control cell wraps within column 2";
  keep that behavior.
- **Rack & FX-chain rows are different shapes.** `Rack` uses `dense` fixed-width
  widgets in a wrapping flow (`Rack.tsx:86-92`, `.rackrow`/`.rackfill`) and `FxChain`
  uses `dense fill` rows (`FxChain.tsx:322`). These are deliberately compact and not
  the panel's vertical list — recommend **scoping this fix to the main param list** and
  leaving rack/chain rows as-is unless the user wants them aligned too.
- **Panel resize.** The label column is capped (fixed); the control column flexes, so
  resizing the drawer (`ParamPanel.tsx:70-87`) changes slider length, not label
  alignment. Confirm at the 240px minimum the label cap still leaves a usable slider.

## Open questions

- **Cap value.** What max width? Recommend ~120px (≈14ch at the panel's 12px font) so
  two-word camelCase names mostly fit on one line and only the genuinely long ones
  wrap. Needs an eyeball pass against real scenes. *(unverified — no measurement done)*
- **Column count.** Two tracks (label | everything-else) or three+ (label | control |
  value, plus the mod/learn/range buttons)? A dedicated right value gutter (FR-3) reads
  cleanest but is more grid plumbing. *(design choice)*
- **Advanced-toggle reflow.** Size the column off the visible set (jumps on toggle) or
  the full set (stable but wider when trims are hidden)? Recommend visible-set + accept
  the jump. *(design choice)*
- **Scope of rack/FX rows.** In or out? Recommend out (different layout intent).
  *(needs user confirmation)*

## Cross-links

- [[console-ui-refactor]] — this is one concrete slice of the panel cleanup; the
  `ParamWidget` markup change should land consistently with that direction.
- [[console-screenshot]] — the eventual way to verify panel layout visually from an
  agent.
