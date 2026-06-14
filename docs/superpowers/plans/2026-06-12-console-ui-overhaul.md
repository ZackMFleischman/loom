# Console UI Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Effect enable/disable with optional fade (MIDI-mappable), modulator on/off toggle (MIDI-mappable), vertically-concise param widgets with toggle buttons + inline value editing, collapsible layer-transform sub-groups, and a dnd-kit rewrite of all drag-and-drop (FX chain reorder, tile reorder, drag-to-live).

**Architecture:** FX enable/fade become real manifest params declared in `ChainHost.foldStep` (like `mix`), so MIDI cycle-binding, Console widgets, and value carry-forward all come free; the effective wet/dry is `mix × envelope` where the envelope is a stateful `Signal` ramping toward enabled∈{0,1} over `fade` seconds (no rebuild, never-go-black untouched). Modulator on/off is a new `enabled` flag on the `ModulatorHost` slot plus a `set_modulation_enabled` protocol verb and a `mod:<path>` MIDI-binding namespace. UI work is all in `packages/engine-app/src/ui/console/`. Drag-and-drop migrates from raw HTML5 DnD to dnd-kit (react-beautiful-dnd is archived and doesn't support React 19; the @hello-pangea/dnd fork doesn't support grids — dnd-kit supports React 19, grids via `rectSortingStrategy`, and external drop zones).

**Tech Stack:** React 19 + MUI 7 (`sx` styling), zod protocol in `packages/sidecar/src/protocol.ts`, runtime in `packages/runtime/src/`, vitest, Playwright validators in `scripts/`.

**Branch:** `console-ui-overhaul` off `main`. Commit only files this plan touches — `content/state/*` churn belongs to the running engine, leave it uncommitted.

**Gates after every task:** `pnpm typecheck` and `pnpm test` from `loom/`. Final gate: `pnpm validate` (at minimum m4, m5, m6, modulators suites must be re-run after the tasks that touch their surfaces).

---

### Task 1: ParamWidget vertical redesign (single-row layout, tooltip descriptions, toggle-button bools)

**Files:**
- Modify: `packages/engine-app/src/ui/console/ParamWidget.tsx`

**Changes:**

- [ ] **Step 1: Check validator usage of `data-path` on bool params**

Run: `rg -n "data-path" scripts/` — confirm no validator reads a bool param's `data-path` as an `<input>` (known users are float sliders). If any bool usage exists, keep a visually-hidden checkbox input carrying `data-path`; otherwise put `data-path` on the toggle button itself.

- [ ] **Step 2: Single-row layout**

Restructure the render so every param is ONE row (delete the description `<Typography>` block at lines 255–259 entirely):

- float/int slider: `label · ∿ · M · ⟷ · slider(flex) · value(48px)` — move the `<Slider>` inside the header `<Stack>` with `sx={{ flex: 1, minWidth: 56, mx: 0.5, py: 0.5 }}`; label gets `flex: "0 0 auto", maxWidth: 96` instead of `flex: 1`.
- bool: `label(flex) · ∿ · M · ToggleButton` — replace `<Switch>` with:
```tsx
<ToggleButton
  size="small"
  value="on"
  selected={p.value === true}
  disabled={modActive}
  data-path={path}
  onChange={() => link.sendParam(instance, path, !(p.value === true))}
  sx={{ py: 0, px: 1.25, fontSize: 11, lineHeight: "18px", textTransform: "none" }}
>
  {p.value === true ? "on" : "off"}
</ToggleButton>
```
- labeled int (`p.labels`): the `ToggleButtonGroup` moves into the row (right-aligned, `flexWrap: "wrap"` on the Stack so narrow panels degrade).
- color: the color `<input>` moves into the row, right-aligned.
- Label tooltip now carries the description: `title={p.description ? `${label ?? path} — ${p.description}` : (label ?? path)}`.
- Root `Box` margin: `mb: dense ? (fill ? 0.5 : 0) : 0.75`.

- [ ] **Step 3: Verify**

Run: `pnpm typecheck && pnpm test` — green. Eyes-on: `pnpm dev`, open `/console.html`, confirm param rows are single-line, descriptions appear on hover, bools are buttons.

- [ ] **Step 4: Commit** `feat(console): single-row param widgets, tooltip descriptions, toggle-button bools`

---

### Task 2: Double-click value label → inline text edit (auto range-widen)

**Files:**
- Modify: `packages/engine-app/src/ui/console/ParamWidget.tsx`

