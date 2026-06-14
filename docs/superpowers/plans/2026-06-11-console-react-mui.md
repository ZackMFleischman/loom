# Console → React + MaterialUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild LOOM's two cockpit pages — `/console.html` and `/staged.html` — as React 19 + MUI v7 apps, leaving the engine (Output window, runtime, sidecar) untouched.

**Architecture:** The Output window (`index.html` + `src/main.ts`) stays exactly as it is — it is the audience-facing projector and owns the never-go-black HMR path. Only the two human cockpit pages become React apps. A framework-free `EngineLink` class (port of the existing BroadcastChannel client) holds all channel protocol logic and is exposed to React through `useSyncExternalStore` hooks. **No `@vitejs/plugin-react`**: Vite's esbuild compiles `.tsx` natively (via `"jsx": "react-jsx"` in tsconfig), so the scenes HMR pipeline is byte-for-byte unaffected; editing a console `.tsx` file causes a full reload of the console tab only, which is fine for a cockpit page.

**Tech Stack:** React 19, react-dom 19, @mui/material 7 (+ @emotion/react, @emotion/styled), vitest for the EngineLink unit tests. No icon/font packages — theme uses `system-ui`.

---

## Context you must absorb first

- All commands run from `loom/` (the pnpm workspace root). The repo root is one level up (`ai-experiments/`).
- Read `loom/CLAUDE.md` sections "Never go black" and "Validation approach" before starting.
- **Files you must NOT touch:** everything in `packages/runtime/`, `packages/sidecar/`, and in `packages/engine-app/`: `index.html`, `src/main.ts`, `src/bridge.ts`, `src/engine-api.ts`, `src/console-channel.ts`, `src/session.ts`, `src/compositor.ts`, `src/fps.ts`, `src/scenes.ts`, `src/state.ts`. The engine half of the Console link (`console-channel.ts`) already speaks a stable protocol; we only rebuild the browser-page half.
- **Files that get replaced:** `packages/engine-app/console.html`, `packages/engine-app/staged.html`, `packages/engine-app/src/console.ts` (deleted), `packages/engine-app/src/staged.ts` (deleted).
- The old implementations (`src/console.ts`, `src/staged.ts`) are the behavioral spec. When in doubt about a behavior, open them in git history (`git show HEAD:packages/engine-app/src/console.ts`) — every behavior listed below comes from there.

### The wire protocol (unchanged)

Pages talk to the engine over `BroadcastChannel("loom")`:

- Page → engine: `{ kind: "hello" }` every 2 s (presence; engine only broadcasts state/thumbs while a page said hello in the last 5 s).
- Page → engine: `{ id, kind: "req", type, args }`; engine answers `{ id, kind: "res", ok: true, result }` or `{ id, kind: "res", ok: false, error }`. Request ids need a per-tab random prefix so two open tabs don't resolve each other's responses.
- Engine → pages: `{ kind: "state", session: SessionSnapshot, manifests: Record<instanceId, Record<paramPath, ParamDesc>> }` at ~10 Hz.
- Engine → pages: `{ kind: "thumbs", thumbs: Record<instanceId, dataUrl> }` at ~6.6 Hz.

Request types used by the cockpit: `set_transport` `panic` `resume` `commit` `unstage` `stage` `arm_agent_commit` `create_instance` `destroy_instance` `set_audio` `set_param` `modulate_param` `clear_modulation` `midi_learn` `midi_unbind`. Types come from `@loom/sidecar/protocol` (tsconfig path alias, already configured at the root).

### The DOM contract (validators depend on these — preserve EXACTLY)

`scripts/validate-m3.mjs`, `validate-m4.mjs`, `validate-m5.mjs` drive the pages with Playwright. The React rewrite must keep this contract:

| Selector / behavior | Used by | Notes |
|---|---|---|
| `.tile[data-id="<id>"]` clickable, selects instance | m3, m4, m5 | also `data-id^="pulse-"` prefix match |
| `.tile img` with `src` = `data:image/...` once thumbs stream | m3 | `<img>` element must always exist, `src` absent until a thumb arrives |
| `.tile .live-badge` always in DOM; `className` contains `show` when live | m3 | conditional **class**, not conditional render |
| `.tile .staged-badge.show` appears when staged | m3 | same |
| `.tile .stagebtn` — `textContent` exactly `"stage"` / `"unstage"`, click stages/unstages, `stopPropagation` | m3, m4 | MUI Button is fine (ripple spans add no text), but no icons/extra text |
| Tile is `draggable`; synthetic `dragstart` must put the id into `dataTransfer` under `"text/loom-instance"`; `dragover`+`drop` on `#stagestrip` stages it | m4 | validator dispatches synthetic bubbling `DragEvent`s — React root listeners receive these |
| `#scenepick` is a **native `<select>`** (Playwright `selectOption`) with scene-name options; `#createbtn` creates | m3 | use MUI `NativeSelect`, id via `inputProps` |
| `#audiomode` is a native `<select>`, options `value="test"` and `value="mic:<deviceId>"` | m4 | same |
| `#commit` button (console **and** staged page), `#unstage`, `#panic` with text `PANIC`/`RESUME` | m3, m4 | |
| `[data-path="<paramPath>"]` on the param **input element**; setting `.value` + dispatching `input` must write the param through | m3, m5 | m3 will be updated to use the React-safe native setter (Task 9) |
| `#widgets [data-learn="<path>"]` button, `textContent` exactly `"M"` (unbound) / `"···"` (learning) / `"cc<N>"` (bound); click = learn/unbind | m5 | exact text equality — beware MUI uppercase styling is fine (CSS only) but don't add whitespace/children |
| `"i"` keydown (when not typing in an input/select/textarea) toggles the rack; `.rackrow[data-name="<channel>"]` rows; `.rackfill` with **inline** `style.width` that tracks the meter | m5 | validator reads `el.style.width` twice 500 ms apart and expects change |
| `body.disconnected` class when no engine state for >1.5 s | m4 (staged page) | keep toggling the class on `document.body` |
| Staged page: `#stagedname` text contains `"<id> · <scene>"`, `#fadeinfo`, `#preview` img with data-url src, `#empty` with computed `display` ≠ `none` only when nothing staged | m4 | keep `#empty` and `#preview` always rendered, toggle `display` |

`validate-m0/m1/m2/modulators` never touch the cockpit DOM and must keep passing untouched.

### Behavioral spec carried over from the old code

1. **Never clobber the user's thumb:** while a slider is being dragged, the 10 Hz state broadcast must not snap it back. (Old code: `draggingKey`; new code: local `drag` state that wins over the broadcast value until `onChangeCommitted`.)
2. **rAF-coalesced param writes:** multiple `set_param`s in one frame collapse to one write per `instance:path` (old `sendParam`).
3. **Modulated params** (`p.modulator != null`): slider disabled (engine rejects writes anyway), shows the live modulated value as a read-only moving thumb, warning color, mod button lit.
4. **Audio picker** reflects the engine's mode unless the user is mid-interaction (focused).
5. **Param groups:** dotted paths (`logo.tiltX`) group under a collapsible `logo` section labeled `tiltX`; dotless params stay flat on top; open state persists in `localStorage` key `"loom.pgroups.open"`, collapsed by default.
6. **MIDI:** clicking the MIDI status (or a learn button with no MIDI access) calls `navigator.requestMIDIAccess()` to pop Chrome's permission prompt in the cockpit window. Learn click logic: bound and not learning → `midi_unbind`; otherwise → `midi_learn` (engine treats re-learn while learning as cancel).
7. **Rack:** only instance params get the modulator button (`instance !== "globals"`); rack widgets hide their description text; a channel row is "enabled"-colored when `inputs.<name>.enabled` is true.
8. **Commit guard:** `#commit` disabled when nothing staged or panicked; `#unstage` disabled when nothing staged. PANIC button toggles to RESUME when `session.panicked`.
9. Selecting a tile opens its params; creating an instance auto-selects it; double-click toggles "solo" (tile spans the full grid width).
10. Mod popover seeds its form from the active modulator when opened; attach button reads "update" when one is active; retrigger re-sends the active spec; detach calls `clear_modulation` and closes.

---

## File map

```
packages/engine-app/
  console.html                 REPLACED — thin shell, <div id="root"> + /src/ui/console/main.tsx
  staged.html                  REPLACED — thin shell, <div id="root"> + /src/ui/staged/main.tsx
  vitest.config.ts             NEW — node-env unit tests
  package.json                 MODIFIED — react/mui deps, test script
  src/console.ts               DELETED (Task 9)
  src/staged.ts                DELETED (Task 9)
  src/ui/
    engine-link.ts             NEW — channel client + stores, React-free, unit-tested
    hooks.ts                   NEW — EngineProvider/useEngine/useEngineState/useThumb
    theme.ts                   NEW — dark MUI theme matching the old palette
    mod-types.ts               NEW — MOD_TYPES table (verbatim from old console.ts)
    util.ts                    NEW — fail(), primeMidiPermission()
    Disconnected.tsx           NEW — banner + body.disconnected class (shared by both pages)
    console/
      main.tsx                 NEW — entry: theme + EngineLink + <ConsoleApp/>
      ConsoleApp.tsx           NEW — layout, selection/solo/rack state, "i" hotkey
      Header.tsx               NEW — BPM/TAP/RMS/audio picker/MIDI status/rack/fps/PANIC
      StageStrip.tsx           NEW — scene picker, LIVE/STAGED, unstage, arm, COMMIT, drop target
      TileGrid.tsx             NEW — grid of tiles
      Tile.tsx                 NEW — one instance tile
      ParamPanel.tsx           NEW — manifest → flat widgets + accordion groups
      ParamWidget.tsx          NEW — one param: label/mod/learn/value + Slider/Switch
      ModPopover.tsx           NEW — modulator attach/update/retrigger/detach form
      Rack.tsx                 NEW — input-rack drawer + rows
    staged/
      main.tsx                 NEW
      StagedApp.tsx            NEW
  test/
    engine-link.test.ts        NEW
tsconfig.base.json             MODIFIED — "jsx": "react-jsx"
tsconfig.json                  MODIFIED — include engine-app test + vitest config
scripts/validate-m3.mjs        MODIFIED — React-safe slider write (Task 9)
DECISIONS.md                   MODIFIED — one new entry (Task 10)
agent-updates.md               MODIFIED — one new entry (Task 10)
```

