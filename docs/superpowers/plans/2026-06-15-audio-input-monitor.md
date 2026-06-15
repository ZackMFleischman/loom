# Audio Input Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a human-driven Console toggle (with a hover-reveal volume slider) that plays the mic/loopback audio input through the speakers, so the operator can hear the music they drive visuals with.

**Architecture:** `AudioBus` gains a persistent `monitorGain` node wired to `ctx.destination`; the mic source feeds it in addition to the analyser. A new `set_monitor` engine request (Console-only, never registered as an MCP tool) sets the gain. The snapshot carries `monitorEnabled`/`monitorLevel`, and a `MonitorControl` component in the Console header drives it.

**Tech Stack:** TypeScript, Web Audio API (`GainNode`), zod (protocol), React + MUI (Console), Vitest (runtime tests).

---

## File Structure

- `packages/runtime/src/inputbus/audio.ts` — **modify**: monitor gain node + `setMonitor` + state fields; `startMic`/`stop` wiring.
- `packages/runtime/test/audio.test.ts` — **create**: unit test for monitor gain behavior (stubbed `AudioContext`).
- `packages/sidecar/src/protocol.ts` — **modify**: add `set_monitor` to `RequestType`, add `SetMonitorArgs`, add `monitorEnabled`/`monitorLevel` to `SessionSnapshot`.
- `packages/engine-app/src/engine-api.ts` — **modify**: extend `EngineDeps.audio` type, add `set_monitor` case + `HUMAN_ONLY` entry, add the two snapshot fields, import `SetMonitorArgs`.
- `packages/engine-app/src/debug-surface.ts` — **modify**: mirror the two fields onto `window.__loom`.
- `packages/engine-app/src/ui/console/Header.tsx` — **modify**: add `MonitorControl` component next to `AudioPicker`.

**Note:** `set_monitor` is added to the protocol `RequestType` (shared by the Console `link.req` channel) and to the engine handler, but is **NOT** added to the `TOOLS` array in `packages/sidecar/src/index.ts`. That is what keeps it off the MCP/agent surface while letting the Console call it.

---

## Task 1: AudioBus monitor gain path

**Files:**
- Test: `packages/runtime/test/audio.test.ts` (create)
- Modify: `packages/runtime/src/inputbus/audio.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/runtime/test/audio.test.ts`. The runtime vitest environment is `node`, so there is no real `AudioContext` — stub a minimal one before constructing the bus.

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioBus } from "../src/inputbus/audio";

// Minimal fake nodes — only what ensureContext()/setMonitor() touch.
class FakeGain {
  gain = { value: 1 };
  connect = vi.fn();
  disconnect = vi.fn();
}
class FakeAnalyser {
  fftSize = 0;
  smoothingTimeConstant = 0;
  frequencyBinCount = 1024;
  connect = vi.fn();
  disconnect = vi.fn();
  getByteFrequencyData = vi.fn();
}
class FakeAudioContext {
  sampleRate = 48000;
  currentTime = 0;
  destination = {} as AudioNode;
  state = "running";
  createAnalyser() {
    return new FakeAnalyser();
  }
  createGain() {
    return new FakeGain();
  }
  resume() {
    return Promise.resolve();
  }
}

