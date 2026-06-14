# Console & Content Housekeeping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute the roadmap's Housekeeping block: cull three scenes, group params on the big scenes, default new modulators to 20 s, 2× tile thumbnails, and make the whole header+subheader the drop-to-go-live target.

**OUT OF SCOPE — parallel workstream:** double-click instance rename is being built by a parallel session on this same branch. Its uncommitted files (`packages/sidecar/src/protocol.ts`, `packages/engine-app/src/engine-api.ts`, `packages/engine-app/src/session.ts`, `packages/runtime/src/stage.ts`, `packages/runtime/test/stage.test.ts`, possibly `Tile.tsx`/`TileGrid.tsx`/`ConsoleApp.tsx`) must NEVER be staged by this plan. **Every commit uses an explicit file list — no `git add -A` / `git add .`. Check `git status --short` before each commit.**

**Architecture:** Scene work is pure `content/` edits (scenes auto-globbed; CATALOG regenerates on typecheck); persisted value files are key-migrated in the same commit as each param rename so tuned looks survive restart. Console work is small, file-local edits.

**Tech Stack:** React 19 + MUI 7 (Console), vitest, Playwright validators.

**Verification gates (run from `loom/`):** `pnpm typecheck`, `pnpm test`, per-task validators, and `pnpm validate` (all suites, stops on first failure) at the end. Validators pin `pulse` and use isolated ports — safe alongside a live session.

**Ground truth discovered up front (do not re-derive):**
- Only `pulse`'s params are validator-asserted (m1 ranges, m2 manifest subset, m5 binds `pulse.punch` + asserts `values/pulse.json`). `validate-m6` creates `gradient`/`lava` but only asserts the auto-declared `palette.source`. So **pulse stays untouched**; fireflies/mandelbrot/mandelbloom params are free to rename.
- `hello` is asserted only at `scripts/validate-m3.mjs:163` (`availableScenes`). `vinyl`/`pulse-glitch` appear in no validator. `validate-m0.mjs:142` only names an artifact file `m0-1-hello.png` (cosmetic, leave it).
- `validate-m4.mjs:218-226` dispatches drag events on `#stagestrip` with `bubbles: true` — drop handlers may move to a parent wrapper.
- `PREVIEW_W/H = 640×360` (`session.ts:16`) — thumbnails can capture at full preview res.
- `live.scene.ts` re-exports `pho-nebula` (a survivor).

---

### Task 1: Scene cull (hello, pulse-glitch, vinyl)

**Files:**
- Delete: `content/scenes/hello.scene.ts`, `content/scenes/pulse-glitch.scene.ts`, `content/scenes/vinyl.scene.ts`
- Delete: `content/state/values/pulse-glitch.json`, `content/state/values/vinyl.json`
- Modify: `scripts/validate-m3.mjs:163`, `.claude/skills/module-authoring/SKILL.md:32` (+ any living-doc hits from the grep step)
- Auto-regen: `content/CATALOG.md` (via `pnpm typecheck`)

- [ ] **Step 1: Grep living docs for the dead scene names**

Run from `loom/`: `rg -n "pulse-glitch|hello|vinyl" .claude docs/architecture.md docs/requirements-v1.md ../CLAUDE.md` — history docs (`docs/history/`) stay verbatim. Update each living hit so no doc names a dead scene (assets like `VinylDJHippo.png` stay — `vinyl-zoom` uses them).

- [ ] **Step 2: Update the m3 availableScenes assertion**

`scripts/validate-m3.mjs`: `["hello", "lava", "pulse"]` → `["gradient", "lava", "pulse"]`.

- [ ] **Step 3: Update module-authoring SKILL.md line 32**

Replace `(see \`pulseRings\` ← pulse/pulse-glitch)` with a phrasing that doesn't cite the dead scene, keeping the extraction policy intact.

- [ ] **Step 4: Delete the files**

```powershell
git rm content/scenes/hello.scene.ts content/scenes/pulse-glitch.scene.ts content/scenes/vinyl.scene.ts content/state/values/pulse-glitch.json content/state/values/vinyl.json
```