- [ ] **Step 1: Inline editor**

Add state `const [edit, setEdit] = useState<string | null>(null);`. The value `<Typography data-value={path}>` (float/int only): remove its click→RangePopover handler (the ⟷ button keeps that role); add `onDoubleClick={() => rangeable && setEdit(valueText)}`. When `edit != null` render in its place:
```tsx
<Box component="input" autoFocus value={edit}
  onChange={(e) => setEdit(e.target.value)}
  onFocus={(e) => e.currentTarget.select()}
  onKeyDown={(e) => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") setEdit(null); }}
  onBlur={commitEdit}
  sx={{ width: 56, font: "inherit", textAlign: "right", color: "inherit",
        bgcolor: "#0006", border: 1, borderColor: "primary.main", borderRadius: "3px", px: 0.25, outline: "none" }} />
```
`commitEdit` mirrors RangePopover's `applyValue` (the "prevent bad values / update min-max" contract):
```tsx
const commitEdit = () => {
  if (edit == null) return;
  const v = Number(edit);
  setEdit(null);
  if (!Number.isFinite(v)) return; // bad input reverts
  const lo = Math.min(min, v), hi = Math.max(max, v);
  const send = () => link.sendParam(instance, path, p.type === "int" ? Math.round(v) : v);
  if (lo < min || hi > max) void link.sendParamRange(instance, path, { min: lo, max: hi }).then(send).catch(fail);
  else send();
};
```

- [ ] **Step 2: Verify + commit**

`pnpm typecheck && pnpm test`. Eyes-on: double-click a value, type `99` on a 0–1 param — range widens, value lands; type garbage — reverts. Commit: `feat(console): double-click param value to type an exact number (auto-widens range)`

---

### Task 3: Layer transform params in a collapsible "transform" sub-group

**Files:**
- Modify: `packages/engine-app/src/ui/console/ParamPanel.tsx`

- [ ] **Step 1: Nested accordion**

Inside the group `AccordionDetails` (lines 183–196), split entries: `const rig = entries.filter(([path]) => path.slice(group.length + 1).startsWith("layer."));` and `const rest = entries.filter(...inverse...)`. Render `rest` as today; when `rig.length > 0` render after them a nested accordion (reusing `open`/`toggle` with key `` `${group}.layer` ``, default collapsed):
```tsx
<Accordion variant="outlined" disableGutters expanded={open[`${group}.layer`] ?? false}
  onChange={(_, x) => toggle(`${group}.layer`, x)} sx={{ mb: 1, bgcolor: "transparent" }}>
  <AccordionSummary sx={{ minHeight: 30, fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "text.secondary" }}>
    ⤡ transform
  </AccordionSummary>
  <AccordionDetails>
    {rig.map(([path, p]) => (
      <ParamWidget key={path} instance={instance} path={path} p={p}
        label={path.slice(group.length + 1 + "layer.".length)} />
    ))}
  </AccordionDetails>
</Accordion>
```

- [ ] **Step 2: Verify + commit**