beforeEach(() => {
  vi.stubGlobal("AudioContext", FakeAudioContext);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AudioBus monitor", () => {
  it("defaults to off (gain 0) and exposes default state", () => {
    const bus = new AudioBus();
    expect(bus.monitorEnabled).toBe(false);
    expect(bus.monitorLevel).toBeCloseTo(0.8);
  });

  it("setMonitor enabled applies the level to the gain node", () => {
    const bus = new AudioBus();
    bus.setMonitor({ enabled: true, level: 0.5 });
    expect(bus.monitorEnabled).toBe(true);
    expect(bus.monitorLevel).toBeCloseTo(0.5);
    expect(bus.monitorGainValue).toBeCloseTo(0.5);
  });

  it("disabled forces gain to 0 but remembers the level", () => {
    const bus = new AudioBus();
    bus.setMonitor({ level: 0.7 });
    bus.setMonitor({ enabled: false });
    expect(bus.monitorLevel).toBeCloseTo(0.7);
    expect(bus.monitorGainValue).toBe(0);
    bus.setMonitor({ enabled: true });
    expect(bus.monitorGainValue).toBeCloseTo(0.7);
  });

  it("clamps level to 0..1", () => {
    const bus = new AudioBus();
    bus.setMonitor({ enabled: true, level: 5 });
    expect(bus.monitorLevel).toBe(1);
    bus.setMonitor({ level: -2 });
    expect(bus.monitorLevel).toBe(0);
  });

  it("survives a stop() — monitor state persists", () => {
    const bus = new AudioBus();
    bus.setMonitor({ enabled: true, level: 0.6 });
    bus.stop();
    expect(bus.monitorEnabled).toBe(true);
    expect(bus.monitorLevel).toBeCloseTo(0.6);
    expect(bus.monitorGainValue).toBeCloseTo(0.6);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @loom/runtime exec vitest run test/audio.test.ts`
Expected: FAIL — `bus.setMonitor is not a function` / `monitorEnabled` undefined.

- [ ] **Step 3: Implement the monitor path in `audio.ts`**

In `packages/runtime/src/inputbus/audio.ts`, add fields alongside the existing private state (near line 33–41):

```ts
  /** Input monitoring: route the mic source to the speakers (R: hear the input). */
  monitorEnabled = false;
  monitorLevel = 0.8;
  private monitorGain: GainNode | null = null;
```

Add a test-only readback getter (used by the unit test; harmless in production):

```ts
  /** Current effective monitor gain (0 when disabled). For tests/diagnostics. */
  get monitorGainValue(): number {
    return this.monitorGain?.gain.value ?? 0;
  }
```

Add the public method (place it just after `resume()`, near line 154):

```ts
  /**
   * Toggle/level the input monitor. Effective gain is `enabled ? level : 0`, so
   * the toggle and the level are independent — you can pre-set the level while
   * muted, and flipping the toggle re-applies the stored level. Human-only path
   * (Console); never an MCP tool. Mic mode only — the synthetic "test" graph is
   * deliberately muted and never feeds the monitor.
   */
  setMonitor(opts: { enabled?: boolean; level?: number }): void {
    if (opts.level !== undefined) {
      this.monitorLevel = Math.max(0, Math.min(1, opts.level));
    }
    if (opts.enabled !== undefined) this.monitorEnabled = opts.enabled;
    this.ensureContext();
    if (this.monitorGain) {
      this.monitorGain.gain.value = this.monitorEnabled ? this.monitorLevel : 0;
    }
  }
```

In `ensureContext()` (near line 182–192), create the monitor gain once, wired to the destination and carrying the current setting:

```ts
  private ensureContext(): AudioContext {
    if (!this.audioCtx) {
      this.audioCtx = new AudioContext();
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.5;
      this.bins = new Uint8Array(this.analyser.frequencyBinCount);
      // Persistent monitor tap: lives for the context's life so it survives
      // source swaps. Starts at the current effective gain (0 when off).
      this.monitorGain = this.audioCtx.createGain();
      this.monitorGain.gain.value = this.monitorEnabled ? this.monitorLevel : 0;
      this.monitorGain.connect(this.audioCtx.destination);
    }
    void this.audioCtx.resume();
    return this.audioCtx;
  }
```

In `startMic()`, after `src.connect(this.analyser!)` (near line 90), also feed the monitor:

```ts
    src.connect(this.analyser!);
    if (this.monitorGain) src.connect(this.monitorGain);
    this.sourceNodes.push(src);
```

(`stop()` needs no change: the `sourceNodes` disconnect loop already detaches `src` from both targets, and `monitorGain` intentionally persists on the context. `startTest` is untouched — the synthetic graph never connects to `monitorGain`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @loom/runtime exec vitest run test/audio.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/inputbus/audio.ts packages/runtime/test/audio.test.ts
git commit -m "feat(runtime): AudioBus input monitor (gain tap to destination)"
```

---

## Task 2: Protocol — request verb, args, snapshot fields

**Files:**
- Modify: `packages/sidecar/src/protocol.ts`

- [ ] **Step 1: Add `set_monitor` to `RequestType`**

In the `RequestType` enum (line 45–83), add the verb after `"set_audio"`:

```ts
  "set_audio",
  "set_monitor",
  "set_preview",
```

- [ ] **Step 2: Add the `SetMonitorArgs` schema**

After `SetAudioArgs` (line 453), add:

```ts
export const SetMonitorArgs = z.object({
  enabled: z.boolean().optional(),
  level: z.number().min(0).max(1).optional(),
});
export type SetMonitorArgs = z.infer<typeof SetMonitorArgs>;
```

- [ ] **Step 3: Add snapshot fields**

In `SessionSnapshot` (after `audioDevices`, line 725), add:

```ts
  audioDevices: z.array(AudioDevice),
  /** Input monitor (Console-only): play the mic input through the speakers. */
  monitorEnabled: z.boolean().default(false),
  monitorLevel: z.number().default(0.8),
```

(Defaults keep older engine snapshots parsing.)

- [ ] **Step 4: Typecheck the package**

Run: `pnpm --filter @loom/sidecar exec tsc --noEmit`
Expected: PASS (no errors).

- [ ] **Step 5: Commit**

```bash
git add packages/sidecar/src/protocol.ts
git commit -m "feat(protocol): set_monitor verb + monitor snapshot fields"
```

---

## Task 3: Engine API — handler, deps type, snapshot

**Files:**
- Modify: `packages/engine-app/src/engine-api.ts`

- [ ] **Step 1: Import `SetMonitorArgs`**

In the `@loom/sidecar/protocol` import block (line 36, alphabetically near `SetAudioArgs`):

```ts
  SetAudioArgs,
  SetMonitorArgs,
```

- [ ] **Step 2: Mark it human-only**

In the `HUMAN_ONLY` set (line 71–83), add after `"set_audio"`:

```ts
  "set_audio",
  "set_monitor",
```

- [ ] **Step 3: Extend the `audio` deps type**

In `EngineDeps` (line 136–140), extend the `audio` member:

```ts
  audio: AudioBusLike & {
    mode: string;
    monitorEnabled: boolean;
    monitorLevel: number;
    startMic(deviceId?: string): Promise<void>;
    startTest(bpm?: number): void;
    setMonitor(opts: { enabled?: boolean; level?: number }): void;
  };
```

- [ ] **Step 4: Add the request handler**

After the `set_audio` case (ends line 735), add:

```ts
      case "set_monitor": {
        const { enabled, level } = SetMonitorArgs.parse(req.args);
        this.deps.audio.setMonitor({ enabled, level });
        return {
          monitorEnabled: this.deps.audio.monitorEnabled,
          monitorLevel: this.deps.audio.monitorLevel,
        };
      }
```

- [ ] **Step 5: Add snapshot fields**

In the snapshot builder, after `audioDevices: this.deps.audioDevices(),` (line 984):

```ts
      audioDevices: this.deps.audioDevices(),
      monitorEnabled: this.deps.audio.monitorEnabled,
      monitorLevel: this.deps.audio.monitorLevel,
```

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @loom/engine-app exec tsc --noEmit`
Expected: PASS. (The `audio` dep in `main.ts` is the real `AudioBus`, which now has these members — no `main.ts` change needed.)

- [ ] **Step 7: Commit**

```bash
git add packages/engine-app/src/engine-api.ts
git commit -m "feat(engine): set_monitor handler + monitor snapshot fields"
```

---

## Task 4: Debug surface mirror

**Files:**
- Modify: `packages/engine-app/src/debug-surface.ts`

- [ ] **Step 1: Read the current shape**

Open `packages/engine-app/src/debug-surface.ts`. Note the `audioMode` field on the debug type (line ~9) and where it is assigned (lines ~94 and ~124).

- [ ] **Step 2: Add the type fields**

Next to `audioMode: string;` (line ~9), add:

```ts
  audioMode: string;
  monitorEnabled: boolean;
  monitorLevel: number;
```

- [ ] **Step 3: Assign them where `audioMode` is set**

At each assignment site (the snapshot builder near line 94 and the per-frame update near line 124), mirror the audio fields. For the builder block (near line 94):

```ts
      audioMode: d.audio.mode,
      monitorEnabled: d.audio.monitorEnabled,
      monitorLevel: d.audio.monitorLevel,
```

For the per-frame update (near line 124):

```ts
    dbg.audioMode = audio.mode;
    dbg.monitorEnabled = audio.monitorEnabled;
    dbg.monitorLevel = audio.monitorLevel;
```

(Match the exact local variable names — `d.audio` / `audio` — already used at each site.)

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @loom/engine-app exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine-app/src/debug-surface.ts
git commit -m "feat(engine): mirror monitor state on window.__loom"
```

---

## Task 5: Console `MonitorControl` with hover slider

**Files:**
- Modify: `packages/engine-app/src/ui/console/Header.tsx`

- [ ] **Step 1: Add MUI imports**

In the `@mui/material` import block (line 1–17), add `Popper`, `Slider`, and `Paper`:

```ts
  NativeSelect,
  Paper,
  Popper,
  Radio,
  Slider,
```

- [ ] **Step 2: Render `<MonitorControl>` in the header**

Right after `<AudioPicker session={s} />` (line 94), add:

```tsx
      <AudioPicker session={s} />
      <MonitorControl session={s} />
```

- [ ] **Step 3: Implement the component**

Add this component near `AudioPicker` (e.g. after it, around line 476). The button toggles monitoring; hovering the wrapper reveals a `Popper` with the volume slider. State follows the snapshot except while the user is dragging, and persists in `localStorage` (re-applied on first connect, mirroring `PanicControls`).

```tsx
const MONITOR_KEY = "loom.monitor";

/**
 * Input monitor: play the mic/loopback input through the speakers. A 🔊 MON
 * toggle; hovering it reveals a volume slider in a popover. Disabled in test
 * mode (the synthetic signal is intentionally muted). Human-only — not an MCP
 * tool. Persists enabled/level in localStorage and re-applies on first connect.
 */
function MonitorControl({ session: s }: { session: SessionSnapshot }) {
  const link = useEngine();
  const anchorRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [level, setLevel] = useState(s.monitorLevel);
  const synced = useRef(false);
  const isTest = s.audioMode === "test";

  // First connect: re-apply the persisted choice (engine boots monitor off).
  useEffect(() => {
    if (synced.current) return;
    synced.current = true;
    try {
      const saved = JSON.parse(localStorage.getItem(MONITOR_KEY) ?? "null") as
        | { enabled: boolean; level: number }
        | null;
      if (saved) {
        setLevel(saved.level);
        void link.req("set_monitor", { enabled: saved.enabled, level: saved.level }).catch(fail);
      }
    } catch {
      // ignore malformed persisted state
    }
  }, [link]);

  // Reflect the snapshot unless mid-drag.
  useEffect(() => {
    if (!dragging) setLevel(s.monitorLevel);
  }, [s.monitorLevel, dragging]);

  const persist = (enabled: boolean, lvl: number) =>
    localStorage.setItem(MONITOR_KEY, JSON.stringify({ enabled, level: lvl }));

  const toggle = () => {
    const next = !s.monitorEnabled;
    persist(next, level);
    void link.req("set_monitor", { enabled: next }).catch(fail);
  };

  const onSlide = (v: number) => {
    setLevel(v);
    persist(s.monitorEnabled, v);
    void link.req("set_monitor", { level: v }).catch(fail);
  };

  return (
    <Box
      ref={anchorRef}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      sx={{ display: "inline-flex" }}
    >
      <Button
        id="monitorbtn"
        variant={s.monitorEnabled ? "contained" : "outlined"}
        color={s.monitorEnabled ? "primary" : "inherit"}
        disabled={isTest}
        onClick={toggle}
        title={
          isTest
            ? "monitoring applies to a mic/loopback input — switch off the test signal"
            : "play the audio input through your speakers"
        }
        sx={{ fontWeight: 700, minWidth: "unset", px: 1 }}
      >
        🔊 MON
      </Button>
      <Popper open={hover && !isTest} anchorEl={anchorRef.current} placement="bottom" sx={{ zIndex: 1300 }}>
        <Paper sx={{ px: 2, py: 1.5, mt: 0.5, width: 160 }}>
          <Typography variant="caption" color="text.secondary">
            monitor level
          </Typography>
          <Slider
            id="monitorlevel"
            size="small"
            min={0}
            max={1}
            step={0.01}
            value={level}
            onChange={(_, v) => {
              setDragging(true);
              onSlide(v as number);
            }}
            onChangeCommitted={() => setDragging(false)}
          />
        </Paper>
      </Popper>
    </Box>
  );
}
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @loom/engine-app exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine-app/src/ui/console/Header.tsx
git commit -m "feat(console): input monitor toggle + hover volume slider"
```

---

## Task 6: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck the workspace**

Run: `pnpm typecheck`
Expected: PASS (regenerates CATALOG, then `tsc --noEmit` over packages + content, no errors).

- [ ] **Step 2: Run unit tests**

Run: `pnpm test`
Expected: PASS, including the new `packages/runtime/test/audio.test.ts` (5 tests).

- [ ] **Step 3: Run acceptance suites that touch the snapshot/audio**

Run: `pnpm validate:m1` then `pnpm validate:m4`
Expected: PASS. If a suite asserts the exact snapshot shape and trips on the two new fields, update that suite's fixture/expectation to include `monitorEnabled`/`monitorLevel` (defaults `false`/`0.8`), then re-run.

- [ ] **Step 4: Manual smoke (optional but recommended)**

With `pnpm dev` running and a real input device selected in the Console audio picker, click `🔊 MON` → audio should play through the speakers; hover the button → slider appears and rides the level live; switch to "test signal" → the button disables.

- [ ] **Step 5: Final commit (if any fixture changes were needed)**

```bash
git add -A
git commit -m "test: extend m1/m4 fixtures for monitor snapshot fields"
```

---

## Self-Review

- **Spec coverage:** AudioBus path (Task 1) · mic-only/off-by-default/level-0.8 defaults (Task 1) · `set_monitor` Console-only verb + human-only + no MCP registration (Tasks 2–3, note at top) · snapshot fields (Tasks 2–3) · debug-surface mirror (Task 4) · Console toggle + hover slider + persistence (Task 5) · runtime unit test (Task 1) · typecheck/test/validate green (Task 6). All spec sections covered.
- **Type consistency:** `setMonitor({ enabled?, level? })`, `monitorEnabled`, `monitorLevel`, `monitorGainValue` are used identically across runtime, deps type, handler, snapshot, and Console. `SetMonitorArgs` matches the handler destructure. Snapshot field names match across protocol/engine/debug-surface/Console.
- **Placeholders:** none — every code step shows complete code.
