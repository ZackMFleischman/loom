# Console UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the LOOM console cockpit per `docs/superpowers/specs/2026-06-11-console-redesign-design.md` — denser, branded, drag-driven (reorder + drop-to-go-live), a "+" ghost tile with live scene previews, resizable param drawer, swatch-only palettes, agent commit armed by default.

**Architecture:** All UI work in `packages/engine-app/src/ui/` (React + MUI). Two engine-app touches: `main.ts` (commit-gate default) and `engine-api.ts` (hi-res staged thumbnail). Acceptance criteria that the redesign intentionally changes move into `scripts/validate-m3.mjs` / `validate-m4.mjs`.

**Tech Stack:** React 18, MUI 5, HTML5 drag-and-drop, BroadcastChannel console link. No new dependencies.

**Verification model:** This package has no UI unit-test harness; the project gates are `pnpm typecheck` + `validate:m*` Playwright scripts (per CLAUDE.md). Each task ends with a typecheck; validators run at the end (they need a clean dev-server boot).

**Validator DOM contract that must survive every task:**
`#fps` (output page), `#audiomode` (+ `mic:` options), `#panic`, `#commit`, `#unstage`, `#armagent`, `#stagestrip`, `#stagedname`, `#preview`, `#empty`, `#widgets`, `#palettes`, `#palettesource`, `.tile[data-id]` (+ child `img`), `.stagebtn` exact text `stage`/`unstage`, `.live-badge`/`.staged-badge` with `show`, `.rackrow[data-name]`, `.rackfill`, `.paletterow[data-name]`, `input[type=color][data-path]`, `[data-path]`, `[data-learn]`, drag type `text/loom-instance`.

---

### Task 1: Theme density + shared monospace

**Files:** Modify `packages/engine-app/src/ui/theme.ts`

- [ ] **Step 1:** Replace the typography/components blocks and export a mono stack:

```ts
export const mono = "ui-monospace, 'Cascadia Mono', Consolas, monospace";
```

`typography.fontSize: 12`; add to `components`:

```ts
MuiButton: {
  defaultProps: { variant: "outlined", size: "small", color: "inherit" },
  styleOverrides: { root: { textTransform: "none", padding: "1px 8px", minWidth: 0, lineHeight: 1.6 } },
},
```

- [ ] **Step 2:** `pnpm typecheck` → clean.
- [ ] **Step 3:** Commit `console redesign: density theme + mono stack`.

### Task 2: Header redesign

**Files:** Modify `packages/engine-app/src/ui/console/Header.tsx`

- [ ] **Step 1:** Rewrite the main `Header` return (AudioPicker/MidiStatus components stay) to:
  - `LOOM` wordmark: `Typography sx={{ fontFamily: mono, fontWeight: 800, letterSpacing: ".28em", color: "primary.main", fontSize: 14, userSelect: "none" }}`.
  - BPM chip = the TAP button: `<Button id="tap" title="tap tempo — click on the beat">` containing `<b id="bpm">{s.bpm.toFixed(0)}</b>` + dim `BPM` caption; mono family. Remove the separate readout.
  - RMS meter: width 80, height 8, `title="audio level"`.
  - `AudioPicker`, `MidiStatus`, `RACK` button as before (condensed).
  - Right: prominent FPS `Typography id="fps"` mono fontSize 14 fontWeight 700 → text `` `${s.fps.toFixed(0)} fps · f${s.frame}` `` (number bright, suffix dim via nested span).
  - `<Button component="a" href="/" target="_blank" rel="noopener">output ⧉</Button>` and same for `/staged.html` → `staged ⧉`.
  - `#panic` unchanged (PANIC/RESUME).
  - Bar paddings `px: 1.25, py: 0.5`, spacing 1.25.
- [ ] **Step 2:** `pnpm typecheck`; commit `console redesign: header (brand, tap-BPM, fps, new-tab links)`.

### Task 3: Stage bar — drop commits; agent commit armed by default

