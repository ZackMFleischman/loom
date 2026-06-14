# Feature request: Console keyboard shortcuts — a real hotkey layer + a `?` cheatsheet

Status: requested (2026-06-13) · Owner: unassigned

## Summary

The Console cockpit (`packages/engine-app`, `/console.html`) has accreted a handful of
ad-hoc `keydown` handlers but no real hotkey *layer*: no central registry, no scoping, no
discoverability. A performer driving a live set should be able to keep their hands on the
keyboard for the high-frequency moves — stage, commit, step LIVE, PANIC, toggle the rack,
preview — and discover every binding by pressing `?`. This request refactors the scattered
handlers into one keymap registry, binds the major Console actions, and generates a
single-page cheatsheet *from that registry* so the help overlay can never drift from what
the keys actually do.

The Console is **React 19** (`@mui/material` + `@emotion` + `@dnd-kit`), not vanilla DOM —
that drives the library choice below. Related: [[console-ui-refactor]] (this hotkey layer is
a natural slice of that refactor), [[console-screenshot]] (proposes an `s` self-capture key
this registry would own), [[panic-safe-scene-redesign]] (PANIC is the one binding with
real safety stakes), [[console-performance-stability]].

## Current state (grounded)

There are exactly **three** keyboard surfaces in the Console today, plus typing handlers in
fields, plus one handler that lives on the *engine* page (not the Console):

- **`ConsoleApp.tsx:97–113`** — the only global Console hotkey block. A `window`
  `keydown` listener: `i` toggles the rack, `p` toggles preview, `Escape` leaves preview.
  It guards against typing by bailing when `e.target` is an `HTMLInputElement` /
  `HTMLSelectElement` / `HTMLTextAreaElement` (`:101–106`). This is the seed of the whole
  feature — it already proves the pattern, it's just not extensible.
- **`main.ts:556–558`** — `t` taps tempo (`timeBus.tap(...)`). **This is on the Output
  window / engine page, not the Console**, and it has *no* typing guard. The Console's tap
  tempo is a button instead (`Header.tsx:54–66`, `set_transport { tap: true }`). Worth
  unifying: `t` should tap from the Console too, routed through the registry.
- **Field-local `Enter`/`Escape` handlers** (not global): rename box
  (`Tile.tsx:76–80`, with `e.stopPropagation()`), project-save dialog
  (`Header.tsx:209–211`), FX-chain save (`FxChain.tsx:445–447`), range inputs
  (`RangePopover.tsx:122–123,150–175`), param numeric edit (`ParamWidget.tsx:314–316`).
  These are correct as-is and should stay local — the registry must not swallow them.

No screenshot/self-capture key exists yet (the `s` key in [[console-screenshot]] is a
*proposal*, FR/Phase-1 there — verified: there is no `captureConsole`/`console-capture`
module in `packages/engine-app`). No `?`/help overlay exists. No keymap registry exists;
the only shared idea is the typing-guard, duplicated by hand.

### The actions worth a key (derived from the real Console)

Every one of these is already a real button/command in the Console — the registry binds the
existing handler, it does not invent behavior:

| Action | Today's surface | Engine command |
| --- | --- | --- |
| Stage / unstage selected tile | `Tile.tsx:264–274` `.stagebtn` | `stage` / `unstage` |
| Unstage (global) | `StageStrip.tsx:64` `#unstage` | `unstage` |
| COMMIT staged → live | `StageStrip.tsx:67–75` `#commit` | `commit` (human always allowed here) |
| Step LIVE prev / next | `StageStrip.tsx:49–50,88–113` | `live_step { dir }` |
| PANIC / RESUME | `Header.tsx:303–311` `#panic` | `panic` / `resume` |
| Toggle input rack | `ConsoleApp.tsx:107` (`i`) | UI state |
| Toggle preview | `ConsoleApp.tsx:108` (`p`) | UI state (+ `set_preview`) |
| Toggle advanced params | `ParamPanel.tsx:326–337` `#panel-advanced` | UI state |
| Tap tempo | `Header.tsx:54–66` `#tap` | `set_transport { tap: true }` |
| Select prev / next tile | (mouse only today) | UI state (`selected`) |
| Solo tile | `Tile.tsx:102` double-click | UI state (`solo`) |
| Destroy selected tile | `Tile.tsx:151–177` `.destroybtn` | `destroy_instance` |
| Arm agent commit | `StageStrip.tsx:52–63` `#armagent` | `arm_agent_commit` |
| Self-capture screenshot | (proposed) | [[console-screenshot]] Phase 1 |