- [ ] **Step 5: `pnpm typecheck`** — green; CATALOG.md loses the three scenes.

- [ ] **Step 6: `pnpm validate:m3`** — green with the new scene list.

- [ ] **Step 7: Commit (explicit paths only)**

```bash
git add content/scenes content/state/values content/CATALOG.md scripts/validate-m3.mjs .claude/skills docs/architecture.md
git commit -m "housekeeping: cull hello/pulse-glitch/vinyl scenes (pulse stays as validator workhorse)"
```
(Drop paths from the list that step 1 didn't actually touch; `git status --short` first to confirm nothing from the rename workstream is staged.)

### Task 2: Param-group pass over surviving scenes

Dotted prefixes render as collapsible accordions (`ParamPanel.tsx`). Decisions:
- **pulse** — untouched (validator-locked). **gradient** (1 param), **lava** (6 params, one coherent blob object) — grouping not necessary, stay flat. **vinyl-zoom**, **pho-nebula** — already grouped.
- **fireflies, mandelbrot, mandelbloom** — group as below; migrate each scene's `content/state/values/<scene>.json` keys in the same commit.

**Files:**
- Modify: `content/scenes/fireflies.scene.ts`, `content/scenes/mandelbrot.scene.ts`, `content/scenes/mandelbloom.scene.ts`
- Modify: `content/state/values/fireflies.json`, `content/state/values/mandelbrot.json`, `content/state/values/mandelbloom.json`

- [ ] **Step 1: fireflies — rename param paths** (only the first string arg changes; variables/wiring untouched). Add the grouping comment used by other grouped scenes. New paths: `swarm.size`, `swarm.speed`, `swarm.variety`, `swarm.count`, `blink.twinkle`, `blink.sparkle`, `fx.glitch`, `fx.trail`; `glow` and `flare` stay flat (the two ride-live knobs).

- [ ] **Step 2: fireflies — migrate persisted keys** in `values/fireflies.json` (read it first; rename only keys that exist; `input.*`/`palette.*` untouched).

- [ ] **Step 3: mandelbrot — rename + migrate.** New paths: `zoom.point`, `zoom.dive`, `zoom.depth`, `color.palette`, `color.drift`, `color.cycle`, `color.bands`; `iter` stays flat (quality knob). Migrate `values/mandelbrot.json`.

- [ ] **Step 4: mandelbloom — rename + migrate.** New paths: `zoom.dive`, `zoom.depth`, `garden.warp`, `garden.amount` (was `garden`), `garden.bloom`, `fx.trail`, `fx.glitch`; `iter`, `scroll`, `rim` stay flat. Migrate `values/mandelbloom.json`. (mandelbloom may be running live — rename triggers a contained NFR-5 rebuild; in-memory tuned values for renamed paths fall back to defaults until restart, acceptable.)

- [ ] **Step 5: `pnpm typecheck`** — green; CATALOG param lists update.

- [ ] **Step 6: Commit (explicit paths only)**

```bash
git add content/scenes/fireflies.scene.ts content/scenes/mandelbrot.scene.ts content/scenes/mandelbloom.scene.ts content/state/values/fireflies.json content/state/values/mandelbrot.json content/state/values/mandelbloom.json content/CATALOG.md
git commit -m "housekeeping: param groups for fireflies/mandelbrot/mandelbloom (+state key migration)"
```

### Task 3: Modulator default = 20 seconds

**Files:** `packages/engine-app/src/ui/console/ModPopover.tsx:40-41,78`

- [ ] **Step 1:** `useState("4")` → `useState("20")`; `useState<"beats" | "seconds">("beats")` → `("seconds")`; `Number(rate) || 4` → `Number(rate) || 20`. The seeding `useEffect` (already-modulated param) still overrides — unchanged.

- [ ] **Step 2:** `pnpm typecheck` — green. Commit:

```bash
git add packages/engine-app/src/ui/console/ModPopover.tsx
git commit -m "console: new modulators default to 20 s (was 4 beats)"
```

### Task 4: Instance thumbnails 2×

**Files:**
- Modify: `packages/engine-app/src/ui/console/TileGrid.tsx:91` — `minmax(240px, 1fr)` → `minmax(480px, 1fr)`
- Modify (CONDITIONAL): `packages/engine-app/src/engine-api.ts` — capture resolution

- [ ] **Step 1:** TileGrid grid template → `repeat(auto-fill, minmax(480px, 1fr))`. **Before editing, check `git status` — if the rename workstream has TileGrid.tsx dirty, coordinate: make only this one-line edit and stage with `git add -p`-equivalent care, or wait for their commit.**

- [ ] **Step 2 (conditional):** capture res in `engine-api.ts`: mirror canvas `320/180 → 640/360`; `thumbnails(width = 320, height = 180)` → `(width = 640, height = 360)`; remove the staged `×2` special case (it would exceed the 640×360 preview source — staged thumbs are already that size). **Only if `engine-api.ts` is clean in `git status`** (the rename workstream owns it right now). If dirty: skip, note as follow-up — tiles upscale 320→480px slightly soft until then.

- [ ] **Step 3:** `pnpm typecheck`, `pnpm validate:m4` — green. Commit only the files this task edited.

```bash
git add packages/engine-app/src/ui/console/TileGrid.tsx
git commit -m "console: 2x instance tiles (thumbnails at full 640x360 preview res)"
```

### Task 5: Drop-to-go-live target = whole header + subheader

**Files:**
- Create: `packages/engine-app/src/ui/console/StageDropZone.tsx`
- Modify: `packages/engine-app/src/ui/console/StageStrip.tsx` (remove drag handlers/outline/hint)
- Modify: `packages/engine-app/src/ui/console/ConsoleApp.tsx` (wrap Header + StageStrip)

- [ ] **Step 1: New StageDropZone component** — `Box position:relative` carrying the `onDragOver`/`onDragLeave`/`onDrop` logic currently in StageStrip (drop = stage + commit, never gated), dashed warning outline while dragging, and an absolutely-positioned centered "drop to go LIVE" overlay (`pointerEvents: none`, dark scrim). `onDragLeave` must ignore child-element leaves: `if (e.currentTarget.contains(e.relatedTarget as Node)) return;`.

- [ ] **Step 2: StageStrip sheds drop logic** — remove dragOver state, the three drag props, outline sx, hint Typography. Keep `id="stagestrip"` (validator dispatch target; events bubble to the zone) and everything else. Update its doc comment.

- [ ] **Step 3: ConsoleApp wraps the top:**

```tsx
          <StageDropZone>
            <Header session={session} onToggleRack={() => setRackOpen((o) => !o)} />
            <StageStrip session={session} />
          </StageDropZone>
```
(ConsoleApp may be dirty from the rename workstream — same coordination rule as Task 4.)

- [ ] **Step 4:** `pnpm typecheck`, `pnpm validate:m4` (drop dispatch bubbles into the zone) — green. Commit:

```bash
git add packages/engine-app/src/ui/console/StageDropZone.tsx packages/engine-app/src/ui/console/StageStrip.tsx packages/engine-app/src/ui/console/ConsoleApp.tsx
git commit -m "console: whole header+subheader is the drop-to-go-live target"
```

### Task 6: Full gates + bookkeeping

- [ ] **Step 1:** `pnpm typecheck && pnpm test`, then `pnpm validate` (all suites; m5 has flaked once before on the envelope-drain window — rerun once before investigating).

- [ ] **Step 2:** Move the Housekeeping block from `docs/roadmap.md` Remaining into the Shipped table as one row; append a ≤6-line SHIPPED entry to `DECISIONS.md` (date, gates run, deviations, stumbles). Don't claim the rename item — the parallel workstream ships that.

- [ ] **Step 3:** Commit:

```bash
git add docs/roadmap.md DECISIONS.md docs/superpowers/plans/2026-06-11-housekeeping.md
git commit -m "housekeeping shipped: roadmap + decisions bookkeeping"
```