**Files:** Modify `packages/engine-app/src/ui/console/StageStrip.tsx`, `packages/engine-app/src/ui/console/ConsoleApp.tsx`, `packages/engine-app/src/main.ts:333`

- [ ] **Step 1:** `main.ts`: `{ agentCommitArmed: qs.get("agentCommit") !== "0" }` (comment: armed by default; `?agentCommit=0` restores the gate).
- [ ] **Step 2:** `StageStrip.tsx`: delete `#scenepick`/`#createbtn`/`onCreated` and the scene state; drop handler becomes stage→commit:

```ts
const id = e.dataTransfer.getData("text/loom-instance");
if (id) void link.req("stage", { instance: id }).then(() => link.req("commit", {})).catch(fail);
```

  Layout: `LIVE ▸ name` (name `color: "error.main"`), `STAGED ▸ name` (`warning.main`), palette toggle, `#fadeinfo`, spacer, `#armagent` checkbox, `#unstage`, `#commit`. Drag-over outline + hint (`outline: 2px dashed warning.main` + label "drop to go LIVE"). Paddings `px: 1.25, py: 0.5`.
- [ ] **Step 3:** `ConsoleApp.tsx`: `<StageStrip session={session} manifests={manifests} />`; move `onCreated={setSelected}` to `TileGrid` (prop added in Task 4).
- [ ] **Step 4:** `pnpm typecheck`; commit `console redesign: slim stage bar, drop-to-commit, agent commit armed by default`.

### Task 4: Tile chrome + drag-reorder + grid

**Files:** Modify `packages/engine-app/src/ui/console/Tile.tsx`, `packages/engine-app/src/ui/console/TileGrid.tsx`

- [ ] **Step 1:** `TileGrid.tsx`: order state + reorder plumbing + `NewInstanceTile` slot (placeholder import added in Task 5; in this task render tiles only):

```tsx
const ORDER_KEY = "loom.tileorder";
const loadOrder = (): string[] => {
  try { return JSON.parse(localStorage.getItem(ORDER_KEY) ?? "[]") as string[]; } catch { return []; }
};
// inside TileGrid:
const [order, setOrder] = useState<string[]>(loadOrder);
const dragId = useRef<string | null>(null);
const pos = (id: string) => { const i = order.indexOf(id); return i < 0 ? order.length : i; };
const sorted = [...s.instances].sort((a, b) => pos(a.id) - pos(b.id));
const reorderOver = (overId: string) => {
  const from = dragId.current;
  if (from == null || from === overId) return;
  const cur = sorted.map((i) => i.id);
  if (cur.indexOf(from) === cur.indexOf(overId) - 1) return; // already there
  const next = cur.filter((id) => id !== from);
  next.splice(next.indexOf(overId), 0, from);
  try { localStorage.setItem(ORDER_KEY, JSON.stringify(next)); } catch { /* order just won't persist */ }
  setOrder(next);
};
```

  Grid sx: `minmax(240px, 1fr)`, `gap: 1`, `p: 1`. Tiles get `onDragId={(id) => (dragId.current = id)}` and `onReorderOver={reorderOver}`. New props on `TileGrid`: `onCreated: (id: string) => void`.
- [ ] **Step 2:** `Tile.tsx` rewrite:
  - Card `sx`: `position: "relative"`, selected ring `boxShadow: 0 0 0 1.5px primary.main`, live ring `error.main`, staged ring `warning.main` (precedence live > staged > selected), `"&:hover .destroybtn": { opacity: 1, pointerEvents: "auto" }`.
  - `onDragStart`: set `text/loom-instance` + call `onDragId(inst.id)`; `onDragEnd`: `onDragId(null)`; `onDragOver`: if types include `text/loom-instance` → `preventDefault()` + `onReorderOver(inst.id)`.
  - Badges overlay the thumb, always in DOM: `live-badge` top-left red, `staged-badge` next to it amber, `display` toggled by `isLive`/`isStaged`, classes keep `show`.
  - Destroy: `<IconButton className="destroybtn" title="destroy">×</IconButton>` absolute top-right, `opacity: 0, pointerEvents: "none"`, dark scrim bg; **not rendered when `isLive`**.
  - Footer row (slim, `px: 1, py: 0.5`): status glyph (✓ green / ✗ red, `title={inst.error ?? inst.status}`), name `id · scene`, `.stagebtn` (exact text `stage`/`unstage`, disabled when live).
