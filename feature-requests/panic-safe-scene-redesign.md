# Feature request: PANIC + safe-scene redesign — no default hatch scene, split PANIC button

Status: requested (2026-06-13) · Owner: unassigned

## Summary

The shipped PANIC modes feature ([[panic-scene]], DECISIONS 2026-06-12) boots a
dedicated **always-warm "panic" instance** built from `content/scenes/safe.scene.ts`
(a slow-breathing radial gradient) and pins it as the SAFE target out of the box. The
human's gripe: that default safe scene is dead weight — a boring, always-present tile
nobody asked for, occupying a slot and implying scene-panic is the expected behavior
when really it's an opt-in.

This request reshapes the safe-scene side of PANIC around what the human actually
wants:

1. **No default safe scene.** Don't auto-build/pin a warm panic instance at boot;
   delete the boring `safe.scene` content. PANIC's default is **hold** (it already is
   internally — see Current state), and **scene-panic becomes opt-in**: it's available
   only once the human designates an existing instance as the SAFE target.
2. **Default safe-scene mode is the hold toggle.** With no SAFE target designated,
   the only armed behavior is HOLD; SAFE SCENE is offered as an escalation the human
   opts into by picking a target.
3. **PANIC becomes a split button** — the big red PANIC/RESUME button with an attached
   `▾` dropdown carrying the mode/target controls (arm hold · arm scene → pick target ·
   re-arm), instead of today's separate `HOLD | SAFE SCENE` button-group plus a loose
   `(none)`-defaulting `<select>` sitting in the header.

This is a UX + defaults change, not a new safety mechanism. The engine's panic
*machinery* (output-override scene-panic, hold-fallback, destroy/rename protection,
human-only trust tier) all stays; we're removing the boot-default warm instance and
collapsing the Console controls into one affordance.

## Current state (grounded)

### The panic machinery (shipped, keep it)

- **Stage** (`packages/runtime/src/stage.ts:117-165`) is pure state: `panic(mode,
  panicId?)` sets `panicState: "hold" | "scene" | null` and `panicId`. Scene-panic is
  an **output override** — `tick()` returns `{ mode: "panic-scene", panic, live }`
  with the LIVE pointer untouched (line 161-163); `hold` returns `{ mode: "hold" }`
  (line 165). `resume()` clears both (line 131-134). Re-press only escalates hold→scene
  (line 126); scene→hold is a no-op. **`panic("scene", null)` already falls back to
  hold** (lines 119-128) — the no-target case is a first-class, tested path today.
- **EngineApi** (`packages/engine-app/src/engine-api.ts`): the `panic` handler
  (lines 606-614) computes `panicId = effective === "scene" ? panicInstanceId() : null`
  and calls `stage.panic(panicId != null ? "scene" : "hold", panicId)` — so **a missing
  SAFE target already degrades a scene-arm to hold**. `armedPanicMode` defaults to
  `"hold"` (line 202). Snapshot carries `panicked`, `panicMode`, `panicActive`,
  `panicScene` (lines 896-899). Human-only verbs: `panic`, `resume`, `arm_panic_mode`,
  `set_panic_instance` (lines 68-71). Destroy/rename of a `pinned === "panic"` instance
  is refused for everyone (lines 552-553, 564-565).
- **PanicController** (`packages/engine-app/src/panic-controller.ts`): owns the warm
  instance. `tryBuild(def)` builds/HMR-rebuilds instance id `"panic"` and sets
  `pinned = "panic"` (lines 55-72); `setInstance(id)` moves the ⛑ designation onto any
  already-warm instance with no rebuild + persists its scene name (lines 80-88);
  `instanceId()` returns the pinned id or `"panic"` if it exists, else `null` (line 92);
  `info()` reports `{ name, status, error }` (lines 95-102). The boot default name comes
  from `panic.scene.ts` via `initialSceneName` (constructor, line 41).
