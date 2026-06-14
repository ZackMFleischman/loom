# Console UI refactor — make controls read as controls, tighten look & feel

**Status:** requested (2026-06-13) · Owner: unassigned

## Summary

The Console is a dense React/MUI cockpit (`packages/engine-app/src/ui/console/`),
and most of it works — but the **PREVIEW** control, one of the more important verbs
on the page, is rendered as `variant="text"` and reads as a label, not a button
(`Header.tsx:90-97`). It's the symptom of a broader pattern: the Console grew control
by control, each `<Button>` carrying its own ad-hoc `sx` (sizes, paddings, font sizes,
colors) instead of leaning on a small shared set of control variants. The result is a
header row of buttons that don't share a visual language and a hierarchy that doesn't
track importance (the everyday PREVIEW looks lighter than a static `output ⧉` link).

This request is two moves: (1) **make the preview button look like a button** —
the literal ask; (2) **a focused look-&-feel pass** — promote the existing
[theme tokens](#current-state) into a small button taxonomy (primary / default /
ghost / danger) and apply consistent spacing & hierarchy across the header,
stage strip, tiles, and param-panel actions — *without* inventing a new design
system. It composes with [[params-panel-alignment]] (the panel's *internals*) and
[[panic-safe-scene-redesign]] (the PANIC cluster's *shape*); see
[Interactions](#interactions-with-sibling-requests).

## Current state

The Console is vanilla React + MUI v5, themed once in `src/ui/theme.ts` and mounted
through `src/ui/console/main.tsx` (`ThemeProvider` + `CssBaseline` + a single
`learnpulse` keyframe). There is **no separate CSS file** — all styling is the MUI
theme plus per-component `sx` props. The theme already carries the design tokens:

- **Palette** (`theme.ts:8-16`): `background.default #0b0c10` / `paper #14161c`,
  `divider #262a33`, `text.primary #c8cdd8` / `secondary #6b7280`, accent
  `primary #3ddc97`, `warning #f3c969`, `error #e6455a`.
- **Type** (`theme.ts:17-20`): `system-ui` body at 12px; `mono` (exported separately,
  `theme.ts:4`) for the wordmark, BPM, fps readouts.
- **One Button default** (`theme.ts:21-29`): `variant: "outlined"`, `size: "small"`,
  `color: "inherit"`, `textTransform: "none"`, `padding: "1px 8px"`. That's the *only*
  shared control style — everything beyond it is local.

Layout shell (`ConsoleApp.tsx:115-189`): a full-height flex column — `Header` then
`StageStrip` (both inside `StageDropZone`), a flex `main` with `TileGrid` + `ParamPanel`,
and an overlay `Rack` / `PreviewMode`. Hotkeys `i` / `p` / `Esc` (`ConsoleApp.tsx:99-113`).

### Concrete problems

1. **The preview button isn't a button.** `Header.tsx:90-97`:
   `variant={previewing ? "contained" : "text"}`. In the resting (not-previewing)
   state it's `text` — no border, no fill, no affordance — visually a caption that
   happens to be clickable. Every other header control is `outlined` (the theme
   default), so PREVIEW is the odd one out *and* under-weighted relative to its
   importance.

2. **No button taxonomy → inconsistent weights.** Buttons hand-tune their own look:
   COMMIT `fontSize:14, fontWeight:700, px:2` (`StageStrip.tsx:67-75`), PANIC
   `fontSize:15, fontWeight:700, px:2.5` (`Header.tsx:303-311`), GO LIVE
   `fontSize:12, fontWeight:700` (`ParamPanel.tsx:211-224`), tile `stage`
   `fontSize:11, px:0.75` (`Tile.tsx:264-274`). Each is reasonable alone; together
   there's no rule mapping *weight* to *importance*. Plain navigation links
   (`output ⧉`, `staged ⧉`, `Header.tsx:128-139`) carry the same default outline as
   real verbs, so destructive/important actions don't stand out.

3. **Header crowding & flat grouping.** One long `Stack direction="row" spacing={1.25}`
   (`Header.tsx:34-141`) holds ~13 controls — wordmark, tap-tempo, RMS meter, audio
   picker, MIDI status, RACK, PREVIEW, projects (load + save), a `flex:1` spacer, two
   fps readouts, two output links, and the whole PANIC cluster — with no visual
   grouping or separators. Related controls (transport vs. monitoring vs. nav vs.
   emergency) aren't chunked, so the eye can't find the verb it wants.

4. **Repeated, slightly-divergent state chips.** "LIVE"/"STAGED" labels are
   re-implemented inline in at least three places — `PreviewMode.tsx:125-134`,
   `ParamPanel.tsx:181-186`, plus the tile badges (`Tile.tsx:121-140`) and stage-strip
   pointers (`StageStrip.tsx:40-45`) — each with its own color/weight literals. Same
   concept, four spellings.

5. **Spacing/padding are per-call literals.** `px`/`py`/`spacing` values
   (`0.5, 0.75, 1, 1.25, 1.5, 2, 2.5`) are scattered across components with no shared
   rhythm; the header, stage strip, and preview header each redefine the same
   `px:1.25, py:0.5, borderBottom` bar (`Header.tsx:39`, `StageStrip.tsx:30-38`,
   `PreviewMode.tsx:110-117`).

### What is NOT broken (leave it)

- The token palette and `mono` choice are good — this refactor *uses* them, doesn't
  replace them.
- The dark-cockpit feel, the tile two-channel ring system (status ring vs. selection
  halo, `Tile.tsx:82-90`), and the preview overlay's full-res streaming
  (`PreviewMode.tsx`) are sound.
- DOM contracts that validators read (see [Constraints](#constraints--dom-contract)).

## Requirements

### Functional

- **FR-1 — Preview reads as a button.** `#previewbtn` has a clear resting affordance
  (border/fill) in *both* states; its active (previewing) state stays visually distinct
  (e.g. `contained`). It should read as at least as important as the other header verbs,
  not lighter. The literal headline ask.
- **FR-2 — Button taxonomy.** Introduce a small, named set of control intents and apply
  them, replacing the bulk of per-button `sx` sizing/weight:
  - **primary** — the commit-path verbs: COMMIT (`StageStrip`), GO LIVE (`ParamPanel`).
  - **default** — everyday controls: RACK, PREVIEW, tap-tempo, projects, stage/unstage.
  - **ghost / link** — out-of-flow nav: `output ⧉`, `staged ⧉` (still clearly secondary).
  - **danger** — PANIC.
  Three to four variants, no more. This is a *vocabulary*, not a framework.
- **FR-3 — One state-pill component.** A single `<StatusPill kind="live|staged|safe">`
  used everywhere LIVE/STAGED/SAFE appears (tile badges, stage strip, param panel,
  preview header), so the colors/weights live in one place. Must preserve the existing
  badge text and `show`-class contract (FR below).
- **FR-4 — Header grouping & hierarchy.** Chunk the header into logical clusters
  (transport+audio · monitoring · nav · emergency) with light separators or spacing,
  so importance is legible at a glance. No new controls; only arrangement + weight.
- **FR-5 — Spacing rhythm.** Factor the repeated top-bar style (`px·py·borderBottom`)
  into one shared bar primitive used by Header, StageStrip, and PreviewMode's header,
  and standardize on a small spacing scale instead of one-off literals.

### Non-functional

- **NFR-1 — No new dependency, no CSS file.** Stay within MUI theme + `sx`. The
  taxonomy is expressed as theme `variants` / a tiny set of styled wrappers, not a new
  styling library. (Consistent with the codebase's "theme is the single source"
  approach, `theme.ts`.)
- **NFR-2 — Behavior unchanged.** Pure look/layout refactor. Every command, hotkey,
  drag target, and engine round-trip behaves identically; this touches `packages/`,
  so it's human-reviewed engine work (per `CLAUDE.md` conventions) — keep the diff
  legible.
- **NFR-3 — Accessibility & hit targets.** Buttons keep readable labels (validators
  match `textContent`) and tap-friendly sizes — the Console is used one-handed on a
  tablet mid-set (`ParamPanel` collapse, `StageNav` comments reference mobile).
- **NFR-4 — Screenshot-friendly.** The Console is the subject of [[console-screenshot]]
  (SVG-foreignObject self-capture); keep styling within what that rasterizer handles
  (it already does — vanilla DOM + theme), so captures of the refactored UI stay faithful.

## Constraints — DOM contract (do not break)

Validators (`packages/engine-app/test/`, the `validate:m3`/`m5` Playwright suites) and
[[console-screenshot]] assert on stable ids/classes/text. The refactor is **CSS/layout
only** over these anchors:

- Stable ids referenced across the app: `#previewbtn`, `#commit`, `#unstage`,
  `#armagent`, `#panic`, `#panicmode-hold`, `#panicmode-scene`, `#panicscene`,
  `#stagestrip`, `#livename`, `#stagedname`, `#fadeinfo`, `#panel`, `#paneltitle`,
  `#panel-stage`, `#panel-golive`, `#panel-advanced`, `#preview-mode`, `#preview-image`,
  `#preview-exit` (and the rest in `PreviewMode.tsx:46-47`), `#tap`/`#bpm`/`#rmsfill`,
  `#fps`/`#uifps`, `#newinstance`, `#projects`/`#projsave`/`#projname`/`#projsaveok`.
- Class/text contracts: tile `.tile[data-id]`, `.live-badge`/`.staged-badge` + the
  `show` class, `.stagebtn` with exact text `stage`/`unstage` (`Tile.tsx:37-48`,
  `122-140`, `264-274`); MIDI-learn chips' `data-learn` + `cc<N>`/`M` text
  (`StageStrip.tsx:114-143`); `.scenerow[data-scene]` (`NewInstanceTile.tsx:207-210`).
- The theme comment at `theme.ts:24-26` already warns: button **text** is asserted, so
  uppercase/weight changes are CSS-only and safe — but **don't change label text**.

> Open question: a full validator inventory of asserted selectors should be pulled
> before implementation (grep the `validate:*` scripts + `test/`), so the taxonomy
> swap provably preserves every anchor. Treat the list above as the verified core, not
> exhaustive.

## Plan (phased)

### Phase 1 — Preview button (the headline fix, ship alone)

1. `Header.tsx:90-97` — give `#previewbtn` a real resting variant (default/outlined)
   and keep `contained` for the active state; weight it as a primary-ish verb. One-line
   change, immediately satisfies the literal ask. Verify `previewbtn` toggle + `p`
   hotkey still drive `PreviewMode`.

### Phase 2 — Button taxonomy (FR-2)

1. In `theme.ts`, define the named intents (theme `components.MuiButton.variants` keyed
   on a custom prop, or a thin set of exported styled buttons — `LoomButton`/`PrimaryBtn`/
   `GhostBtn`/`DangerBtn`). Encode size/weight/padding *once*.
2. Migrate call sites to the taxonomy, deleting per-button sizing `sx`: COMMIT
   (`StageStrip.tsx:67-75`), GO LIVE / stage (`ParamPanel.tsx:199-224`), PANIC
   (`Header.tsx:303-311`), tile stage (`Tile.tsx:264-274`), header verbs + nav links
   (`Header.tsx:54-139`). Labels and ids untouched.

### Phase 3 — Shared pill + bar primitives (FR-3, FR-5)

1. `<StatusPill>` component; replace the inline LIVE/STAGED/SAFE spellings in
   `PreviewMode.tsx:125-134`, `ParamPanel.tsx:181-186`, `StageStrip.tsx:40-45`, and the
   tile badges (`Tile.tsx:121-150`) — keeping the badge classes + `show` contract.
2. A `<TopBar>` (or shared `sx`) for the repeated `px:1.25 py:0.5 borderBottom` row;
   apply in Header, StageStrip, PreviewMode header.

### Phase 4 — Header grouping & spacing pass (FR-4, FR-5)

1. Re-cluster the header row into transport+audio / monitoring / nav / emergency, with
   light separators; normalize spacing to the scale. No control added or removed.
2. Eyes-on pass at desktop + tablet widths; one before/after screenshot in the PR per
   `CLAUDE.md` "Screenshots in PRs".

Phases are independently shippable; Phase 1 stands alone and answers the user's
sentence directly.

## Interactions with sibling requests

- **[[params-panel-alignment]]** owns the param panel's *internal* grid (label column
  sizing/wrapping in `ParamWidget`/`ParamPanel`). This request owns the panel's *frame
  and action buttons* (`#panel-stage`/`#panel-golive`, the collapse chevron). They meet
  at `ParamPanel.tsx` — coordinate so the alignment work lands inside the widgets while
  the taxonomy reskins the action row, not the slider grid. No overlap if sequenced;
  do alignment's column math first, then reskin around it.
- **[[panic-safe-scene-redesign]]** changes the *shape* of the PANIC cluster
  (`Header.tsx:237-314`): drop the default safe scene, make PANIC a split button with an
  attached `▾` dropdown. That restructures the same component this request restyles. **Let
  panic-redesign land first** (it changes the markup), then apply the `danger` taxonomy
  to whatever shape it leaves — otherwise the styling work is redone. Flagged so they
  compose rather than collide.
- **[[keyboard-shortcuts]]** / **[[console-performance-stability]]**: no markup overlap;
  this refactor must not regress the `i`/`p`/`Esc` hotkeys (`ConsoleApp.tsx:99-113`) or
  add per-frame cost.
- **[[console-screenshot]]**: keep the DOM rasterizer-friendly (NFR-4).

## Out of scope

- A full design-system / component library, design tokens beyond the existing theme,
  or a visual rebrand. This is a consistency + hierarchy pass, not a redesign.
- The param panel's slider/label alignment internals — that's [[params-panel-alignment]].
- The PANIC cluster's structural change (split-button dropdown) — that's
  [[panic-safe-scene-redesign]]; this only restyles whatever shape it produces.
- Any behavior, command, routing, or engine change.
- Theming the Output (`index.html`) or staged (`staged.html`) windows — this is the
  Console page only.
- Responsive/mobile *layout* reflow beyond keeping current controls tappable
  (the existing collapse affordances stay; a true small-screen layout is future work).

## Open questions

1. **Taxonomy mechanism** — theme `MuiButton.variants` keyed on a custom prop vs. a
   handful of exported styled wrappers? Variants keep it all in `theme.ts` (one source,
   matches the codebase); wrappers are more discoverable at call sites. Lean variants.
2. **How distinct should danger/primary be?** PANIC and COMMIT are the highest-stakes
   verbs — confirm with the performer how loud they want to read (color fill vs. just
   weight) before locking weights.
3. **Header grouping** — visual separators (dividers) vs. spacing-only clustering? Need
   the real rendered width at the performer's resolution to judge crowding; pull a
   [[console-screenshot]] of the live header before deciding.
4. **Full validator selector inventory** (see Constraints) — confirm the complete set of
   asserted ids/classes/text before the taxonomy migration, so nothing silently breaks.