---

### Task 0: Branch

- [ ] **Step 0.1:** From `loom/`, confirm a clean tree, then branch:

```bash
git status --short   # expect empty (or only files you understand)
git checkout -b feat/console-react-mui
```

### Task 1: Dependencies + build wiring

**Files:**
- Modify: `packages/engine-app/package.json`
- Modify: `tsconfig.base.json`
- Modify: `tsconfig.json`
- Create: `packages/engine-app/vitest.config.ts`

- [ ] **Step 1.1: Add dependencies** (from `loom/`):

```bash
pnpm --filter @loom/engine-app add react@^19 react-dom@^19 @mui/material@^7 @emotion/react@^11 @emotion/styled@^11
pnpm --filter @loom/engine-app add -D @types/react@^19 @types/react-dom@^19 vitest
```

If pnpm reports a peer-dependency warning between @mui/material and the installed React, it is fine as long as React is 19.x. If `@mui/material@^7` cannot resolve, use the latest 7.x explicitly.

- [ ] **Step 1.2: Add the test script** to `packages/engine-app/package.json` — the `scripts` block becomes:

```json
  "scripts": {
    "dev": "vite",
    "test": "vitest run"
  },
```

- [ ] **Step 1.3: Create `packages/engine-app/vitest.config.ts`:**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
```

- [ ] **Step 1.4: Enable JSX in `tsconfig.base.json`** — add one line to `compilerOptions`:

```json
    "jsx": "react-jsx",
```

(We deliberately do NOT add `@vitejs/plugin-react`: Vite's esbuild compiles `.tsx` using this tsconfig setting. No Vite config change is needed, and the scenes HMR path — the never-go-black layer 1 — is provably untouched because `vite.config.ts` doesn't change at all in this refactor.)

- [ ] **Step 1.5: Widen the root `tsconfig.json` include** so the new test + config files are typechecked. The `include` array becomes:

```json
  "include": [
    "packages/runtime/src",
    "packages/runtime/test",
    "packages/engine-app/src",
    "packages/engine-app/test",
    "packages/engine-app/vite.config.ts",
    "packages/engine-app/vitest.config.ts",
    "packages/sidecar/src",
    "packages/sidecar/test",
    "content"
  ]
```

- [ ] **Step 1.6: Verify:**

```bash
pnpm typecheck
```

Expected: PASS (no `.tsx` files exist yet; this proves the wiring alone breaks nothing).

- [ ] **Step 1.7: Commit:**

```bash
git add packages/engine-app/package.json packages/engine-app/vitest.config.ts tsconfig.base.json tsconfig.json pnpm-lock.yaml
git commit -m "Console React refactor: deps and build wiring (no plugin-react; esbuild tsx)"
```

### Task 2: EngineLink — the channel client (TDD)

**Files:**
- Create: `packages/engine-app/src/ui/engine-link.ts`
- Create: `packages/engine-app/src/ui/util.ts`
- Test: `packages/engine-app/test/engine-link.test.ts`

- [ ] **Step 2.1: Write the failing tests** — `packages/engine-app/test/engine-link.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSnapshot } from "@loom/sidecar/protocol";
import { EngineLink, type ChannelLike } from "../src/ui/engine-link";

/** Two-ended in-memory stand-in for BroadcastChannel("loom"). */
class FakeChannel implements ChannelLike {
  other: FakeChannel | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  sent: unknown[] = [];
  postMessage(msg: unknown): void {
    this.sent.push(msg);
    this.other?.onmessage?.({ data: msg });
  }
  close(): void {}
}

const SESS = { live: "boot", staged: null } as unknown as SessionSnapshot;

describe("EngineLink", () => {
  let page: FakeChannel; // the page end (EngineLink owns it)
  let engine: FakeChannel; // the engine end (the test plays the engine)
  let frames: Array<() => void>;
  let link: EngineLink;

  beforeEach(() => {
    vi.useFakeTimers();
    page = new FakeChannel();
    engine = new FakeChannel();
    page.other = engine;
    engine.other = page;
    frames = [];
    link = new EngineLink({
      prefix: "t-",
      channel: page,
      schedule: (cb) => frames.push(cb),
      now: () => Date.now(),
    });
  });

  afterEach(() => {
    link.dispose();
    vi.useRealTimers();
  });

  it("says hello on construction (presence)", () => {
    expect(page.sent).toContainEqual({ kind: "hello" });
  });

  it("resolves a request with the matching ok response", async () => {
    engine.onmessage = (ev) => {
      const m = ev.data as { id: string; kind: string; type: string };
      if (m.kind === "req" && m.type === "stage") {
        engine.postMessage({ id: m.id, kind: "res", ok: true, result: { staged: "x" } });
      }
    };
    await expect(link.req("stage", { instance: "x" })).resolves.toEqual({ staged: "x" });
  });

  it("rejects a request on an error response", async () => {
    engine.onmessage = (ev) => {
      const m = ev.data as { id: string; kind: string };
      if (m.kind === "req") engine.postMessage({ id: m.id, kind: "res", ok: false, error: "nope" });
    };
    await expect(link.req("commit", {})).rejects.toThrow("nope");
  });

  it("times out an unanswered request after 5s", async () => {
    const p = link.req("stage", {});
    const expectation = expect(p).rejects.toThrow(/timed out/);
    vi.advanceTimersByTime(5001);
    await expectation;
  });

  it("publishes state snapshots and flips connected", () => {
    expect(link.getSnapshot().connected).toBe(false);
    engine.postMessage({ kind: "state", session: SESS, manifests: { boot: {} } });
    const snap = link.getSnapshot();
    expect(snap.connected).toBe(true);
    expect(snap.session).toEqual(SESS);
    expect(snap.manifests).toEqual({ boot: {} });
    // No further state for >1.5s → disconnected (polled every 500ms).
    vi.advanceTimersByTime(2000);
    expect(link.getSnapshot().connected).toBe(false);
  });

  it("notifies subscribers on state and on thumbs separately", () => {
    const onState = vi.fn();
    const onThumbs = vi.fn();
    link.subscribe(onState);
    link.subscribeThumbs(onThumbs);
    engine.postMessage({ kind: "state", session: SESS, manifests: {} });
    engine.postMessage({ kind: "thumbs", thumbs: { boot: "data:image/png;base64,x" } });
    expect(onState).toHaveBeenCalledTimes(1);
    expect(onThumbs).toHaveBeenCalledTimes(1);
    expect(link.thumb("boot")).toBe("data:image/png;base64,x");
  });

  it("coalesces param writes per instance:path per frame", () => {
    link.sendParam("live", "a", 1);
    link.sendParam("live", "a", 2);
    link.sendParam("live", "b", 3);
    expect(frames.length).toBe(1); // one scheduled flush
    const before = page.sent.filter((m) => (m as { type?: string }).type === "set_param").length;
    expect(before).toBe(0);
    frames[0]!();
    const writes = page.sent.filter((m) => (m as { type?: string }).type === "set_param") as Array<{
      args: { path: string; value: number };
    }>;
    expect(writes).toHaveLength(2);
    expect(writes.find((w) => w.args.path === "a")?.args.value).toBe(2);
    expect(writes.find((w) => w.args.path === "b")?.args.value).toBe(3);
  });
});
```

- [ ] **Step 2.2: Run the tests, verify they fail** (module doesn't exist):

```bash
pnpm --filter @loom/engine-app test
```

Expected: FAIL — cannot resolve `../src/ui/engine-link`.

- [ ] **Step 2.3: Write `packages/engine-app/src/ui/engine-link.ts`:**

```ts
import type { SessionSnapshot } from "@loom/sidecar/protocol";

/** One tweakable param as the engine describes it over the channel. */
export type ParamDesc = {
  type: "float" | "int" | "bool";
  value: number | boolean;
  default: number | boolean;
  min?: number;
  max?: number;
  step?: number;
  description?: string;
  /** Active modulator config, or null when the param is hand-driven (FR-8). */
  modulator?: Record<string, unknown> | null;
};

export type Manifests = Record<string, Record<string, ParamDesc>>;

export type EngineSnapshot = {
  session: SessionSnapshot | null;
  manifests: Manifests;
  connected: boolean;
};

/** The BroadcastChannel surface EngineLink needs — injectable for unit tests. */
export type ChannelLike = {
  postMessage(msg: unknown): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  close(): void;
};

export type EngineLinkOptions = {
  /** Per-tab request-id prefix so pages sharing the channel ignore each other's responses. */
  prefix: string;
  channel?: ChannelLike;
  /** Frame scheduler for write coalescing (rAF in the browser). */
  schedule?: (cb: () => void) => void;
  now?: () => number;
};

const HELLO_MS = 2000;
const CONNECTED_POLL_MS = 500;
const STALE_MS = 1500;
const REQ_TIMEOUT_MS = 5000;

const defaultSchedule: (cb: () => void) => void =
  typeof requestAnimationFrame === "function"
    ? (cb) => requestAnimationFrame(() => cb())
    : (cb) => void setTimeout(cb, 16);

/**
 * The page side of the Console link: request/response envelopes over
 * BroadcastChannel("loom") (same shapes as the sidecar wire), hello-presence,
 * and external stores (state, thumbs) shaped for useSyncExternalStore.
 * React-free on purpose — unit-tested in Node with a fake channel.
 */
export class EngineLink {
  private readonly ch: ChannelLike;
  private readonly prefix: string;
  private readonly schedule: (cb: () => void) => void;
  private readonly now: () => number;