`pnpm typecheck && pnpm test && pnpm validate:layers` (layer rig params are that suite's surface — confirm it still finds/sets `<node>.layer.*`; it drives params via MCP not the panel DOM, so it should pass untouched). Commit: `feat(console): collapse layer rig params into a transform sub-group`

---

### Task 4: FX step enable/disable with fade transition (runtime + UI)

**Files:**
- Modify: `packages/runtime/src/chain.ts`
- Modify: `packages/sidecar/src/protocol.ts` (ChainStepInfo)
- Modify: `packages/engine-app/src/ui/console/FxChain.tsx`
- Test: `packages/runtime/test/chain.test.ts` (extend existing)

- [ ] **Step 1: Failing tests** — in chain.test.ts: (a) fold declares `fx.<id>.enabled` (bool, default true) and `fx.<id>.fade` (float 0–8); (b) with fade=0, toggling enabled flips the step's wet uniform target between `mix` and 0 on the next pull; (c) with fade=1 and dt=0.1 frames, the envelope moves ~0.1/frame and reaches 0/1 monotonically; (d) `list()` includes `enabled`; (e) an effect declaring a reserved chain-param name (`mix`/`enabled`/`fade`) throws a clear error. Use the test file's existing BuildCtx/registry fakes; pull the wet value through the registered updaters/uniform seam the existing tests use (adapt to what's there).

- [ ] **Step 2: Implement in `chain.ts`**

Import `Signal` as a value. In `foldStep` after `mixParam`:
```ts
const enabledParam = ctx.bool(`${prefix}.enabled`, {
  default: true,
  description: `${effectName} on/off — disabling fades to bypass over .fade seconds`,
});
const fadeParam = ctx.float(`${prefix}.fade`, {
  default: 0, min: 0, max: 8, step: 0.05,
  description: "enable/disable transition time (seconds)",
});
```
Guard reserved names in the chainParams loop: `if (cp.name === "mix" || cp.name === "enabled" || cp.name === "fade") throw new Error(\`effect "${effectName}" declares reserved chain param "${cp.name}"\`);`
Replace the wet computation:
```ts
const mixSig = mixParam.signal();
const enabledSig = enabledParam.signal();
const fadeSig = fadeParam.signal();
let env: number | null = null; // ramps toward enabled∈{0,1}; null until first pull
const wetSig = new Signal<number>((f) => {
  const want = enabledSig.get(f) ? 1 : 0;
  const fade = Number(fadeSig.get(f));
  if (env == null || fade <= 0) env = want;
  else if (env !== want) {
    const step = f.dt / fade;
    env = env < want ? Math.min(want, env + step) : Math.max(want, env - step);
  }
  return Number(mixSig.get(f)) * env;
});
const wet = ctx.uniformOf(wetSig);
```
`list()` adds `enabled: s.params.enabled !== false`. Protocol `ChainStepInfo` adds `enabled: z.boolean().default(true)`. Update the runtime-side `ChainStepInfo` interface in chain.ts to match.

- [ ] **Step 3: FxChain UI** — header power button + dim + knob ordering. `stepKnobs` filter also excludes `` `${head}enabled` `` (fade stays a knob row). Card dim: `const en = manifest[`${prefix}${step.id}.enabled`]?.value !== false;` → `opacity: dim || !en ? 0.55 : 1`. In the header Stack before the remove button:
```tsx
<IconButton size="small" data-fxpower={step.id}
  title={en ? "disable (fades out over fade)" : "enable"}
  onClick={() => link.sendParam(instance, `${prefix}${step.id}.enabled`, !en)}
  sx={{ color: en ? "primary.main" : "text.secondary", fontSize: 13, p: 0.25 }}>
  ⏻
</IconButton>
```
The `enabled` param is still a real manifest param — render it as the first knob row so its ∿/M (modulate / MIDI cycle-learn) affordances stay reachable: render `<ParamWidget ... path={`${prefix}${step.id}.enabled`} label="enabled" dense fill />` right after the mix row (then keep it excluded from `stepKnobs` to avoid double render — i.e., render it explicitly, like mix).

- [ ] **Step 4: Verify** — `pnpm typecheck && pnpm test && pnpm validate:m6 && pnpm validate:modulators` (m6 asserts chain behavior; modulators suite touches fx params). Eyes-on: add an effect, set fade to 2, hit ⏻ — effect fades out, card dims; MIDI-learn the enabled row (cycle) if hardware present.

- [ ] **Step 5: Commit** `feat(fx): per-step enabled toggle with optional fade transition — MIDI-mappable, no rebuild`

---

### Task 5: Modulator enable/disable without detach (runtime + protocol + MIDI + UI)

**Files:**
- Modify: `packages/runtime/src/modulator-host.ts`
- Modify: `packages/sidecar/src/protocol.ts`
- Modify: `packages/engine-app/src/engine-api.ts`
- Modify: `packages/engine-app/src/main.ts`
- Modify: `packages/engine-app/src/projects.ts`
- Modify: `packages/engine-app/src/ui/engine-link.ts` (ParamDesc comment only, shape is loose)
- Modify: `packages/engine-app/src/ui/console/ModPopover.tsx`, `ParamWidget.tsx`
- Check: `packages/sidecar/src/` MCP tool list — add `set_modulation_enabled` for agent parity
- Test: `packages/runtime/test/modulator-host.test.ts` (extend existing)

- [ ] **Step 1: Failing tests** — host: `setEnabled(path,false)` → `tick` stops writing (param holds), `active()` false (manual set allowed), `list()`/`get()` carry `enabled`; `setEnabled` on unknown path throws; re-enable resumes writes; `reattach` preserves disabled state; `attach` (replace) resets enabled→true; `toggleEnabled` flips and returns new state.

- [ ] **Step 2: Runtime** — `Slot` gets `enabled: boolean`; `attach` sets `enabled: true`; add:
```ts
setEnabled(path: string, enabled: boolean): ModulatorInfo {
  const s = this.slots.get(path);
  if (!s) throw new Error(`no modulator on "${path}"`);
  s.enabled = enabled;
  return { path, spec: s.spec, error: s.error, enabled: s.enabled };
}
toggleEnabled(path: string): ModulatorInfo | null {
  const s = this.slots.get(path);
  return s ? this.setEnabled(path, !s.enabled) : null;
}
```
`ModulatorInfo` += `enabled: boolean`; `get`/`list` include it; `tick` skips `!s.enabled`; `active()` = `s != null && s.error == null && s.enabled`; `reattach` keeps `s.enabled`.

- [ ] **Step 3: Protocol** — `RequestType` += `"set_modulation_enabled"`; add:
```ts
export const SetModulationEnabledArgs = z.object({
  instance: z.string().default("live"),
  path: z.string().min(1),
  enabled: z.boolean(),
});
```
`ModulatorSummary` += `enabled: z.boolean().default(true)`.

- [ ] **Step 4: Engine** — engine-api: new case calls `e.modulators.setEnabled` and returns `{ instance, path, enabled }`; the set_param modulated-guard becomes `if (mod != null && mod.error == null && mod.enabled)`; `manifestJson` emits `modulator: m != null && m.error == null ? { ...m.spec, enabled: m.enabled } : null`; `snapshot()`/main.ts `__loom.instances` modulator maps include `enabled`. `resolveMidiTarget`: paths starting `"mod:"` resolve against the underlying param (`path.slice(4)`) for existence, are instance-scene only (reject on globals/actions), and force `mode: "cycle"`. main.ts CC dispatch (`cycle` handler): `if (path.startsWith("mod:")) { for (const e of session.entries.values()) if (e.sceneName === scene) e.modulators.toggleEnabled(path.slice(4)); return; }` (and same shape in `setValue` mapping value≥0.5→setEnabled). projects.ts: `ProjectInstance.modulators[]` += `enabled?: boolean`; serialize from `list()`; on load, after `attach`, `if (m.enabled === false) entry.modulators.setEnabled(m.path, false)`.

- [ ] **Step 5: Sidecar MCP tool** — find the tool registry in `packages/sidecar/src/` (where `modulate_param`/`clear_modulation` are declared) and add `set_modulation_enabled` with matching schema/description.

- [ ] **Step 6: UI** — ParamWidget: `const modAttached = p.modulator != null; const modOn = modAttached && (p.modulator as {enabled?: boolean}).enabled !== false;` — controls disable on `modOn` (not mere attachment); ∿ color `modOn ? "warning.main" : modAttached ? "#8a6d2899" : "text.secondary"`; title reflects "modulated (paused)". ModPopover: when `active`, add a row above the buttons:
```tsx
<Row label="state">
  <ToggleButton size="small" value="on" selected={modOn}
    onChange={() => void link.req("set_modulation_enabled", { instance, path, enabled: !modOn }).catch(fail)}
    sx={{ py: 0, px: 1.25, fontSize: 11, textTransform: "none" }}>
    {modOn ? "running" : "paused"}
  </ToggleButton>
  <Button data-learn={`mod:${path}`} onClick={() => void link.req("midi_learn", { instance, path: `mod:${path}`, mode: "cycle" }).catch(fail)} ...>
    {/* "M" / "···" / "cc<N>" exactly like ParamWidget's learn button, reading
        session.bindings for path === `mod:${path}` and session.midi.learning */}
  </Button>
</Row>
```
(ModPopover needs `useEngineState` for session bindings; popover receives `p.modulator.enabled`.)

- [ ] **Step 7: Verify + commit** — `pnpm typecheck && pnpm test && pnpm validate:modulators && pnpm validate:m5`. Eyes-on: attach a sine to a param, pause it (slider becomes draggable, wave frozen), resume, MIDI-learn the toggle. Commit: `feat(modulators): pause/resume without detach, MIDI-mappable via mod:<path> cycle bindings`

---

### Task 6: dnd-kit drag-and-drop (FX chain, tile grid, drag-to-live)

**Files:**
- Modify: `packages/engine-app/package.json` (add `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`)
- Modify: `packages/engine-app/src/ui/console/FxChain.tsx`, `TileGrid.tsx`, `Tile.tsx`, `StageDropZone.tsx`, `ConsoleApp.tsx`
- Modify: `scripts/validate-m4.mjs` (drag-to-live simulation becomes pointer-based)

- [ ] **Step 1: Install** — `pnpm --filter @loom/engine-app add @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities` (workspace root `pnpm install` after).

- [ ] **Step 2: FxChain** — wrap the step cards in `<DndContext collisionDetection={closestCenter} onDragEnd={...}>` + `<SortableContext items={chain.map(s => s.id)} strategy={verticalListSortingStrategy}>`. Extract the step card into a `SortableStep` child using `useSortable({ id: step.id })`; spread `setNodeRef`/`transform`/`transition` on the card and `{...attributes} {...listeners}` ONLY on the ⠿ handle (cards contain sliders — whole-card drag would fight them). `onDragEnd`: map `active.id`/`over?.id` to indices, `arrayMove`, then the existing `apply()`. Delete the old `drag`/`over` state and HTML5 handlers. Sensors: `useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))`.

- [ ] **Step 3: Tiles + drag-to-live** — lift tile order state (ORDER_KEY load/save, `reorderOver` logic) from TileGrid into ConsoleApp (or a small hook used there); render ONE `<DndContext>` in ConsoleApp wrapping both `<StageDropZone>` and `<TileGrid>`; `<SortableContext items={sortedIds} strategy={rectSortingStrategy}>` around the tiles. Tile: replace `draggable`/`onDragStart`/`onDragOver` with `useSortable({ id: inst.id, disabled: editing })`, listeners on the whole card, PointerSensor `activationConstraint: { distance: 8 }` so click/double-click still select/solo/rename. StageDropZone: `useDroppable({ id: "stage-zone" })`; armed state = `useDndContext().active != null` (replace the document listeners); keep `#stagestrip` and the "drop to go LIVE" overlay. ConsoleApp `onDragEnd`: `over?.id === "stage-zone"` → `link.req("stage", { instance: active.id }).then(() => link.req("commit", {}))`; over a tile → reorder + persist localStorage. Keep `onReorderOver`-style live preview optional — a plain on-drop reorder is acceptable; if using `onDragOver` for live preview, throttle.

- [ ] **Step 4: validate-m4 update** — replace the synthetic `DragEvent` block (lines ~219–233) with a real pointer drag (dnd-kit listens to pointer events): locate the tile's bounding box and `#stagestrip`'s, then `page.mouse.move(tx, ty); page.mouse.down(); page.mouse.move(sx, sy, { steps: 12 }); page.mouse.up();` and poll (existing waitFor helper) until `session.live === tileId`. Keep the check name "drag onto the stage bar stages and commits". Follow validator-authoring patterns already in the file (no sleeps, poll with timeout).

- [ ] **Step 5: Verify + commit** — `pnpm typecheck && pnpm test && pnpm validate:m4 && pnpm validate:m6`. Eyes-on: reorder FX steps by the ⠿ handle (knobs preserved — ids kept), reorder tiles, drag a tile to the top bar → goes live. Commit: `feat(console): dnd-kit drag-and-drop for FX chains, tile reorder, and drag-to-live`

---

### Task 7: Docs + full gate

- [ ] **Step 1:** `loom/.claude/CLAUDE.md`: in the `set_chain` bullet, note `fx.<id>.enabled` (bool, fades over `fx.<id>.fade`) and that `set_param` on it bypasses without rebuild; in `modulate_param` bullet note `set_modulation_enabled` pause/resume.
- [ ] **Step 2:** `loom/DECISIONS.md`: one entry — chain enable/fade as manifest params (why: free MIDI/persistence/UI), modulator slot-level enabled (why spec stays zod-strict), dnd-kit over react-beautiful-dnd (archived, no React 19, no grids) — plus a SHIPPED line with gates run.
- [ ] **Step 3:** Full `pnpm validate` from `loom/`. Fix anything red before merging. Merge `console-ui-overhaul` → `main` (no fast-forward, matching repo history).

## Self-review notes

- Spec coverage: FX toggle+transition (T4), DnD fix/upgrade incl. scenes/drag-to-live (T6), layer transform sub-group (T3), concise params (T1), modulator toggle + mappable (T5), double-click value edit (T2), toggle-button widget (T1). ✓
- `enabled !== false` (not `=== true`) everywhere a step/param may predate the feature — old saved chains/projects lack the key and must read as enabled. ✓
- `env` initialized lazily to the *current* enabled value so a build never fades in from black on load. ✓
- ChainStepInfo/ModulatorSummary additions use zod `.default(true)` so older snapshots still parse. ✓