- **Boot wiring** (`packages/engine-app/src/main.ts`): imports
  `content/scenes/panic.scene` (line 24), constructs the controller with
  `initialSceneName: panicScene?.name ?? "panic"` (lines 306-310), and **unconditionally
  `panicController.tryBuild(panicScene)` right after `trySwapLive`** (line 447), then
  re-points to a persisted pick if one exists (lines 449-451). Persistence:
  `StateKey.panic` stores `{ scene: panicController.sceneName }` (line 177).
- **The two scene files**: `content/scenes/panic.scene.ts` is a one-line
  `export { default } from "./safe.scene"` (the `live.scene.ts` twin pointer);
  `content/scenes/safe.scene.ts` is the boring radial gradient (`name: "safe"`, ~50
  lines) — **this is the content the human wants gone**.
- **The protocol** (`packages/sidecar/src/protocol.ts`): `PanicMode = ["hold","scene"]`
  (line 288), `PanicArgs` / `ArmPanicModeArgs` / `SetPanicInstanceArgs` (lines 292-300),
  `Entry.pinned` is `z.literal("panic").nullable()` (lines 529-530), `PanicSceneInfo`
  (lines 561-569), snapshot fields (lines 583-589).

### The Console controls (the part to redesign)

`packages/engine-app/src/ui/console/Header.tsx`, `PanicControls` (lines 237-313):

- A `ButtonGroup#panicmode` with two buttons — `HOLD` (`#panicmode-hold`) and
  `SAFE SCENE` (`#panicmode-scene`, shows `⚠` + warning color when `panicScene.status
  === "error"`).
- A loose `NativeSelect#panicscene` listing **every instance** (`{i.id} · {i.scene}`)
  to designate the SAFE target; shows `(none)` only when nothing is pinned.
- The big red `Button#panic` (PANIC ↔ RESUME), executing the armed `mode` on press.
- Arming persists to `localStorage["loom.panicMode"]` and re-arms the engine on connect
  (lines 244-251); flipping the arm while panicked re-fires `panic` (the hold→scene
  escalation, lines 256-257).

The SAFE badge tile lives in `Tile.tsx:141-150` (`⛑ SAFE`, shown when
`inst.pinned === "panic"`).

### Key finding: "default to hold" is already true

The engine already boots armed `hold` and already degrades a scene-arm to hold when
there's no usable SAFE target. So requirement (2) is **not an engine change** — it's
the natural state once requirement (1) removes the boot-default warm instance. The work
is: stop auto-building the hatch scene, delete its content, and reflect "scene-panic is
opt-in / unavailable until you pick a target" honestly in the UI.

## What "no default safe scene" implies (the decision to make)

Removing the boot-default warm instance means **at boot there is no `pinned: "panic"`
instance and `panicInstanceId()` returns `null`** until the human designates one.
Consequences, all already supported by the machinery:

- Arming SAFE SCENE with no target → PANIC holds (the FR-7 fallback, today's tested
  no-instance path). The UI must say so rather than implying a scene cut.
- `panicScene.status` is `"error"` / `name` is empty when nothing is designated — or we
  introduce a cleaner **"none"** status (see open questions) so the Console can show
  "scene-panic: pick a target" rather than a scary `⚠`.
- Scene-panic becomes **opt-in**: spawn/keep a tile you trust → designate it via the
  dropdown → SAFE SCENE is now a real option. This matches how LIVE/STAGED already work
  (pointers over existing instances) and the 2026-06-12 decision that made the SAFE
  target "a movable designation over existing instances."

This is the recommended reading of the ask: **default = hold; scene mode is something
the human turns on by choosing a target from the new dropdown.** It deletes dead
content without losing any capability.

## Requirements

### Functional

- **FR-1 No boot-default safe scene.** Don't auto-build or pin a warm panic instance at
  boot. `main.ts` drops the unconditional `tryBuild(panicScene)` (line 447). At a fresh
  boot, `get_session.panicScene` reports "none designated" and no instance carries
  `pinned: "panic"`.