  private seq = 0;
  private readonly pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  private snapshot: EngineSnapshot = { session: null, manifests: {}, connected: false };
  private readonly listeners = new Set<() => void>();
  private thumbsMap: Record<string, string> = {};
  private readonly thumbListeners = new Set<() => void>();

  private lastStateAt = -Infinity;
  private readonly timers: Array<ReturnType<typeof setInterval>> = [];

  private readonly queued = new Map<
    string,
    { instance: string; path: string; value: number | boolean }
  >();
  private flushScheduled = false;

  constructor(opts: EngineLinkOptions) {
    this.prefix = opts.prefix;
    this.ch = opts.channel ?? new BroadcastChannel("loom");
    this.schedule = opts.schedule ?? defaultSchedule;
    this.now = opts.now ?? (() => performance.now());

    this.ch.onmessage = (ev) => this.onMessage(ev.data);
    this.ch.postMessage({ kind: "hello" });
    this.timers.push(setInterval(() => this.ch.postMessage({ kind: "hello" }), HELLO_MS));
    this.timers.push(
      setInterval(() => {
        const connected = this.now() - this.lastStateAt < STALE_MS;
        if (connected !== this.snapshot.connected) {
          this.snapshot = { ...this.snapshot, connected };
          this.emit();
        }
      }, CONNECTED_POLL_MS),
    );
  }

  // Stable identities for useSyncExternalStore.
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getSnapshot = (): EngineSnapshot => this.snapshot;
  subscribeThumbs = (fn: () => void): (() => void) => {
    this.thumbListeners.add(fn);
    return () => {
      this.thumbListeners.delete(fn);
    };
  };
  thumb = (id: string): string | undefined => this.thumbsMap[id];