- [ ] **Step 3:** `pnpm typecheck`; commit `console redesign: tile overlays, hover destroy, live ring, drag-reorder`.

### Task 5: New-instance ghost tile with live hover preview

**Files:** Create `packages/engine-app/src/ui/console/NewInstanceTile.tsx`; modify `TileGrid.tsx` (render it after the tiles)

- [ ] **Step 1:** Create the component:

```tsx
import { Box, ButtonBase, Card, Popover, Stack, Typography } from "@mui/material";
import { useRef, useState } from "react";
import { useEngine, useThumb } from "../hooks";
import { fail } from "../util";

type Props = { scenes: string[]; onCreated: (id: string) => void };

/**
 * Ghost "+" tile (#newinstance): click → scene list popover (.scenerow[data-scene]).
 * Hovering a row builds a real sandbox instance after a 300 ms debounce and streams
 * its thumbnail as the preview; picking keeps it, closing destroys the orphan.
 */
export function NewInstanceTile({ scenes, onCreated }: Props) {
  const link = useEngine();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const preview = useRef<{ scene: string; id: string } | null>(null);
  const hovered = useRef<string | null>(null);
  const openRef = useRef(false);
  const timer = useRef<number>();
  const thumb = useThumb(previewId);

  const destroyPreview = () => {
    const p = preview.current;
    preview.current = null;
    setPreviewId(null);
    if (p) void link.req("destroy_instance", { instance: p.id }).catch(fail);
  };
  const close = () => {
    openRef.current = false;
    window.clearTimeout(timer.current);
    setAnchor(null);
    destroyPreview();
  };
  const hover = (scene: string) => {
    hovered.current = scene;
    window.clearTimeout(timer.current);
    if (preview.current?.scene === scene) return;
    timer.current = window.setTimeout(() => {
      destroyPreview();
      void link.req("create_instance", { scene }).then((r) => {
        const id = (r as { instance: string }).instance;
        if (!openRef.current || hovered.current !== scene) {
          void link.req("destroy_instance", { instance: id }).catch(fail);
          return;
        }
        preview.current = { scene, id };
        setPreviewId(id);
      }).catch(fail);
    }, 300);
  };
  const pick = (scene: string) => {
    window.clearTimeout(timer.current);
    if (preview.current?.scene === scene) {
      const id = preview.current.id;
      preview.current = null; // keep it — close() must not destroy it
      close();
      onCreated(id);
      return;
    }
    void link.req("create_instance", { scene })
      .then((r) => onCreated((r as { instance: string }).instance))
      .catch(fail);
    close();
  };

  return (
    <>
      <Card
        id="newinstance"
        variant="outlined"
        onClick={(e) => { openRef.current = true; setAnchor(e.currentTarget); }}
        sx={{
          cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center",
          justifyContent: "center", aspectRatio: "16/10", borderStyle: "dashed",
          color: "text.secondary", bgcolor: "transparent",
          "&:hover": { color: "primary.main", borderColor: "primary.main" },
        }}
      >
        <Typography sx={{ fontSize: 34, lineHeight: 1 }}>+</Typography>
        <Typography variant="caption">new instance</Typography>
      </Card>
      <Popover open={anchor != null} anchorEl={anchor} onClose={close}
        anchorOrigin={{ vertical: "top", horizontal: "right" }}>
        <Stack direction="row" sx={{ p: 1, gap: 1 }}>
          <Box sx={{ maxHeight: 300, overflowY: "auto", minWidth: 130 }}>
            {scenes.map((scene) => (
              <ButtonBase key={scene} className="scenerow" data-scene={scene}
                onMouseEnter={() => hover(scene)} onClick={() => pick(scene)}
                sx={{
                  display: "block", width: "100%", textAlign: "left", px: 1, py: 0.5,
                  borderRadius: 1, fontSize: 13,
                  bgcolor: preview.current?.scene === scene ? "action.selected" : "transparent",
                  "&:hover": { bgcolor: "action.hover" },
                }}
              >
                {scene}
              </ButtonBase>
            ))}
          </Box>
          <Box sx={{ width: 256, height: 144, bgcolor: "#000", borderRadius: 1, overflow: "hidden",
            display: "flex", alignItems: "center", justifyContent: "center" }}>
            {thumb ? (
              <Box component="img" src={thumb} alt="" sx={{ width: "100%", height: "100%", objectFit: "cover" }} />
            ) : (
              <Typography variant="caption" color="text.secondary">hover a scene to preview</Typography>
            )}
          </Box>
        </Stack>
      </Popover>
    </>
  );
}
```