PANIC, COMMIT, and destroy are the dangerous three and get special treatment (see edge
cases). Stage navigation already shares one code path (`EngineApi.liveStep`) for the tap
button and the MIDI binding (`StageStrip.tsx:80–86`) — a hotkey becomes a *third* caller of
the same path, which is exactly the design we want (mash-safe, identical behavior).

## Library choice — is "tanstack hotkeys" real?

**Yes, it exists** — `@tanstack/hotkeys` (core) with a `@tanstack/react-hotkeys` adapter —
but as of mid-2026 it is **alpha/beta (v0.x)**. It is genuinely well-suited on paper:
type-safe template bindings (`"Mod+Shift+S"`), a cross-platform `Mod` key (Cmd/Ctrl), a
singleton Hotkey Manager, Vim-style sequences, and — notably for this request —
**cheatsheet-UI helpers** built in. The fit to "central registry + generated `?` overlay"
is almost exact.

The honest tension: it's pre-1.0 on a live-performance tool where a flaky key handler is a
real-world failure. **Recommendation with rationale:**

1. **Default recommendation — a hand-rolled keymap registry** (~120–180 lines). The
   Console's needs are small and bounded (single-key + a few `Shift`/`Mod` combos, three
   scopes, a generated cheatsheet). A vendored registry has zero supply-chain risk on the
   performance machine, owns the typing/popover/MIDI-learn guards exactly the way LOOM
   needs them, and is the data source for the overlay by construction. This mirrors the
   house instinct in [[console-screenshot]] NFR-1 ("vendored if it's small enough to
   audit") and the project's "pin exact / audit deps that run in the performance browser"
   convention. It also keeps the registry framework-agnostic enough to outlive any one
   React version.
2. **If a library is preferred — `tinykeys`** (~650 B, ~50k weekly downloads, widely used,
   `code`-vs-`key` handled sanely). Tiny, well-understood, returns an unsubscribe for clean
   `useEffect` teardown; pin exact, wrap it in our own registry/scoping/cheatsheet layer
   so the overlay still generates from our metadata, not the lib's.
3. **`@tanstack/hotkeys`** — revisit once it hits a stable 1.0. Its cheatsheet helpers and
   `Mod` handling would let us delete code; today its alpha status is the wrong bet for the
   live path. Note this as a deliberate "reconsider later," not a rejection.

`react-hotkeys-hook` is maintained but its `code`+`key` matching is documented to over-fire,
and `react-hotkeys` (the original) is ~7 years stale — neither is recommended.

**Open question:** registry-vs-`tinykeys` is a ~150-line call; if [[console-ui-refactor]]
lands first it may already establish a pattern this should reuse rather than introduce a
second one.

## Requirements

### Functional

- **FR-1 Central keymap registry.** One module (`src/ui/console/keymap.ts`) defines every
  binding as data: `{ id, keys, scope, when?, group, label, run }`. Nothing else in the
  Console attaches a global `keydown` listener — `ConsoleApp.tsx:97–113` and the Console's
  half of `main.ts:556` collapse into registry entries. The registry is the single source
  of truth for both *behavior* and the *cheatsheet*.
- **FR-2 Scoping.** Three scopes, resolved by priority: **popover-open** (a Mod/Range/Bind
  popover or dialog is mounted) > **focused-panel** (e.g. the param panel has focus) >
  **global**. A binding declares its scope; only bindings whose scope is active fire. Most
  bindings are global; `Escape` is scope-aware (closes the topmost popover, else leaves
  preview).
- **FR-3 Typing guard, centralized.** A keystroke is swallowed (passes through to the
  field) when focus is in an `input`/`select`/`textarea`/`[contenteditable]` — the
  generalized form of today's `ConsoleApp.tsx:101–106` guard, applied once in the registry
  so every field handler (rename, dialogs, range, numeric edit) keeps working untouched.
- **FR-4 Bind the major actions** from the table above. Proposed defaults (mnemonic,
  single-key where safe, modifier where dangerous):
  - `i` rack · `p` preview · `a` advanced params · `t` tap tempo (preserve existing `i`/`p`).
  - `[` / `]` step LIVE prev/next; `j` / `k` (or arrows) select prev/next tile; `f` solo
    selected; `s` stage/unstage selected.
  - `Enter` (or `c`) COMMIT — **with a guard** (see FR-7); `u` unstage.
  - `.` (period) or `Shift+P` PANIC; pressing it again RESUMEs — deliberately *not* a bare
    common letter (edge cases below).
  - `?` (i.e. `Shift+/`) opens/closes the cheatsheet; `Escape` closes it.
  - Reserve `Shift+S` for self-capture if [[console-screenshot]] lands.
  - These are *proposals* — the exact letters are an open question for the performer.
- **FR-5 `?` cheatsheet overlay, generated from the registry.** A single MUI overlay
  (Dialog/Backdrop) lists every binding grouped by `group` (Transport, Stage, Tiles,
  Panels, Safety, Help), showing `keys` + `label` straight from FR-1 data. Because it
  renders the registry, **it cannot drift** — adding a binding adds a cheatsheet row for
  free. Closes on `?`, `Escape`, or backdrop click.
- **FR-6 One-screen cheatsheet.** Lay the groups out in columns so the overlay fits a
  ~1080p viewport without scrolling at the current binding count; only when the list grows
  "really big" does it gain internal scroll. (Mirrors the ask's "fits without scrolling
  unless it gets really big.")
- **FR-7 Dangerous-action confirmation.** COMMIT, PANIC, and destroy must not fire from a
  single stray keystroke. Options (decision pending): a modifier (`Shift+`/`Mod+`), a
  double-tap window, or an inline "press again to confirm" toast. PANIC specifically should
  stay *fast* (it's an emergency), so it likely wants a distinct, hard-to-mistype key
  rather than a confirm step — unlike COMMIT/destroy.
- **FR-8 Discoverability without the overlay.** Where a button already has a `title`
  tooltip (`Header.tsx`, `StageStrip.tsx`, `ParamPanel.tsx`), append its hotkey (`"(p)"`,
  `"(i)"` already exist on RACK/PREVIEW) — sourced from the registry so tooltip and
  cheatsheet stay in sync.

### Non-functional

- **NFR-1 Never go black.** Hotkeys are Console-only; they issue the same engine commands
  the buttons do. No new render-path code, no change to swap/HMR/render. PANIC via key uses
  the identical `panic`/`resume` request the button uses (`Header.tsx:307`).
- **NFR-2 No perf regression.** One delegated `window` listener (the registry), not N
  listeners. The Console's own UI paint rate (`#uifps`, `Header.tsx:103–117`) must not
  move; cf. [[console-performance-stability]].
- **NFR-3 If a dependency is added, pin it exact** (per repo convention; `three` is the
  precedent) and prefer vendoring per [[console-screenshot]] NFR-1.
- **NFR-4 Accessibility / layout.** The overlay is keyboard-dismissable and focus-trapped;
  bindings never shadow browser/OS essentials (`Mod+R`, `Mod+L`, devtools).
- **NFR-5 Determinism for validators.** Bindings drive existing engine commands, so the m3
  (stage/commit/PANIC) and m5 (input rack, MIDI-learn) suites can additionally assert the
  *key path* reaches the same code path the buttons hit, without new engine surface.

## Surfaces

- **Console.** All of the above. The `?` overlay; per-button tooltip hotkey hints.
- **Engine / MCP.** None. Explicitly out of scope: this is human-cockpit ergonomics. Agent
  actions stay on MCP tools. (The one adjacency is [[console-screenshot]]'s `s` key, which
  this registry would *host* but whose capture logic lives in that request.)

## Implementation plan

### Phase 1 — the registry + scoping (no new bindings yet)

1. `src/ui/console/keymap.ts`: the registry type, the global delegated `keydown` listener,
   the typing guard (FR-3), and scope resolution (FR-2). A `useKeymap()` hook for React.
2. Port the **existing** three behaviors into registry entries: `i`, `p`, `Escape`
   (from `ConsoleApp.tsx:97–113`) and Console-side `t` tap (unify with `Header`'s `#tap`).
   Net behavior identical — this is the safe refactor that proves the layer.

### Phase 2 — the `?` cheatsheet overlay

1. `src/ui/console/HotkeyCheatsheet.tsx`: MUI overlay rendering grouped registry data
   (FR-5/6). Bound to `?`/`Escape` via the registry.
2. Append hotkey hints to existing button tooltips from the registry (FR-8).

### Phase 3 — bind the major actions

1. Add the FR-4 bindings, each delegating to the existing handler/engine command (stage,
   unstage, commit, live_step, panic/resume, advanced, solo, select, destroy).
2. Add the FR-7 confirmation strategy for COMMIT / PANIC / destroy.

### Phase 4 — acceptance

- Extend **m3** (already drives a real Console): assert `[`/`]` step LIVE, the stage/commit
  keys land via the same path the buttons do, and PANIC-by-key arms/clears like the button.
- Extend **m5**: assert hotkeys don't fire while MIDI-learn is armed (edge case below) and
  don't fire while typing in the rack's fields.
- New Console unit test: registry scope resolution + typing guard + cheatsheet renders one
  row per binding (drift guard — fails if a binding has no label/group).

Estimated size: registry+scoping ~150 lines · cheatsheet ~80 · bindings ~60 · tests ~80.

## Edge cases & interactions

- **Typing in inputs** (rename `Tile.tsx:76`, dialogs, range, numeric edit): swallowed by
  FR-3. The rename box already `stopPropagation()`s (`Tile.tsx:77`) — keep that; the
  central guard is the belt to that braces.
- **Popover open** (`ModPopover`, `RangePopover`, `BindPopover`, FX/Projects dialogs):
  popover scope wins (FR-2); `Escape` closes the popover before it does anything global.
  These already take `onClose` (`ModPopover.tsx:135`), so the registry routes `Escape` to
  the topmost.
- **MIDI-learn mode armed** (`s.midi.learning != null`, e.g. `StageStrip.tsx:93`,
  `BindPopover.tsx:37–41`): the human is about to press a *controller* button, but might
  also touch the keyboard. Global hotkeys should **suspend** (or at minimum not fire
  command-issuing ones) while a learn is armed, so a stray `s`/`c` doesn't stage/commit
  mid-learn. Add this as a scope condition.
- **PANIC during everything**: the key path is the same `panic`/`resume` request the button
  issues; works regardless of staged/crossfade state. COMMIT is correctly blocked while
  panicked at the engine and the button (`StageStrip.tsx:69` `disabled={... || s.panicked}`)
  — the hotkey must honor the same `when` so `Enter` does nothing mid-PANIC.
- **No selection**: tile-scoped keys (stage/solo/destroy) need a selected tile; with none,
  they no-op (or select the first). Stage-strip keys (commit, live_step) are global.
- **`live_step` mash-safety**: already designed for it (`StageStrip.tsx:80–86`); rapid
  `[`/`]` is the same as a knob being twiddled — fine.
- **Engine-page `t` (`main.ts:556`)**: leave it (different page, harmless), but document
  that the *Console's* `t` now also taps so the two pages agree.
- **Two Consoles / focus**: each Console window owns its own registry; no cross-window
  coordination needed.

## Open questions

1. **Library vs. hand-rolled** — lean hand-rolled/vendored (or `tinykeys` if a dep is
   wanted); revisit `@tanstack/hotkeys` after its 1.0. Final call may defer to
   [[console-ui-refactor]] if it lands first and sets a pattern.
2. **The actual key letters** (FR-4) — needs a performer's muscle-memory input; the table is
   a starting proposal, not a verdict.
3. **Dangerous-action UX** (FR-7) — modifier vs. double-tap vs. confirm-toast, and whether
   PANIC is exempt (it probably should be: speed > confirmation for the emergency hatch;
   see [[panic-safe-scene-redesign]]).
4. **Cheatsheet trigger on non-US keyboards** — `?` is `Shift+/` on US layouts but moves
   elsewhere; bind by `key === "?"` (layout-aware) rather than `code` so it follows the
   physical `?`.
5. **Per-user remapping** — out of scope for v1 (ship sane defaults); the data-driven
   registry makes a future remap UI cheap, so don't preclude it.
</content>
</invoke>