- **FR-2 Delete the boring safe scene content.** Remove `content/scenes/safe.scene.ts`.
  Decide the fate of `content/scenes/panic.scene.ts` (the pointer) — see open questions;
  the recommendation is to delete it too and drop the `live.scene.ts`-twin concept,
  since designation is now purely runtime over existing instances.
- **FR-3 Default armed mode is hold.** Unchanged engine default; the UI presents HOLD as
  the resting state and SAFE SCENE as opt-in-once-a-target-exists.
- **FR-4 Scene-panic is opt-in via designation.** SAFE SCENE is selectable/armable only
  when a SAFE target is designated; with none, arming SAFE SCENE either is disabled or
  clearly degrades to hold (state it in the button title). Designating any instance
  (`set_panic_instance`) lights it up — no rebuild, exactly as today.
- **FR-5 PANIC split button.** Replace the separate `ButtonGroup` + loose `<select>`
  with a **split button**: the primary `PANIC`/`RESUME` action (executes the armed
  mode) + an attached `▾` that opens a menu containing the real human-only panic verbs
  (below). The menu is the only place mode/target live; the header reads as one PANIC
  control.
- **FR-6 No regressions to the safety net.** Output-override scene-panic, hold-fallback,
  re-press escalation (hold→scene), destroy/rename protection of the designated target,
  and the human-only trust tier all behave exactly as shipped.