- [ ] **Step 2:** `TileGrid.tsx`: render `<NewInstanceTile scenes={s.availableScenes} onCreated={onCreated} />` after the tiles.
- [ ] **Step 3:** `pnpm typecheck`; commit `console redesign: ghost + tile with live scene previews`.

### Task 6: Resizable param drawer

**Files:** Modify `packages/engine-app/src/ui/console/ParamPanel.tsx`

- [ ] **Step 1:** Add width state + handle (aside keeps `id="panel"`):

```tsx
const PANEL_W_KEY = "loom.panelw";
const [w, setW] = useState(() => {
  const n = Number(localStorage.getItem(PANEL_W_KEY));
  return Number.isFinite(n) && n >= 240 ? n : 320;
});
const wRef = useRef(w);
wRef.current = w;
const startResize = (e: ReactPointerEvent) => {
  e.preventDefault();
  const startX = e.clientX;
  const startW = wRef.current;
  const move = (ev: PointerEvent) =>
    setW(Math.min(Math.max(240, startW + (startX - ev.clientX)), window.innerWidth * 0.6));
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    try { localStorage.setItem(PANEL_W_KEY, String(wRef.current)); } catch { /* width just won't persist */ }
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
};
```

  Wrap: outer `Stack direction="row"` containing a 5 px `cursor: "col-resize"` handle Box (`onPointerDown={startResize}`, hover highlight) then the existing aside with `flex: 0 0 ${w}px`, `p: 1.25`.
- [ ] **Step 2:** `pnpm typecheck`; commit `console redesign: resizable param drawer`.

### Task 7: Palette swatches + rack density

**Files:** Modify `packages/engine-app/src/ui/console/Palettes.tsx`, `packages/engine-app/src/ui/console/Rack.tsx`

- [ ] **Step 1:** `Palettes.tsx`: drop `ParamWidget`; render bare swatches (keeps `#palettes`, `.paletterow[data-name]`, `input[type=color][data-path]` for m6):

```tsx
function Swatch({ path, p }: { path: string; p: ParamDesc }) {
  const link = useEngine();
  const hex = String(p.value);
  return (
    <Box component="input" type="color" value={hex} data-path={path}
      title={`${path} · ${hex}`}
      onChange={(e: ChangeEvent<HTMLInputElement>) => link.sendParam("globals", path, e.target.value)}
      sx={{
        width: 30, height: 30, p: 0, border: 1, borderColor: "divider", borderRadius: 1,
        bgcolor: "transparent", cursor: "pointer",
        "&::-webkit-color-swatch-wrapper": { p: "3px" },
        "&::-webkit-color-swatch": { border: "none", borderRadius: "2px" },
      }}
    />
  );
}
```

  Row: source label (width 70) + 5 swatches, `gap: 0.75`, `py: 0.5`.