  req(type: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const id = `${this.prefix}${++this.seq}`;
    this.ch.postMessage({ id, kind: "req", type, args });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${type} timed out — engine not responding`));
      }, REQ_TIMEOUT_MS);
    });
  }

  /** Frame-coalesced param writes: drags feel instant without flooding the channel. */
  sendParam(instance: string, path: string, value: number | boolean): void {
    this.queued.set(`${instance}:${path}`, { instance, path, value });
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    this.schedule(() => {
      this.flushScheduled = false;
      for (const w of this.queued.values()) {
        void this.req("set_param", { instance: w.instance, path: w.path, value: w.value }).catch(
          (err) => console.error("[loom-ui]", err),
        );
      }
      this.queued.clear();
    });
  }

  dispose(): void {
    for (const t of this.timers) clearInterval(t);
    this.ch.close();
  }

  private onMessage(data: unknown): void {
    if (typeof data !== "object" || data === null) return;
    const msg = data as { kind?: string } & Record<string, unknown>;
    if (msg.kind === "res") {
      const p = this.pending.get(msg.id as string);
      if (!p) return; // another tab's response
      this.pending.delete(msg.id as string);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(String(msg.error)));
      return;
    }
    if (msg.kind === "state") {
      this.lastStateAt = this.now();
      this.snapshot = {
        session: msg.session as SessionSnapshot,
        manifests: (msg.manifests as Manifests | undefined) ?? {},
        connected: true,
      };
      this.emit();
      return;
    }
    if (msg.kind === "thumbs") {
      this.thumbsMap = { ...this.thumbsMap, ...(msg.thumbs as Record<string, string>) };
      this.emitThumbs();
    }
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
  private emitThumbs(): void {
    for (const fn of this.thumbListeners) fn();
  }
}
```

- [ ] **Step 2.4: Write `packages/engine-app/src/ui/util.ts`:**

```ts
/** Error sink for fire-and-forget cockpit requests — never throw into React. */
export const fail = (err: unknown) => console.error("[loom-ui]", err);

/**
 * Chrome gates WebMIDI behind a per-origin permission prompt, and the engine
 * (Output window) is a bare projector page nobody clicks. Requesting access
 * from the cockpit pops the prompt in the window the human is actually using;
 * the grant is origin-wide, and the engine re-attaches the moment it lands.
 */
export function primeMidiPermission(): void {
  const nav = navigator as Navigator & { requestMIDIAccess?: () => Promise<unknown> };
  void nav.requestMIDIAccess?.().catch(() => {});
}
```

- [ ] **Step 2.5: Run tests + typecheck, verify green:**

```bash
pnpm --filter @loom/engine-app test
pnpm typecheck
```

Expected: 7 tests PASS; typecheck PASS.

- [ ] **Step 2.6: Commit:**

```bash
git add packages/engine-app/src/ui/engine-link.ts packages/engine-app/src/ui/util.ts packages/engine-app/test/engine-link.test.ts
git commit -m "Console React refactor: EngineLink channel client with unit tests"
```

### Task 3: Theme, hooks, mod-types, Disconnected

**Files:**
- Create: `packages/engine-app/src/ui/theme.ts`
- Create: `packages/engine-app/src/ui/hooks.ts`
- Create: `packages/engine-app/src/ui/mod-types.ts`
- Create: `packages/engine-app/src/ui/Disconnected.tsx`

- [ ] **Step 3.1: `packages/engine-app/src/ui/theme.ts`** — same palette the old CSS variables defined:

```ts
import { createTheme } from "@mui/material/styles";

/** Dark cockpit theme — palette carried over from the old console.html CSS vars. */
export const theme = createTheme({
  palette: {
    mode: "dark",
    background: { default: "#0b0c10", paper: "#14161c" },
    divider: "#262a33",
    text: { primary: "#c8cdd8", secondary: "#6b7280" },
    primary: { main: "#3ddc97" }, // accent
    warning: { main: "#f3c969" },
    error: { main: "#e6455a" },
  },
  typography: {
    fontFamily: "system-ui, sans-serif",
    fontSize: 13,
  },
  components: {
    MuiButton: {
      defaultProps: { variant: "outlined", size: "small", color: "inherit" },
      // Validators compare button textContent ("stage"/"unstage"/"cc21") —
      // uppercase styling is CSS-only and harmless, but keep labels readable.
      styleOverrides: { root: { textTransform: "none" } },
    },
    MuiTextField: { defaultProps: { size: "small" } },
  },
});
```

- [ ] **Step 3.2: `packages/engine-app/src/ui/hooks.ts`:**

```ts
import { createContext, useContext, useSyncExternalStore } from "react";
import type { EngineLink, EngineSnapshot } from "./engine-link";

const EngineContext = createContext<EngineLink | null>(null);
export const EngineProvider = EngineContext.Provider;

export function useEngine(): EngineLink {
  const link = useContext(EngineContext);
  if (!link) throw new Error("EngineProvider missing");
  return link;
}

/** Latest engine state (~10 Hz) + connection flag. */
export function useEngineState(): EngineSnapshot {
  const link = useEngine();
  return useSyncExternalStore(link.subscribe, link.getSnapshot);
}

/** Latest thumbnail data-URL for one instance (~6.6 Hz). */
export function useThumb(id: string | null): string | undefined {
  const link = useEngine();
  return useSyncExternalStore(link.subscribeThumbs, () =>
    id == null ? undefined : link.thumb(id),
  );
}
```

- [ ] **Step 3.3: `packages/engine-app/src/ui/mod-types.ts`** — verbatim port of the table in the old `console.ts` (one row per modulator type; NFR-3: a new type is one zod variant in the runtime + one entry here):

```ts
export type ModField =
  | { key: string; label: string; kind: "number"; step: number; min?: number; max?: number }
  | { key: string; label: string; kind: "select"; options: string[] }
  | { key: string; label: string; kind: "values" };

export type ModTypeDesc = { type: string; bool: boolean; clocked: boolean; fields: ModField[] };

export const MOD_TYPES: ModTypeDesc[] = [
  { type: "sine", bool: false, clocked: true, fields: [] },
  { type: "triangle", bool: false, clocked: true, fields: [] },
  {
    type: "ramp", bool: false, clocked: true,
    fields: [{ key: "direction", label: "direction", kind: "select", options: ["up", "down"] }],
  },
  {
    type: "square", bool: true, clocked: true,
    fields: [{ key: "duty", label: "duty", kind: "number", step: 0.05, min: 0, max: 1 }],
  },
  { type: "random", bool: true, clocked: true, fields: [] },
  {
    type: "drift", bool: false, clocked: true,
    fields: [{ key: "smooth", label: "smooth s", kind: "number", step: 0.1, min: 0 }],
  },
  {
    type: "cycle", bool: true, clocked: true,
    fields: [
      { key: "order", label: "order", kind: "select", options: ["forward", "reverse", "pingpong", "random"] },
      { key: "values", label: "values", kind: "values" },
    ],
  },
  {
    type: "audio", bool: false, clocked: false,
    fields: [
      { key: "band", label: "band", kind: "select", options: ["rms", "bass", "mid", "treble"] },
      { key: "smooth", label: "smooth s", kind: "number", step: 0.01, min: 0 },
    ],
  },
];
```

- [ ] **Step 3.4: `packages/engine-app/src/ui/Disconnected.tsx`** — banner + the `body.disconnected` class validators check:

```tsx
import { Box } from "@mui/material";
import { useEffect } from "react";

export function Disconnected({ connected }: { connected: boolean }) {
  // validate-m4 reads document.body.classList on the staged page.
  useEffect(() => {
    document.body.classList.toggle("disconnected", !connected);
  }, [connected]);
  if (connected) return null;
  return (
    <Box
      id="disconnected"
      sx={{
        position: "fixed",
        left: 0,
        right: 0,
        bottom: 0,
        p: 1.25,
        textAlign: "center",
        bgcolor: "error.main",
        color: "#fff",
        zIndex: 2000,
      }}
    >
      engine not found — is the Output window (<code>/</code>) open?
    </Box>
  );
}
```

- [ ] **Step 3.5: Verify + commit:**

```bash
pnpm typecheck
git add packages/engine-app/src/ui
git commit -m "Console React refactor: theme, engine hooks, mod-types, Disconnected"
```

### Task 4: ParamWidget + ModPopover

**Files:**
- Create: `packages/engine-app/src/ui/console/ParamWidget.tsx`
- Create: `packages/engine-app/src/ui/console/ModPopover.tsx`

- [ ] **Step 4.1: `packages/engine-app/src/ui/console/ModPopover.tsx`:**

```tsx
import {
  Box, Button, NativeSelect, Popover, Slider, Stack, TextField, Typography,
} from "@mui/material";
import { useEffect, useState, type ReactNode } from "react";
import type { ParamDesc } from "../engine-link";
import { useEngine } from "../hooks";
import { MOD_TYPES } from "../mod-types";
import { fail } from "../util";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Stack direction="row" spacing={0.75} alignItems="center">
      <Typography variant="caption" color="text.secondary" sx={{ width: 44, flex: "0 0 auto" }}>
        {label}
      </Typography>
      {children}
    </Stack>
  );
}

type Props = {
  instance: string;
  path: string;
  p: ParamDesc;
  anchorEl: HTMLElement | null;
  onClose: () => void;
};

/** Attach/update/retrigger/detach a modulator on one param (port of the old popover). */
export function ModPopover({ instance, path, p, anchorEl, onClose }: Props) {
  const link = useEngine();
  const isBool = p.type === "bool";
  const types = MOD_TYPES.filter((d) => !isBool || d.bool);
  const min = typeof p.min === "number" ? p.min : 0;
  const max = typeof p.max === "number" ? p.max : 1;
  const open = anchorEl != null;
  const active = (p.modulator ?? null) as Record<string, unknown> | null;

  const [type, setType] = useState(types[0]?.type ?? "sine");
  const [rate, setRate] = useState("4");
  const [unit, setUnit] = useState<"beats" | "seconds">("beats");
  const [phase, setPhase] = useState("0");
  const [range, setRange] = useState<[number, number]>([min, max]);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [err, setErr] = useState("");

  // Seed the form from the active modulator each time the popover opens.
  useEffect(() => {
    if (!open) return;
    setErr("");
    if (!active) return;
    setType(String(active.type));
    if (active.periodBeats != null || active.periodSeconds != null) {
      setRate(String(active.periodBeats ?? active.periodSeconds));
      setUnit(active.periodBeats != null ? "beats" : "seconds");
    }
    if (typeof active.phase === "number") setPhase(String(active.phase));
    setRange([
      typeof active.lo === "number" ? active.lo : min,
      typeof active.hi === "number" ? active.hi : max,
    ]);
    const f: Record<string, string> = {};
    for (const d of MOD_TYPES) {
      for (const fd of d.fields) {
        const v = active[fd.key];
        if (v != null) f[fd.key] = Array.isArray(v) ? v.join(", ") : String(v);
      }
    }
    setFields(f);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const desc = MOD_TYPES.find((d) => d.type === type) ?? MOD_TYPES[0]!;

  const buildSpec = (): Record<string, unknown> => {
    const spec: Record<string, unknown> = { type };
    if (desc.clocked) {
      spec[unit === "beats" ? "periodBeats" : "periodSeconds"] = Number(rate) || 4;
      const ph = Number(phase);
      if (ph > 0) spec.phase = Math.min(ph, 1);
    }
    if (!isBool) {
      spec.lo = range[0];
      spec.hi = range[1];
    }
    for (const fd of desc.fields) {
      const raw = fd.kind === "select" ? (fields[fd.key] ?? fd.options[0]) : fields[fd.key];
      if (raw == null || raw === "") continue;
      if (fd.kind === "values") {
        const nums = raw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
        if (nums.length > 0) spec[fd.key] = nums;
      } else if (fd.kind === "number") spec[fd.key] = Number(raw);
      else spec[fd.key] = raw;
    }
    return spec;
  };

  const send = (spec: Record<string, unknown>) => {
    setErr("");
    void link
      .req("modulate_param", { instance, path, modulator: spec })
      .catch((e: Error) => setErr(String(e.message ?? e)));
  };

  return (
    <Popover
      open={open}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
      transformOrigin={{ vertical: "top", horizontal: "right" }}
    >
      <Box className="modpop" sx={{ p: 1.5, width: 300, display: "flex", flexDirection: "column", gap: 1 }}>
        <Row label="type">
          <NativeSelect value={type} onChange={(e) => setType(e.target.value)}>
            {types.map((d) => (
              <option key={d.type} value={d.type}>{d.type}</option>
            ))}
          </NativeSelect>
        </Row>
        {desc.clocked && (
          <Row label="every">
            <TextField
              type="number"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
              inputProps={{ min: 0.05, step: 0.25 }}
              sx={{ width: 76 }}
            />
            <NativeSelect value={unit} onChange={(e) => setUnit(e.target.value as "beats" | "seconds")}>
              <option value="beats">beats</option>
              <option value="seconds">seconds</option>
            </NativeSelect>
            <Typography variant="caption" color="text.secondary">phase</Typography>
            <TextField
              type="number"
              value={phase}
              onChange={(e) => setPhase(e.target.value)}
              inputProps={{ min: 0, max: 1, step: 0.05 }}
              sx={{ width: 68 }}
            />
          </Row>
        )}
        {!isBool && (
          <Row label="range">
            <Slider
              size="small"
              color="warning"
              value={range}
              min={min}
              max={max}
              step={p.type === "int" ? 1 : (max - min) / 200}
              onChange={(_, v) => setRange(v as [number, number])}
              sx={{ flex: 1, mx: 1 }}
            />
            <Typography variant="caption" sx={{ minWidth: 70, textAlign: "right" }}>
              {range[0].toFixed(2)}–{range[1].toFixed(2)}
            </Typography>
          </Row>
        )}
        {desc.fields.map((fd) => (
          <Row key={fd.key} label={fd.label}>
            {fd.kind === "select" ? (
              <NativeSelect
                value={fields[fd.key] ?? fd.options[0]}
                onChange={(e) => setFields((f) => ({ ...f, [fd.key]: e.target.value }))}
              >
                {fd.options.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </NativeSelect>
            ) : fd.kind === "values" ? (
              <TextField
                placeholder="0.2, 0.5, 0.8"
                value={fields[fd.key] ?? ""}
                onChange={(e) => setFields((f) => ({ ...f, [fd.key]: e.target.value }))}
                sx={{ flex: 1 }}
              />
            ) : (
              <TextField
                type="number"
                value={fields[fd.key] ?? ""}
                onChange={(e) => setFields((f) => ({ ...f, [fd.key]: e.target.value }))}
                inputProps={{
                  step: fd.step,
                  ...(fd.min !== undefined ? { min: fd.min } : {}),
                  ...(fd.max !== undefined ? { max: fd.max } : {}),
                }}
                sx={{ width: 84 }}
              />
            )}
          </Row>
        ))}
        {err !== "" && (
          <Typography variant="caption" color="error">{err}</Typography>
        )}
        <Stack direction="row" spacing={1}>
          <Button onClick={() => send(buildSpec())}>{active ? "update" : "attach"}</Button>
          {active && (
            <Button title="restart the wave at lo" onClick={() => send(active)}>⟲ retrigger</Button>
          )}
          {active && (
            <Button
              onClick={() => {
                void link.req("clear_modulation", { instance, path }).catch(fail);
                onClose();
              }}
            >
              detach
            </Button>
          )}
        </Stack>
      </Box>
    </Popover>
  );
}
```

- [ ] **Step 4.2: `packages/engine-app/src/ui/console/ParamWidget.tsx`:**

```tsx
import { Box, Button, IconButton, Slider, Stack, Switch, Typography } from "@mui/material";
import { useState, type InputHTMLAttributes, type MouseEvent } from "react";
import type { ParamDesc } from "../engine-link";
import { useEngine, useEngineState } from "../hooks";
import { fail, primeMidiPermission } from "../util";
import { ModPopover } from "./ModPopover";

type Props = {
  instance: string;
  path: string;
  p: ParamDesc;
  /** Display label (group-stripped); defaults to the full path. */
  label?: string;
  /** Rack rows hide the description to stay one line tall. */
  dense?: boolean;
};

/**
 * One param: name · modulator button (instances only) · MIDI-learn · value,
 * over a slider (float/int) or switch (bool). DOM contract for validators:
 * data-path lands on the real <input>, data-learn on the learn button with
 * exact text "M" / "···" / "cc<N>".
 */
export function ParamWidget({ instance, path, p, label, dense }: Props) {
  const link = useEngine();
  const { session } = useEngineState();
  const [drag, setDrag] = useState<number | null>(null);
  const [modAnchor, setModAnchor] = useState<HTMLElement | null>(null);

  const modulated = p.modulator != null;
  const min = typeof p.min === "number" ? p.min : 0;
  const max = typeof p.max === "number" ? p.max : 1;

  // Bindings are keyed by scene engine-side; resolve this instance to its scene.
  const scene =
    instance === "globals"
      ? "globals"
      : (session?.instances.find((i) => i.id === instance)?.scene ?? null);
  const binding =
    scene != null
      ? (session?.bindings.find((b) => b.scene === scene && b.path === path) ?? null)
      : null;
  const learning =
    scene != null &&
    session?.midi.learning != null &&
    session.midi.learning.scene === scene &&
    session.midi.learning.path === path;

  const valueText =
    p.type === "bool"
      ? String(p.value)
      : (drag ?? Number(p.value)).toFixed(p.type === "int" ? 0 : 3);

  const onLearn = (e: MouseEvent) => {
    e.stopPropagation();
    // No MIDI access yet? This click IS the user gesture — pop the prompt here.
    if (session?.midi.status !== "ready") primeMidiPermission();
    // bound → unbind; learning → cancel (engine toggles); unbound → arm
    const action = binding != null && !learning ? "midi_unbind" : "midi_learn";
    void link.req(action, { instance, path }).catch(fail);
  };

  const inputAttrs = { "data-path": path } as InputHTMLAttributes<HTMLInputElement>;

  return (
    <Box className={`widget${modulated ? " modulated" : ""}`} sx={{ mb: dense ? 0 : 1.5, width: dense ? 170 : "auto" }}>
      <Stack direction="row" spacing={0.5} alignItems="center">
        <Typography variant="body2" noWrap title={path} sx={{ flex: 1, minWidth: 0 }}>
          {label ?? path}
        </Typography>
        {instance !== "globals" && (
          <IconButton
            size="small"
            data-modbtn={path}
            title={
              modulated
                ? `modulated: ${String((p.modulator as { type?: unknown }).type)}`
                : "attach a modulator"
            }
            onClick={(e) => {
              e.stopPropagation();
              setModAnchor((a) => (a ? null : e.currentTarget));
            }}
            sx={{ color: modulated ? "warning.main" : "text.secondary", fontSize: 14, p: 0.25 }}
          >
            ∿
          </IconButton>
        )}
        <Button
          className="learnbtn"
          data-learn={path}
          onClick={onLearn}
          title={
            learning
              ? "move a controller… (click to cancel)"
              : binding
                ? `bound to cc${binding.cc} — click to unbind`
                : "MIDI-learn: click, then move a knob"
          }
          sx={{
            minWidth: 0,
            px: 0.75,
            py: 0,
            fontSize: 11,
            lineHeight: "18px",
            ...(learning
              ? {
                  bgcolor: "warning.main",
                  color: "#000",
                  borderColor: "warning.main",
                  animation: "learnpulse 0.9s infinite alternate",
                }
              : binding
                ? { color: "primary.main", borderColor: "primary.main" }
                : { color: "text.secondary" }),
          }}
        >
          {learning ? "···" : binding ? `cc${binding.cc}` : "M"}
        </Button>
        <Typography variant="body2" data-value={path} sx={{ minWidth: 48, textAlign: "right" }}>
          {valueText}
        </Typography>
      </Stack>
      {p.type === "bool" ? (
        <Switch
          size="small"
          checked={p.value === true}
          disabled={modulated}
          inputProps={inputAttrs}
          onChange={(e) => link.sendParam(instance, path, e.target.checked)}
        />
      ) : (
        <Slider
          size="small"
          min={min}
          max={max}
          step={p.type === "int" ? 1 : (p.step ?? (max - min) / 200)}
          value={drag ?? Number(p.value)}
          disabled={modulated}
          color={modulated ? "warning" : "primary"}
          onChange={(_, v) => {
            const n = v as number;
            setDrag(n); // local value wins over the 10 Hz broadcast mid-drag
            link.sendParam(instance, path, n);
          }}
          onChangeCommitted={() => setDrag(null)}
          slotProps={{ input: inputAttrs }}
        />
      )}
      {!dense && p.description != null && p.description !== "" && (
        <Typography variant="caption" color="text.secondary" component="div">
          {p.description}
        </Typography>
      )}
      {instance !== "globals" && (
        <ModPopover
          instance={instance}
          path={path}
          p={p}
          anchorEl={modAnchor}
          onClose={() => setModAnchor(null)}
        />
      )}
    </Box>
  );
}
```

Note: if `slotProps={{ input: inputAttrs }}` raises a type error on your installed MUI version, change the cast to `as InputHTMLAttributes<HTMLInputElement> & Record<string, unknown>` — do NOT drop the `data-path` attribute; validators need it on the input element.

- [ ] **Step 4.3: Verify + commit:**

```bash
pnpm typecheck
git add packages/engine-app/src/ui/console
git commit -m "Console React refactor: ParamWidget and ModPopover"
```

### Task 5: ParamPanel + Rack

**Files:**
- Create: `packages/engine-app/src/ui/console/ParamPanel.tsx`
- Create: `packages/engine-app/src/ui/console/Rack.tsx`

- [ ] **Step 5.1: `packages/engine-app/src/ui/console/ParamPanel.tsx`:**

```tsx
import {
  Accordion, AccordionDetails, AccordionSummary, Box, Typography,
} from "@mui/material";
import { useState } from "react";
import type { ParamDesc } from "../engine-link";
import { ParamWidget } from "./ParamWidget";

const GROUP_OPEN_KEY = "loom.pgroups.open";

function loadOpen(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(GROUP_OPEN_KEY) ?? "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
}

type Props = {
  instance: string | null;
  manifest: Record<string, ParamDesc> | undefined;
};

/**
 * Dotted param paths form collapsible groups: "logo.tiltX" lands in a "logo"
 * accordion labeled "tiltX"; dotless params stay flat on top. Open state
 * persists per group name (collapsed until the human opens it).
 */
export function ParamPanel({ instance, manifest }: Props) {
  const [open, setOpen] = useState<Record<string, boolean>>(loadOpen);
  const toggle = (group: string, isOpen: boolean) => {
    setOpen((o) => {
      const next = { ...o, [group]: isOpen };
      try {
        localStorage.setItem(GROUP_OPEN_KEY, JSON.stringify(next));
      } catch {
        // storage unavailable — groups just default closed each load
      }
      return next;
    });
  };

  const flat: Array<[string, ParamDesc]> = [];
  const groups = new Map<string, Array<[string, ParamDesc]>>();
  for (const [path, p] of Object.entries(manifest ?? {})) {
    const dot = path.indexOf(".");
    if (dot < 0) {
      flat.push([path, p]);
    } else {
      const g = path.slice(0, dot);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push([path, p]);
    }
  }
  const ready = instance != null && manifest != null;

  return (
    <Box
      component="aside"
      id="panel"
      sx={{
        flex: "0 0 320px",
        bgcolor: "background.paper",
        borderLeft: 1,
        borderColor: "divider",
        p: 1.75,
        overflowY: "auto",
      }}
    >
      <Typography id="paneltitle" variant="subtitle2" sx={{ mb: 1.5 }}>
        {ready ? instance : "no instance selected"}
      </Typography>
      <Box id="widgets">
        {ready && (
          <>
            {flat.map(([path, p]) => (
              <ParamWidget key={path} instance={instance} path={path} p={p} />
            ))}
            {[...groups.entries()].map(([group, entries]) => (
              <Accordion
                key={group}
                variant="outlined"
                disableGutters
                expanded={open[group] ?? false}
                onChange={(_, x) => toggle(group, x)}
                sx={{ mb: 1.5, bgcolor: "transparent" }}
              >
                <AccordionSummary
                  sx={{
                    minHeight: 36,
                    fontSize: 12,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    color: "text.secondary",
                  }}
                >
                  {group}
                </AccordionSummary>
                <AccordionDetails>
                  {entries.map(([path, p]) => (
                    <ParamWidget
                      key={path}
                      instance={instance}
                      path={path}
                      p={p}
                      label={path.slice(group.length + 1)}
                    />
                  ))}
                </AccordionDetails>
              </Accordion>
            ))}
          </>
        )}
      </Box>
    </Box>
  );
}
```

- [ ] **Step 5.2: `packages/engine-app/src/ui/console/Rack.tsx`:**

```tsx
import { Box, Stack, Typography } from "@mui/material";
import type { SessionSnapshot } from "@loom/sidecar/protocol";
import type { ParamDesc } from "../engine-link";
import { ParamWidget } from "./ParamWidget";

type Props = { session: SessionSnapshot; globals: Record<string, ParamDesc> };

/**
 * The input rack drawer (R6.4): every channel with a live meter and its
 * global tuning widgets. Toggled on "i" (or the header button).
 * DOM contract: .rackrow[data-name], .rackfill with inline style.width.
 */
export function Rack({ session: s, globals }: Props) {
  const names = Object.keys(s.inputs).sort();
  return (
    <Box
      id="rack"
      sx={{
        flex: "0 0 auto",
        maxHeight: "42vh",
        overflowY: "auto",
        bgcolor: "background.paper",
        borderTop: 1,
        borderColor: "divider",
        px: 1.75,
        pt: 1,
        pb: 1.5,
      }}
    >
      <Typography variant="caption" color="text.secondary" sx={{ letterSpacing: "0.08em" }}>
        INPUT RACK · tune channels globally · <kbd>i</kbd> toggles
      </Typography>
      {names.map((name) => (
        <RackRow key={name} name={name} level={s.inputs[name] ?? 0} globals={globals} />
      ))}
    </Box>
  );
}

function RackRow({
  name,
  level,
  globals,
}: {
  name: string;
  level: number;
  globals: Record<string, ParamDesc>;
}) {
  const enabled = globals[`inputs.${name}.enabled`]?.value === true;
  const params = Object.entries(globals).filter(([path]) => path.startsWith(`inputs.${name}.`));
  return (
    <Stack
      direction="row"
      className={`rackrow${enabled ? " enabled" : ""}`}
      data-name={name}
      spacing={1.75}
      alignItems="center"
      sx={{ py: 0.75, borderBottom: 1, borderColor: "divider", "&:last-child": { borderBottom: 0 } }}
    >
      <Box
        className="rackmeter"
        sx={{
          width: 90,
          height: 10,
          flex: "0 0 auto",
          bgcolor: "#0006",
          border: 1,
          borderColor: "divider",
          borderRadius: "5px",
          overflow: "hidden",
        }}
      >
        <Box
          className="rackfill"
          sx={{ height: "100%", bgcolor: enabled ? "primary.main" : "warning.main" }}
          style={{ width: `${Math.min(100, level * 100)}%` }}
        />
      </Box>
      <Typography className="rackname" sx={{ width: 80, flex: "0 0 auto", fontWeight: 700 }}>
        {name}
      </Typography>
      <Box sx={{ display: "flex", gap: 1.75, flex: 1, flexWrap: "wrap" }}>
        {params.map(([path, p]) => (
          <ParamWidget
            key={path}
            instance="globals"
            path={path}
            p={p}
            label={path.slice(`inputs.${name}.`.length)}
            dense
          />
        ))}
      </Box>
    </Stack>
  );
}
```

- [ ] **Step 5.3: Verify + commit:**

```bash
pnpm typecheck
git add packages/engine-app/src/ui/console
git commit -m "Console React refactor: ParamPanel and Rack"
```

### Task 6: Tile, TileGrid, StageStrip

**Files:**
- Create: `packages/engine-app/src/ui/console/Tile.tsx`
- Create: `packages/engine-app/src/ui/console/TileGrid.tsx`
- Create: `packages/engine-app/src/ui/console/StageStrip.tsx`

- [ ] **Step 6.1: `packages/engine-app/src/ui/console/Tile.tsx`:**

```tsx
import { Box, Button, Card, Stack, Typography } from "@mui/material";
import type { InstanceInfo } from "@loom/sidecar/protocol";
import { useEngine, useThumb } from "../hooks";
import { fail } from "../util";

type Props = {
  inst: InstanceInfo;
  isLive: boolean;
  isStaged: boolean;
  selected: boolean;
  solo: boolean;
  onSelect: (id: string) => void;
  onSolo: (id: string) => void;
};

/**
 * One instance tile. DOM contract: .tile[data-id], child <img> (src only once
 * a thumb arrives), .live-badge/.staged-badge with a "show" class, .stagebtn
 * with exact text "stage"/"unstage", drag carries "text/loom-instance".
 */
export function Tile({ inst, isLive, isStaged, selected, solo, onSelect, onSolo }: Props) {
  const link = useEngine();
  const thumb = useThumb(inst.id);
  const badgeSx = {
    fontSize: 11,
    fontWeight: 700,
    borderRadius: "4px",
    px: 0.75,
    py: 0.25,
  } as const;
  return (
    <Card
      className="tile"
      data-id={inst.id}
      variant="outlined"
      draggable
      onClick={() => onSelect(inst.id)}
      onDoubleClick={() => onSolo(inst.id)}
      onDragStart={(e) => e.dataTransfer.setData("text/loom-instance", inst.id)}
      sx={{
        cursor: "pointer",
        bgcolor: "background.paper",
        borderColor: selected ? "primary.main" : "divider",
        gridColumn: solo ? "1 / -1" : undefined,
      }}
    >
      <Box
        component="img"
        alt=""
        src={thumb}
        sx={{ width: "100%", aspectRatio: "16/9", objectFit: "cover", display: "block", bgcolor: "#000" }}
      />
      <Stack direction="row" spacing={1} alignItems="center" sx={{ px: 1.25, py: 0.75 }}>
        <Box
          component="span"
          className={`chip ${inst.status}`}
          title={inst.error ?? inst.status}
          sx={{ fontWeight: 700, color: inst.status === "ok" ? "primary.main" : "error.main" }}
        >
          {inst.status === "ok" ? "✓" : "✗"}
        </Box>
        <Typography className="name" variant="body2" noWrap sx={{ flex: 1, minWidth: 0 }}>
          {inst.id} · {inst.scene}
        </Typography>
        <Box
          component="span"
          className={`badge live-badge${isLive ? " show" : ""}`}
          sx={{ ...badgeSx, bgcolor: "error.main", color: "#fff", display: isLive ? "inline" : "none" }}
        >
          LIVE
        </Box>
        <Box
          component="span"
          className={`badge staged-badge${isStaged ? " show" : ""}`}
          sx={{ ...badgeSx, bgcolor: "warning.main", color: "#000", display: isStaged ? "inline" : "none" }}
        >
          STAGED
        </Box>
        <Button
          className="stagebtn"
          disabled={isLive}
          onClick={(e) => {
            e.stopPropagation();
            void link
              .req(isStaged ? "unstage" : "stage", isStaged ? {} : { instance: inst.id })
              .catch(fail);
          }}
          sx={{ px: 1, py: 0.25, fontSize: 12 }}
        >
          {isStaged ? "unstage" : "stage"}
        </Button>
        <Button
          className="destroybtn"
          disabled={isLive}
          title="destroy"
          onClick={(e) => {
            e.stopPropagation();
            void link.req("destroy_instance", { instance: inst.id }).catch(fail);
          }}
          sx={{ px: 1, py: 0.25, fontSize: 12, minWidth: 0 }}
        >
          ×
        </Button>
      </Stack>
    </Card>
  );
}
```

- [ ] **Step 6.2: `packages/engine-app/src/ui/console/TileGrid.tsx`:**

```tsx
import { Box } from "@mui/material";
import type { SessionSnapshot } from "@loom/sidecar/protocol";
import { Tile } from "./Tile";

type Props = {
  session: SessionSnapshot;
  selected: string | null;
  solo: string | null;
  onSelect: (id: string) => void;
  onSolo: (id: string) => void;
};

export function TileGrid({ session: s, selected, solo, onSelect, onSolo }: Props) {
  return (
    <Box
      id="grid"
      sx={{
        flex: 1,
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
        gap: 1.5,
        p: 1.5,
        alignContent: "start",
        overflowY: "auto",
      }}
    >
      {s.instances.map((inst) => (
        <Tile
          key={inst.id}
          inst={inst}
          isLive={inst.id === s.live}
          isStaged={inst.id === s.staged}
          selected={inst.id === selected}
          solo={inst.id === solo}
          onSelect={onSelect}
          onSolo={onSolo}
        />
      ))}
    </Box>
  );
}
```

- [ ] **Step 6.3: `packages/engine-app/src/ui/console/StageStrip.tsx`:**

```tsx
import {
  Box, Button, Checkbox, FormControlLabel, NativeSelect, Stack, Typography,
} from "@mui/material";
import { useEffect, useState } from "react";
import type { SessionSnapshot } from "@loom/sidecar/protocol";
import { useEngine } from "../hooks";
import { fail } from "../util";

type Props = { session: SessionSnapshot; onCreated: (id: string) => void };

/**
 * Scene picker + LIVE/STAGED pointers + unstage/arm/COMMIT, and the
 * drag-to-stage drop target (R9.3). DOM contract: #stagestrip, #scenepick
 * (native select), #createbtn, #unstage, #commit, #armagent.
 */
export function StageStrip({ session: s, onCreated }: Props) {
  const link = useEngine();
  const [dragOver, setDragOver] = useState(false);
  const [scene, setScene] = useState("");
  const scenes = s.availableScenes;

  // Keep the user's pick across library refreshes; default to the first scene.
  useEffect(() => {
    if (!scenes.includes(scene)) setScene(scenes[0] ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenes.join(",")]);

  const withScene = (id: string | null) => {
    if (id == null) return "—";
    const sc = s.instances.find((i) => i.id === id)?.scene;
    return sc && sc !== id ? `${id} · ${sc}` : id;
  };

  return (
    <Stack
      id="stagestrip"
      direction="row"
      spacing={2}
      alignItems="center"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("text/loom-instance")) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const id = e.dataTransfer.getData("text/loom-instance");
        if (id) void link.req("stage", { instance: id }).catch(fail);
      }}
      sx={{
        px: 1.75,
        py: 1,
        bgcolor: "background.paper",
        borderBottom: 1,
        borderColor: "divider",
        flex: "0 0 auto",
        outline: dragOver ? "2px dashed" : "none",
        outlineColor: "warning.main",
        outlineOffset: "-2px",
      }}
    >
      <NativeSelect value={scene} inputProps={{ id: "scenepick" }} onChange={(e) => setScene(e.target.value)}>
        {scenes.map((n) => (
          <option key={n} value={n}>{n}</option>
        ))}
      </NativeSelect>
      <Button
        id="createbtn"
        onClick={() => {
          if (!scene) return;
          void link
            .req("create_instance", { scene })
            .then((r) => onCreated((r as { instance: string }).instance))
            .catch(fail);
        }}
      >
        + instance
      </Button>
      <Typography variant="caption" color="text.secondary">LIVE</Typography>
      <Typography id="livename" sx={{ fontWeight: 700 }}>{withScene(s.live)}</Typography>
      <Typography variant="caption" color="text.secondary">STAGED</Typography>
      <Typography id="stagedname" sx={{ fontWeight: 700 }}>{withScene(s.staged)}</Typography>
      <Button id="unstage" disabled={s.staged == null} onClick={() => void link.req("unstage").catch(fail)}>
        unstage
      </Button>
      <Typography id="fadeinfo" variant="caption" color="text.secondary">
        {s.mix != null ? `crossfading ${(s.mix * 100).toFixed(0)}%` : ""}
      </Typography>
      <Box sx={{ flex: 1 }} />
      <FormControlLabel
        control={
          <Checkbox
            size="small"
            id="armagent"
            checked={s.agentCommitArmed}
            onChange={(e) => void link.req("arm_agent_commit", { armed: e.target.checked }).catch(fail)}
          />
        }
        label={<Typography variant="caption" color="text.secondary">agent commit</Typography>}
      />
      <Button
        id="commit"
        color="primary"
        disabled={s.staged == null || s.panicked}
        onClick={() => void link.req("commit", {}).catch(fail)}
        sx={{ fontWeight: 700, fontSize: 15, px: 2.5 }}
      >
        COMMIT
      </Button>
    </Stack>
  );
}
```

- [ ] **Step 6.4: Verify + commit:**

```bash
pnpm typecheck
git add packages/engine-app/src/ui/console
git commit -m "Console React refactor: Tile, TileGrid, StageStrip"
```

### Task 7: Header, ConsoleApp, console entry + html

**Files:**
- Create: `packages/engine-app/src/ui/console/Header.tsx`
- Create: `packages/engine-app/src/ui/console/ConsoleApp.tsx`
- Create: `packages/engine-app/src/ui/console/main.tsx`
- Replace: `packages/engine-app/console.html`

- [ ] **Step 7.1: `packages/engine-app/src/ui/console/Header.tsx`:**

```tsx
import { Box, Button, NativeSelect, Stack, Typography } from "@mui/material";
import { useEffect, useState } from "react";
import type { SessionSnapshot } from "@loom/sidecar/protocol";
import { useEngine } from "../hooks";
import { fail, primeMidiPermission } from "../util";

type Props = { session: SessionSnapshot; onToggleRack: () => void };

export function Header({ session: s, onToggleRack }: Props) {
  const link = useEngine();
  return (
    <Stack
      direction="row"
      spacing={2}
      alignItems="center"
      component="header"
      sx={{ px: 1.75, py: 1, bgcolor: "background.paper", borderBottom: 1, borderColor: "divider", flex: "0 0 auto" }}
    >
      <Typography>
        <Box component="b" id="bpm">{s.bpm.toFixed(0)}</Box>{" "}
        <Typography component="span" variant="caption" color="text.secondary">BPM</Typography>
      </Typography>
      <Button id="tap" onClick={() => void link.req("set_transport", { tap: true }).catch(fail)}>
        TAP
      </Button>
      <Box sx={{ width: 120, height: 10, bgcolor: "#0006", border: 1, borderColor: "divider", borderRadius: "5px", overflow: "hidden" }}>
        <Box
          id="rmsfill"
          sx={{ height: "100%", bgcolor: "primary.main", transition: "width 80ms linear" }}
          style={{ width: `${Math.min(100, s.rms * 220)}%` }}
        />
      </Box>
      <AudioPicker session={s} />
      <MidiStatus midi={s.midi} />
      <Button onClick={onToggleRack} title="input rack (i)">rack</Button>
      <Box sx={{ flex: 1 }} />
      <Typography id="fps" variant="caption" color="text.secondary">
        {`${s.fps.toFixed(0)} fps · f${s.frame}`}
      </Typography>
      <Button
        id="panic"
        color="error"
        variant={s.panicked ? "contained" : "outlined"}
        onClick={() => void link.req(s.panicked ? "resume" : "panic").catch(fail)}
        sx={{ fontWeight: 700, fontSize: 15, px: 2.5 }}
      >
        {s.panicked ? "RESUME" : "PANIC"}
      </Button>
    </Stack>
  );
}

/** Audio source picker: reflects the engine's mode unless the user is mid-interaction. */
function AudioPicker({ session: s }: { session: SessionSnapshot }) {
  const link = useEngine();
  const [focused, setFocused] = useState(false);
  const [value, setValue] = useState("test");
  useEffect(() => {
    if (focused) return;
    if (s.audioMode === "test") {
      setValue("test");
    } else if (s.audioMode === "mic") {
      setValue((v) =>
        v.startsWith("mic:") ? v : s.audioDevices[0] ? `mic:${s.audioDevices[0].id}` : v,
      );
    }
  }, [s.audioMode, s.audioDevices, focused]);
  return (
    <NativeSelect
      value={value}
      inputProps={{ id: "audiomode", title: "audio input" }}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onChange={(e) => {
        const v = e.target.value;
        setValue(v);
        void link
          .req("set_audio", v === "test" ? { mode: "test" } : { mode: "mic", deviceId: v.slice(4) || undefined })
          .catch(fail);
      }}
    >
      <option value="test">test signal</option>
      {s.audioDevices.map((d) => (
        <option key={d.id} value={`mic:${d.id}`}>{d.label}</option>
      ))}
    </NativeSelect>
  );
}

function MidiStatus({ midi }: { midi: SessionSnapshot["midi"] }) {
  let text: string;
  let title: string;
  if (midi.status !== "ready") {
    text = "MIDI: connect";
    title = "click to grant MIDI access (Chrome prompts once per site)";
  } else if (midi.devices.length === 0) {
    text = "MIDI: no devices";
    title = "access granted — plug in a controller, it hot-plugs";
  } else {
    text = `MIDI ${midi.devices.join(" · ")}`;
    title = "connected MIDI inputs";
  }
  return (
    <Typography
      id="midistat"
      variant="caption"
      title={title}
      onClick={primeMidiPermission}
      sx={{
        color: midi.status !== "ready" ? "warning.main" : midi.devices.length === 0 ? "text.secondary" : "text.primary",
        cursor: midi.status !== "ready" ? "pointer" : "default",
        textDecoration: midi.status !== "ready" ? "underline dotted" : "none",
      }}
    >
      {text}
    </Typography>
  );
}
```

- [ ] **Step 7.2: `packages/engine-app/src/ui/console/ConsoleApp.tsx`:**

```tsx
import { Box } from "@mui/material";
import { useEffect, useState } from "react";
import { Disconnected } from "../Disconnected";
import { useEngineState } from "../hooks";
import { Header } from "./Header";
import { ParamPanel } from "./ParamPanel";
import { Rack } from "./Rack";
import { StageStrip } from "./StageStrip";
import { TileGrid } from "./TileGrid";

export function ConsoleApp() {
  const { session, manifests, connected } = useEngineState();
  const [selected, setSelected] = useState<string | null>(null);
  const [solo, setSolo] = useState<string | null>(null);
  const [rackOpen, setRackOpen] = useState(false);

  // "i" toggles the rack — unless the human is typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "i") return;
      const t = e.target;
      if (
        t instanceof HTMLInputElement ||
        t instanceof HTMLSelectElement ||
        t instanceof HTMLTextAreaElement
      ) {
        return;
      }
      setRackOpen((o) => !o);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <Box sx={{ height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {session && (
        <>
          <Header session={session} onToggleRack={() => setRackOpen((o) => !o)} />
          <StageStrip session={session} onCreated={setSelected} />
          <Box component="main" sx={{ flex: 1, display: "flex", minHeight: 0 }}>
            <TileGrid
              session={session}
              selected={selected}
              solo={solo}
              onSelect={setSelected}
              onSolo={(id) => setSolo((cur) => (cur === id ? null : id))}
            />
            <ParamPanel
              instance={selected}
              manifest={selected != null ? manifests[selected] : undefined}
            />
          </Box>
          {rackOpen && <Rack session={session} globals={manifests.globals ?? {}} />}
        </>
      )}
      <Disconnected connected={connected} />
    </Box>
  );
}
```

- [ ] **Step 7.3: `packages/engine-app/src/ui/console/main.tsx`:**

```tsx
import { CssBaseline, GlobalStyles, ThemeProvider } from "@mui/material";
import { createRoot } from "react-dom/client";
import { EngineLink } from "../engine-link";
import { EngineProvider } from "../hooks";
import { theme } from "../theme";
import { ConsoleApp } from "./ConsoleApp";

// One link per tab; the random prefix keeps sibling tabs from resolving
// each other's responses on the shared channel.
const link = new EngineLink({ prefix: `c${Math.random().toString(36).slice(2, 8)}-` });

createRoot(document.getElementById("root")!).render(
  <ThemeProvider theme={theme}>
    <CssBaseline />
    <GlobalStyles
      styles={{
        "@keyframes learnpulse": { from: { opacity: 1 }, to: { opacity: 0.45 } },
      }}
    />
    <EngineProvider value={link}>
      <ConsoleApp />
    </EngineProvider>
  </ThemeProvider>,
);
```

(No `<StrictMode>`: the EngineLink is a page singleton created outside React; strict double-mounting buys nothing here.)

- [ ] **Step 7.4: Replace `packages/engine-app/console.html`** with:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>LOOM Console</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/ui/console/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 7.5: Smoke-test in the dev server.** Start `pnpm dev`, open `http://localhost:5173/` (Output) in one tab and `http://localhost:5173/console.html` in another. Verify: boot tile appears with a moving thumbnail; clicking it opens params; a slider drag visibly changes the Output; PANIC↔RESUME toggles; the rack opens on `i`. Then stop the dev server. (If you cannot open a browser in this environment, skip — Task 10's validators cover all of this headlessly.)

- [ ] **Step 7.6: Verify + commit:**

```bash
pnpm typecheck
git add packages/engine-app/src/ui packages/engine-app/console.html
git commit -m "Console React refactor: Header, ConsoleApp, console entry"
```

Note: `src/console.ts` is now orphaned but still typechecks; it is deleted in Task 9.

### Task 8: Staged page

**Files:**
- Create: `packages/engine-app/src/ui/staged/StagedApp.tsx`
- Create: `packages/engine-app/src/ui/staged/main.tsx`
- Replace: `packages/engine-app/staged.html`

- [ ] **Step 8.1: `packages/engine-app/src/ui/staged/StagedApp.tsx`:**

```tsx
import { Box, Button, Stack, Typography } from "@mui/material";
import { Disconnected } from "../Disconnected";
import { useEngine, useEngineState, useThumb } from "../hooks";
import { fail } from "../util";

/**
 * /staged.html — a focused second-tab/-display view of the currently staged
 * instance (R9.3): big preview, COMMIT, unstage. DOM contract: #stagedname,
 * #fadeinfo, #unstage, #commit, #preview, #empty (display toggles, both
 * always rendered).
 */
export function StagedApp() {
  const { session: s, connected } = useEngineState();
  const link = useEngine();
  const staged = s?.staged ?? null;
  const thumb = useThumb(staged);
  const scene = staged != null ? s?.instances.find((i) => i.id === staged)?.scene : undefined;
  const name = staged == null ? "—" : scene && scene !== staged ? `${staged} · ${scene}` : staged;
  const has = staged != null;

  return (
    <Box sx={{ height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <Stack
        direction="row"
        spacing={2}
        alignItems="center"
        component="header"
        sx={{ px: 1.75, py: 1, bgcolor: "background.paper", borderBottom: 1, borderColor: "divider", flex: "0 0 auto" }}
      >
        <Typography variant="caption" color="text.secondary">STAGED</Typography>
        <Typography id="stagedname" sx={{ fontWeight: 700 }}>{name}</Typography>
        <Typography id="fadeinfo" variant="caption" color="text.secondary">
          {s?.mix != null ? `crossfading ${(s.mix * 100).toFixed(0)}%` : ""}
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Button id="unstage" disabled={!has} onClick={() => void link.req("unstage").catch(fail)}>
          unstage
        </Button>
        <Button
          id="commit"
          color="primary"
          disabled={!has || s?.panicked === true}
          onClick={() => void link.req("commit", {}).catch(fail)}
          sx={{ fontWeight: 700, fontSize: 15, px: 2.5 }}
        >
          COMMIT
        </Button>
      </Stack>
      <Box
        id="view"
        sx={{ flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", bgcolor: "#000" }}
      >
        <Box
          component="img"
          id="preview"
          alt=""
          src={has ? thumb : undefined}
          sx={{
            maxWidth: "100%",
            maxHeight: "100%",
            objectFit: "contain",
            display: has && thumb ? "block" : "none",
          }}
        />
        <Typography id="empty" color="text.secondary" sx={{ display: has ? "none" : "block" }}>
          nothing staged — stage an instance from the Console
        </Typography>
      </Box>
      <Disconnected connected={connected} />
    </Box>
  );
}
```

- [ ] **Step 8.2: `packages/engine-app/src/ui/staged/main.tsx`:**

```tsx
import { CssBaseline, ThemeProvider } from "@mui/material";
import { createRoot } from "react-dom/client";
import { EngineLink } from "../engine-link";
import { EngineProvider } from "../hooks";
import { theme } from "../theme";
import { StagedApp } from "./StagedApp";

const link = new EngineLink({ prefix: `s${Math.random().toString(36).slice(2, 8)}-` });

createRoot(document.getElementById("root")!).render(
  <ThemeProvider theme={theme}>
    <CssBaseline />
    <EngineProvider value={link}>
      <StagedApp />
    </EngineProvider>
  </ThemeProvider>,
);
```

- [ ] **Step 8.3: Replace `packages/engine-app/staged.html`** with:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>LOOM — Staged</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/ui/staged/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 8.4: Verify + commit:**

```bash
pnpm typecheck
git add packages/engine-app/src/ui/staged packages/engine-app/staged.html
git commit -m "Console React refactor: staged page"
```

### Task 9: Delete legacy pages, update validate-m3's slider write

**Files:**
- Delete: `packages/engine-app/src/console.ts`
- Delete: `packages/engine-app/src/staged.ts`
- Modify: `scripts/validate-m3.mjs` (lines ~228–232)

- [ ] **Step 9.1: Delete the old page scripts:**

```bash
git rm packages/engine-app/src/console.ts packages/engine-app/src/staged.ts
```

- [ ] **Step 9.2: Confirm nothing still references them:**

```bash
git grep -n "src/console.ts\|src/staged.ts" -- . ':!docs'
```

Expected: no matches (or only matches inside `docs/`).

- [ ] **Step 9.3: Update the slider write in `scripts/validate-m3.mjs`.** Find:

```js
  await consolePage.waitForSelector('[data-path="size"]', { timeout: 5_000 });
  await consolePage.$eval('[data-path="size"]', (el) => {
    el.value = "0.25";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
```

Replace with:

```js
  // The param input is MUI Slider's hidden <input type="range"> — attached
  // but not "visible" to Playwright, and React dedupes direct .value writes
  // through its value tracker, so write through the prototype setter.
  await consolePage.waitForSelector('[data-path="size"]', { state: "attached", timeout: 5_000 });
  await consolePage.$eval('[data-path="size"]', (el) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    set.call(el, "0.25");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
```

This is the only validator change. It still drives the param through the page UI (same event path a real input uses); it does not bypass the Console.

- [ ] **Step 9.4: Verify + commit:**

```bash
pnpm typecheck
git add scripts/validate-m3.mjs
git commit -m "Console React refactor: drop legacy pages; React-safe slider write in validate-m3"
```

### Task 10: Full verification + docs

- [ ] **Step 10.1: Unit tests + typecheck:**

```bash
pnpm typecheck
pnpm test
```

Expected: both PASS (runtime, sidecar, and the new engine-app tests).

- [ ] **Step 10.2: Run every validator** (each spins its own Vite on an isolated port; run them one at a time):

```bash
pnpm validate:m0
pnpm validate:m1
pnpm validate:m2
pnpm validate:m3
pnpm validate:m4
pnpm validate:m5
pnpm validate:modulators
```

Expected: every script ends with all checks ✓ and exit code 0. Triage notes:

- m0/m1/m2/modulators don't touch the cockpit DOM — a failure there means the build wiring changed engine behavior; check that `vite.config.ts` is untouched and `index.html`/`src/main.ts` are untouched (`git diff main -- packages/engine-app/vite.config.ts packages/engine-app/index.html packages/engine-app/src/main.ts` must be empty).
- m3 "console slider writes through to the manifest" failing → MUI Slider's hidden input didn't propagate the synthetic event. Apply Fallback F1 below, then re-run.
- m3 "console scene picker creates an instance" failing → `#scenepick` isn't a native `<select>`; confirm `NativeSelect` with `inputProps={{ id: "scenepick" }}`.
- m4 drag-to-stage failing → check the tile has the `draggable` attribute and `#stagestrip` handlers call `preventDefault()` in BOTH `onDragOver` and `onDrop`.
- m5 learn-button text failing → `textContent` must be exactly `cc21` / `···` / `M`; check for stray whitespace in the Button children (write the label as a single expression, never `{" "}`-separated).
- m5 rack meter failing → `.rackfill` width must be an **inline style** (the `style` prop, not `sx`).

- [ ] **Step 10.3: Append a DECISIONS.md entry** (newest at bottom) to `loom/DECISIONS.md`:

```markdown
## 2026-06-11 — Console + Staged pages rebuilt on React + MUI

The cockpit pages outgrew hand-rolled DOM diffing (console.ts was ~800 lines of
querySelector bookkeeping). Both pages are now React 19 + @mui/material 7 apps
under `packages/engine-app/src/ui/`, with a framework-free `EngineLink` class
(unit-tested) owning the BroadcastChannel protocol. Deliberate choices:
- **No @vitejs/plugin-react.** Vite's esbuild compiles .tsx natively
  (`"jsx": "react-jsx"` in tsconfig.base.json); vite.config.ts is unchanged, so
  the scenes HMR path — never-go-black layer 1 — is provably untouched. Editing
  a cockpit .tsx full-reloads the cockpit tab only; the Output window doesn't care.
- **The validator DOM contract is preserved** (.tile[data-id], #commit, #panic,
  data-path on the real input, data-learn text M/···/cc<N>, .rackfill inline
  width, body.disconnected). One validator change: validate-m3 writes the slider
  through HTMLInputElement's prototype value setter because React dedupes direct
  .value writes (and waits with state:"attached" since MUI's range input is
  visually hidden).
- The Output window (index.html + src/main.ts) stays vanilla on purpose: it is a
  pure projector surface; a React tree there buys nothing and risks the render loop.
```

- [ ] **Step 10.4: Append to `loom/agent-updates.md`:**

```markdown
## 2026-06-11 — Console/Staged React + MUI refactor

Rebuilt /console.html and /staged.html as React 19 + MUI 7 apps
(packages/engine-app/src/ui/): EngineLink channel client with vitest coverage,
ParamWidget/ModPopover/Rack/Tile components, dark theme matching the old
palette. Engine, runtime, sidecar, and the Output window untouched; all
validators (m0–m5, modulators) green; validate-m3's slider write updated to the
React-safe native setter.
```

- [ ] **Step 10.5: Commit docs:**

```bash
git add DECISIONS.md agent-updates.md
git commit -m "Docs: record Console React+MUI refactor decisions"
```

- [ ] **Step 10.6: Final check before handing back.** Confirm the branch diff touches nothing it shouldn't:

```bash
git diff main --stat -- packages/runtime packages/sidecar packages/engine-app/src/main.ts packages/engine-app/index.html packages/engine-app/vite.config.ts content
```

Expected: empty output. Then report done — do NOT merge to main yourself; merging is gated on the human reviewing the cockpit by eye (use superpowers:finishing-a-development-branch).

---

## Fallback F1 — native range slider (apply ONLY if m3's slider check fails)

If `validate-m3` fails specifically at "console slider writes through to the manifest" after Task 10, MUI Slider's hidden input isn't propagating synthetic input events on your installed version. Replace the `<Slider …/>` block in `ParamWidget.tsx` with a styled native range input (this is exactly the old widget, React-managed — the validator's native-setter write works against any React-controlled `<input type="range">`):

```tsx
        <Box
          component="input"
          type="range"
          data-path={path}
          min={min}
          max={max}
          step={p.type === "int" ? 1 : (p.step ?? (max - min) / 200)}
          value={String(drag ?? Number(p.value))}
          disabled={modulated}
          onPointerDown={() => setDrag(Number(p.value))}
          onPointerUp={() => setDrag(null)}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
            const n = Number(e.target.value);
            setDrag(n);
            link.sendParam(instance, path, n);
          }}
          sx={{ width: "100%", accentColor: modulated ? "#f3c969" : "#3ddc97" }}
        />
```

Also revert the `state: "attached"` option in validate-m3 to the default if you apply this (a native range input is visible), though leaving `state: "attached"` is harmless either way. Add `import type { ChangeEvent } from "react"` if needed and drop the unused `Slider`/`InputHTMLAttributes` imports.

## Execution notes for the implementer

- Work strictly task-by-task; run the verify step of each task before committing.
- Never edit `packages/engine-app/vite.config.ts`, `index.html`, or `src/main.ts` — if you think you need to, stop and re-read the plan; you don't.
- If `pnpm dev` is already running in another terminal (a live session), the validators are still safe to run — they use isolated ports and pin/restore the live scene.
- MUI import style: named imports from `@mui/material` (matches the code above); don't add `@mui/icons-material`.
- TypeScript here is strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`). If a prop type fights you on `undefined`, prefer conditional spreads (`...(x !== undefined ? { x } : {})`) over `!` assertions.