- **FR-7 Honest "unavailable" signalling.** When SAFE SCENE can't fire (no target, or a
  designated target that has errored), the menu/button says so plainly ("scene-panic:
  pick a SAFE target") instead of a generic warning — distinguishing *not chosen* from
  *chosen but broken*.

### The split-button menu (grounded in the real verbs)

Today's human-only panic verbs are `panic`, `resume`, `arm_panic_mode {mode}`, and
`set_panic_instance {instance}`. The `▾` menu maps to exactly these:

- **Arm: Hold** → `arm_panic_mode {mode:"hold"}` (radio with the next item).
- **Arm: Safe scene → [target picker]** → `arm_panic_mode {mode:"scene"}` plus an inline
  list of instances feeding `set_panic_instance {instance}`. Choosing a target *and*
  arming scene in one gesture is the natural flow. Disabled / shows "pick a target" when
  none is designated.
- **Clear SAFE target** (optional) → there is no "unset" verb today; either add one or
  treat re-designating as the only way to move it. (Open question.)
- The primary button click = `panic {mode}` (or `resume` when panicked); flipping the
  arm while panicked re-fires `panic` for the hold→scene escalation (today's behavior at
  Header.tsx:256-257).

"Re-arm" is just selecting the other radio; there's no distinct re-arm verb.

### Non-functional

- **NFR-1 Validator DOM contract.** `validate-panic.mjs` drives `#panicmode-hold`,
  `#panicmode-scene`, `#panicscene` (select), and `#panic`, and asserts a default
  `panic`/`safe` warm tile (lines 176-185), `panicScene.name === "safe"` (line 181),
  and "console shows the default SAFE tile" (line 184-185). **This suite must be
  rewritten** alongside the feature: the boot-default-warm-tile checks (the FR-3/FR-11
  assertions) become "no SAFE target at boot," and the new split-button selectors
  replace the button-group/select ids. Whatever stable ids the split button exposes
  (e.g. `#panicmenu`, menu items) must be wired into the validator. See [[panic-scene]]
  for the original FR numbering the suite references.
- **NFR-2 Persistence.** `StateKey.panic` currently persists the designated scene name
  so the boot default reflects a runtime pick. With no boot-default instance, decide
  whether designation persists across restarts at all (a runtime designation over an
  ephemeral instance id can't auto-rebuild without the pointer-scene concept). Simplest:
  **don't persist** — a fresh session boots to hold, the human re-designates if they
  want scene-panic. (Open question — changes the 2026-06-12 persistence decision.)
- **NFR-3 No new trust surface.** Still human-only; agents observe via `get_session`
  only. A boot with no SAFE target means `get_session.panicScene` must encode "none"
  cleanly so the agent guidance ("`panicActive` non-null → stop touching the live path")
  is unaffected.

## Implementation plan

### Phase 1 — drop the boot default (engine)

1. `main.ts`: remove the unconditional `panicController.tryBuild(panicScene)` (line 447)
   and the persisted-pick re-point (lines 449-451) if NFR-2 lands on "don't persist";
   drop the `panic.scene` import (line 24) and the `initialSceneName` plumbing.
2. `PanicController`: make a no-designation state first-class — `instanceId()` returns
   `null` until `setInstance` is called; `info()` reports a clean "none" (see Phase 3).
   `tryBuild` and the `PANIC_ID = "panic"` boot instance go away (the warm hatch is no
   longer auto-created); `setInstance` (designation over existing instances) stays.
3. Delete `content/scenes/safe.scene.ts`; resolve `content/scenes/panic.scene.ts` per
   FR-2 / open questions. Update `main.ts`'s scene-barrel HMR comment block
   (lines 592-611) that keeps the pinned hatch warm.

### Phase 2 — protocol / status surface

1. `protocol.ts`: extend `PanicSceneInfo.status` (line 564) with a `"none"` variant (or
   model designation as `name: string | null`) so "not chosen" ≠ "chosen but broken".
   No `PanicMode` change — `hold`/`scene` stay.
2. Reflect it in the snapshot builder and `window.__loom` (`debug-surface.ts`) so the
   validator can assert the new boot state.

### Phase 3 — Console split button (`Header.tsx`, the visual change)

1. Replace `PanicControls` (lines 237-313): a MUI split button (`ButtonGroup` with a
   primary `Button#panic` + an icon `Button` carrying `▾` that opens a `Menu`/`Popper`).
2. Menu contents = the verb mapping above (arm hold / arm scene → target picker / clear).
   Keep `localStorage["loom.panicMode"]` re-arm-on-connect (lines 244-251) and the
   panicked-escalation re-fire (lines 256-257).
3. Honest "unavailable" copy when no/broken target (FR-7); the `⚠` only for *broken*,
   "pick a target" for *none*.
4. `Tile.tsx` ⛑ SAFE badge (lines 141-150) is unchanged — it shows whenever an instance
   is designated, which is now simply "less often" (only after opt-in).
5. **Visual PR** per CLAUDE.md "Screenshots in PRs" — include before/after of the header
   PANIC control. Coordinate with [[console-ui-refactor]] (the React/MUI Console is its
   territory) and [[keyboard-shortcuts]] (PANIC has no documented shortcut today; a split
   button is a natural place to surface one).

### Phase 4 — acceptance (`validate-panic.mjs`)

1. Rewrite the boot assertions: no `pinned:"panic"` instance at boot, `panicScene`
   reports "none," no `⛑ SAFE` tile until designation (replaces lines 176-185).
2. Drive the new split-button selectors (arm hold/scene, designate, PANIC/RESUME) in
   place of `#panicmode-*` / `#panicscene`.
3. Keep the still-valid behaviors: scene-panic cuts to a *designated* instance and
   leaves LIVE unmoved; RESUME hard-cuts back; engine keeps ticking under scene-panic;
   hold→scene escalation; **broken-target → hold fallback**; destroy/rename protection
   of the designated target.
4. The "broken `panic.scene.ts`" sub-test (lines 303-334) is reframed: there's no boot
   default to break, so the broken-target case becomes "designate an instance whose
   scene then throws on rebuild → scene-panic falls back to hold."

## Edge cases & interactions

- **`panicActive` while reconfiguring.** Re-designating the SAFE target *during* an
  active scene-panic: `setInstance` moves `pinned` but doesn't re-route Stage. Define
  it — recommend the change takes on the next PANIC (don't yank the output mid-hatch),
  matching today where designation is independent of the active directive.
- **The protected pinned instance is gone at boot.** With no auto-pinned instance,
  nothing is destroy/rename-protected until the human opts in — that's fine and
  intended. Once designated, the protection (engine-api.ts:552, 564) kicks in exactly
  as today.
- **Designated target destroyed externally / errors.** Stage's defensive
  `onInstanceDestroyed` already degrades scene-panic→hold if the routed id vanishes
  (stage.ts:142-147); the controller's health flips to "broken," and FR-7 copy shows it.
- **Arm SAFE SCENE with no target, then PANIC.** Holds (the tested fallback). The split
  button should make this hard to do by accident (disable/explain the scene arm).
- **Re-press escalation with no target.** hold→scene with no target stays hold (Stage
  no-ops the missing-instance scene path). Consistent.
- **Agent observation.** With no target, `get_session.panicScene` must read as "none";
  `panicActive` semantics (the "stop touching the live path" rule in `.claude/CLAUDE.md`)
  are unchanged.

## Resolved decisions

1. **"Default to hold" needs no engine change** — the engine already boots `hold` and
   already degrades a target-less scene-arm to hold. Requirement (2) is satisfied by
   removing the boot-default warm instance, not by new logic.
2. **Scene-panic stays in the model, made opt-in** — we delete the *default* scene, not
   the *capability*. Designation over existing instances (the 2026-06-12 decision) is the
   on-ramp; this is strictly less machinery, not more.
3. **Split button over header clutter** — collapsing the button-group + loose select into
   one PANIC + `▾` control reduces the always-on chrome and stops implying scene-panic is
   the expected mode.

## Open questions

1. **Keep or delete `content/scenes/panic.scene.ts`?** It's the `live.scene.ts`-twin
   pointer that gave a designation-by-file. With runtime-only designation and no boot
   default, it's vestigial — recommend deleting it and the pointer concept. But if
   "ship a repo with a known-good hatch you *can* opt into" has value, keep the file
   (pointing at, say, `gradient`) and add a one-click "use repo default safe scene"
   action instead of auto-building it. **Needs the human's call.**
2. **Persist the designation?** (NFR-2) Recommend no — fresh boot = hold, re-designate
   per session. This **changes the 2026-06-12 persistence decision** ("Persisting the
   designated instance's scene name lets the boot default reflect it across a restart").
3. **Add a "clear SAFE target" verb?** There's no unset today. Needed only if the menu
   offers an explicit "remove target." Could be `set_panic_instance {instance: null}` or
   a new verb.
4. **Should arming SAFE SCENE be disabled or just degrade?** Disable (greyed, "pick a
   target") is clearer; degrade-to-hold-silently matches today's engine but hides intent.
   Recommend disable + inline picker in the menu.
5. **Exact split-button DOM ids** for the validator (NFR-1) — settle them with
   [[console-ui-refactor]] so both tickets agree on stable selectors.

## DECISIONS.md entries this changes

- **2026-06-10 — post-v1 candidate: PANIC modes (safe scene)** (line 81) and
  **2026-06-12 — Better panic button** (line 480): both describe the boot-default warm
  instance built from `panic.scene.ts` and the persisted designation. This request
  removes the boot default and (likely) the persistence — append a new decision recording
  the shift to "no default hatch scene; scene-panic is opt-in via runtime designation;
  PANIC is a split button." The earlier "movable designation over existing instances"
  decision is *kept and extended* (it's now the only designation path).

## Out of scope — future candidates

- A PANIC keyboard shortcut and its discoverability — track under [[keyboard-shortcuts]].
- Multiple named/saved SAFE targets or a per-project default — the designation is
  per-session; project-level SAFE config is a separate idea.
- Any change to hold semantics (freeze) or the agent trust tier.