- [ ] **Step 2:** `Rack.tsx` density: meter width 70 height 8, name width 70, row `py: 0.5`, widget gap 1.25, drawer `px: 1.25 pt: 0.75 pb: 1`.
- [ ] **Step 3:** `pnpm typecheck`; commit `console redesign: swatch-only palettes, denser rack`.

### Task 8: Hi-res staged preview

**Files:** Modify `packages/engine-app/src/engine-api.ts:385-401`

- [ ] **Step 1:** In `thumbnails()`, read the staged pointer and upsize that instance's readback (comment why):

```ts
const staged = this.deps.stage.staged;
// The /staged page blows this image up full-screen — give it real pixels.
out[e.id] = e.id === this.deps.stage.live
  ? this.liveMirror.toDataURL("image/jpeg", 0.7)
  : await this.readTarget(e, e.id === staged ? 640 : width, e.id === staged ? 360 : height, "image/jpeg");
```

  (Verify `deps.stage.staged` is the staged-id accessor — it backs `consoleState().staged`; adjust to the real accessor if named differently.)
- [ ] **Step 2:** `pnpm typecheck && pnpm test`; commit `staged preview streams at 640x360`.

### Task 9: Validator updates (m3, m4)

**Files:** Modify `scripts/validate-m3.mjs`, `scripts/validate-m4.mjs`

- [ ] **Step 1:** m3 §6 (lines ~253-260): assert `agentCommitArmed === true` from `get_session`; click `#armagent` to disarm; wait for `agentCommitArmed === false`; then the existing blocked-commit + LIVE-untouched checks (label "agent commit is blocked when disarmed").
- [ ] **Step 2:** m3 §9b (lines ~315-325): `click("#newinstance")` → `click('.scenerow[data-scene="pulse"]')` → existing `.tile[data-id^="pulse-"]` wait + session check.
- [ ] **Step 3:** m3 §10 (lines ~327-348): goto `&agentCommit=0` → wait reconnect with `agentCommitArmed === false` → create+stage lava → agent commit blocked (isError). Then goto plain `OUTPUT_URL` → wait `agentCommitArmed === true` → create+stage+`commit {durationFrames:10}` → live === new instance ("armed-by-default agent commit crossfades to LIVE").
- [ ] **Step 4:** m4 §5: after the drag-evaluate, wait `live === cid && staged === null && mix === null` (10 s); check renamed "drag onto the stage bar stages and commits". §6: `stage {instance:"boot"}` via MCP first, then the boot tile's `.stagebtn` text/click checks. §7: stage `boot` (name check `includes("boot")`), `#commit` → `live === "boot"`. §8: stage `cid` (name check `includes("lava")`), `#unstage`.
- [ ] **Step 5:** Commit `validators: m3/m4 acceptance for the console redesign`.

### Task 10: Full verification + decision log

- [ ] **Step 1:** `pnpm typecheck` and `pnpm test` → green.
- [ ] **Step 2:** Run `pnpm validate:m0` … `validate:m6`, `validate:modulators` sequentially → all green. Fix forward anything red (containment rules from CLAUDE.md apply — never weaken a check to pass it; only the §-edits above are sanctioned).
- [ ] **Step 3:** Append DECISIONS.md entry (console redesign: what changed, validator criteria moved, agent-commit default flip rationale "for now" per Zack).
- [ ] **Step 4:** Final commit of remaining files (use explicit pathspecs — unrelated work is pre-staged in this worktree).

## Self-review notes

- Spec coverage: header (T2), stage bar/drop-commit/armed default (T3), tiles/reorder/hover-X/live ring (T4), + tile & previews (T5), drawer (T6), palettes/rack (T7), staged depth (T8), validators (T9), gates (T10). Condensation is spread across T1-T7. ✓
- `onCreated` flows ConsoleApp → TileGrid → NewInstanceTile; `onDragId`/`onReorderOver` named consistently in T4. ✓
- No TBDs; all code shown. ✓
