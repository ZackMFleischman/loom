# M6 Color Palettes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The palette half of M6 — a kernel `color` param type, two global 5-stop palettes (`primary`/`secondary`) on the `"globals"` manifest, scene consumption via `ctx.palette.color(i)` / `ctx.palette.ramp(t)` / `ctx.palette.own([...])` with a per-frame-resolved `palette.source` switch (no rebuild), Console/staged source selector + swatch editing, and the palette portion of `validate:m6`.

**Architecture:** Follows the input-rack pattern exactly: a `PaletteRegistry` in `@loom/runtime` owns a second globals-side `Manifest` (`palette.primary.0`…`palette.secondary.4`, all `color` params); the engine serves it through the existing `get_manifest`/`set_param` dispatch by merging it with the input rack's manifest under the `"globals"` pseudo-instance, routed by path prefix. Scene-side, `ctx.palette.*` collects color uniforms / one 256×1 `DataTexture` per build and registers a single per-frame updater that resolves the active source (`palette.source` int param: 0=primary, 1=secondary, 2=own) and re-tints uniforms / re-uploads the ramp only when the resolved stops change — switching palettes is a plain `set_param`, instant, zero rebuild (R7.2). Roles on stop indices (bg/edge/core/accent) stay documented convention, not kernel vocabulary (R7.1).

**Tech Stack:** TypeScript, zod, three/TSL (`uniform(new Color())`, `DataTexture`), React 19 + MUI 7 (Console), vitest (runtime unit tests), Playwright + MCP client + pngjs (acceptance).

**Scope notes (decisions locked here):**
- `palette.source` is an **int param 0..2** with a new optional `labels` meta field on ranged specs (`["primary","secondary","own"]`). Ints keep the whole existing machinery working for free: MIDI-learn can ride it, `cycle` modulators can flip palettes on beat, persistence stays `number|boolean|string`.
- The source param's **default depends on whether the scene called `own()`** (own if so, primary otherwise). Since `own()` may be called at any point during build, the param is declared in a new `BuildCtx.finalize()` hook that `buildInstance` calls right after `scene.build(ctx)`.
- "own" with no `own()` stops **falls back to primary live** (documented; keeps the 3-way switch total).
- Invalid color writes **throw** (the "format-validating clamp") — `set_param` surfaces a clean error to agents; the two state-restore loops get per-param try/catch hardening so a corrupt JSON file can never break boot.
- A **`builds` counter** is added per session entry (1 on create, ++ on successful rebuild), exposed in `get_session` and `window.__loom`. The M6 shipped-when demands "no rebuild" assertions twice; the chains half will need it too.
- Modulators **reject color params** at attach time (their evaluators produce numbers).
- Palette tunings persist to `content/state/palettes.json` via the existing `loom:state` middleware.
- Branch: `claude/loom-m6-palettes`. **`packages/runtime` changes get human review** — flag that in the PR.

**Files (whole plan):**
- Modify: `packages/runtime/src/param.ts` (+`color` type, `normalizeHex`, `labels` meta, `values()` widening)
- Create: `packages/runtime/src/palette.ts` (`PaletteRegistry`, `fillRamp`, `PaletteCtxImpl`)
- Modify: `packages/runtime/src/buildctx.ts` (+`palette` getter, `finalize()`, `palettes` ctor arg)
- Modify: `packages/runtime/src/instance.ts` (`buildInstance` calls `finalize`, buses gain `palettes`)
- Modify: `packages/runtime/src/modulator-host.ts` (reject color params)
- Modify: `packages/runtime/src/index.ts` (exports)
- Create: `packages/runtime/test/palette.test.ts`; Modify: `test/param.test.ts`, `test/modulator-host.test.ts`
- Modify: `packages/sidecar/src/protocol.ts` (string values, `labels`, `builds`)
- Modify: `packages/engine-app/src/session.ts` (`builds`, buses, applyTuned hardening)
- Modify: `packages/engine-app/src/engine-api.ts` (merged globals, palette persist, `builds` in snapshot)
- Modify: `packages/engine-app/src/main.ts` (registry, persistence, `__loom`)
- Modify: `packages/engine-app/src/ui/engine-link.ts` (`ParamDesc`, `sendParam` widening)
- Modify: `packages/engine-app/src/ui/console/ParamWidget.tsx` (color input, labels toggle)
- Create: `packages/engine-app/src/ui/PaletteSourceToggle.tsx`
- Create: `packages/engine-app/src/ui/console/Palettes.tsx`; Modify: `Rack.tsx`, `StageStrip.tsx`, `ConsoleApp.tsx`, `staged/StagedApp.tsx`
- Modify: `content/scenes/lava.scene.ts`; Create: `content/scenes/gradient.scene.ts`
- Create: `scripts/validate-m6.mjs`; Modify: `package.json`
- Modify: `DECISIONS.md`, `agent-updates.md`, `.claude/CLAUDE.md`, `.claude/skills/scene-composition/SKILL.md`

---

### Task 0: Branch

- [ ] **Step 1: Create the work branch**

```bash
cd loom
git checkout -b claude/loom-m6-palettes
```

---

### Task 1: `color` param type + `labels` meta (kernel)

**Files:**
- Modify: `packages/runtime/src/param.ts`
- Test: `packages/runtime/test/param.test.ts`

- [ ] **Step 1: Write the failing tests** — append to `packages/runtime/test/param.test.ts` inside the existing `describe`:

```ts
  it("declares a color param and normalizes hex on set", () => {
    const m = new Manifest();
    const p = m.color("tint", { default: "#FF8800" });
    expect(p.value).toBe("#ff8800"); // defaults normalize too
    p.set("#ABC"); // #rgb shorthand expands
    expect(p.value).toBe("#aabbcc");
  });

  it("color set throws on a non-hex value", () => {
    const m = new Manifest();
    const p = m.color("tint", { default: "#ffffff" });
    expect(() => p.set("red")).toThrow(/#rrggbb/);
    expect(p.value).toBe("#ffffff"); // unchanged
  });

  it("color rejects an invalid default at declare time", () => {
    const m = new Manifest();
    expect(() => m.color("bad", { default: "blue" })).toThrow();
  });

  it("setNormalized is a no-op on color params", () => {
    const m = new Manifest();
    const p = m.color("tint", { default: "#112233" });
    p.setNormalized(0.7);
    expect(p.value).toBe("#112233");
  });

  it("color serializes with type and string value", () => {
    const m = new Manifest();
    m.color("tint", { default: "#112233", description: "a tint" });
    const j = m.toJSON() as Record<string, Record<string, unknown>>;
    expect(j.tint.type).toBe("color");
    expect(j.tint.value).toBe("#112233");
    expect(m.values().tint).toBe("#112233");
  });

  it("int params carry labels meta through to JSON", () => {
    const m = new Manifest();
    m.int("source", { default: 0, min: 0, max: 2, step: 1, labels: ["primary", "secondary", "own"] });
    const j = m.toJSON() as Record<string, Record<string, unknown>>;
    expect(j.source.labels).toEqual(["primary", "secondary", "own"]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @loom/runtime exec vitest run test/param.test.ts`
Expected: FAIL — `m.color is not a function`, `labels` stripped.

- [ ] **Step 3: Implement in `packages/runtime/src/param.ts`**

```ts
export type ParamType = "float" | "int" | "bool" | "color";

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Normalize a CSS hex color to lowercase "#rrggbb"; null if unparseable. */
export function normalizeHex(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = HEX_RE.exec(v.trim());
  if (!m) return null;
  let hex = m[1]!.toLowerCase();
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  return `#${hex}`;
}
```

Add `labels` to `RangedSpec` (after `step`):

```ts
    /** Optional value names for int selectors (index = value - min); UI renders a toggle. */
    labels: z.array(z.string().min(1)).optional(),
```

Add `ColorSpec` after `BoolSpec`:

```ts
const ColorSpec = z.object({
  default: z
    .string()
    .refine((s) => normalizeHex(s) != null, { message: 'color default must be "#rrggbb"' }),
  description: z.string().optional(),
});

export type ColorParamSpec = z.infer<typeof ColorSpec>;
```

In `Param.setNormalized`, after the bool branch:

```ts
    if (this.type === "color") return; // a 0..1 CC has no honest color mapping — ignore
```

Add `Manifest.color` after `bool`:

```ts
  color(path: string, spec: z.input<typeof ColorSpec>): Param<string> {
    const s = ColorSpec.parse(spec);
    const def = normalizeHex(s.default)!;
    const clamp = (v: string) => {
      const hex = normalizeHex(v);
      if (hex == null) {
        throw new Error(`color param "${path}" expects "#rrggbb" (got ${JSON.stringify(v)})`);
      }
      return hex;
    };
    return this.add(path, new Param<string>(path, "color", clamp, specMeta({ ...s, default: def }), def));
  }
```

Widen `values()`:

```ts
  values(): Record<string, number | boolean | string> {
    const out: Record<string, number | boolean | string> = {};
    for (const [path, p] of this.params) out[path] = p.value as number | boolean | string;
    return out;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @loom/runtime exec vitest run test/param.test.ts`
Expected: PASS (all, including pre-existing).

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/param.ts packages/runtime/test/param.test.ts
git commit -m "M6 palettes: color param type + labels meta in the kernel"
```

---

### Task 2: `PaletteRegistry` + `fillRamp` (kernel, globals side)

**Files:**
- Create: `packages/runtime/src/palette.ts`
- Test: `packages/runtime/test/palette.test.ts` (new)

- [ ] **Step 1: Write the failing tests** — create `packages/runtime/test/palette.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { fillRamp, PALETTE_STOPS, PaletteRegistry } from "../src/palette";

describe("PaletteRegistry", () => {
  it("declares 5 color stops per palette on its manifest", () => {
    const reg = new PaletteRegistry();
    for (const source of ["primary", "secondary"] as const) {
      for (let i = 0; i < PALETTE_STOPS; i++) {
        const p = reg.manifest.get(`palette.${source}.${i}`);
        expect(p?.type).toBe("color");
      }
    }
    expect(reg.manifest.paths()).toHaveLength(PALETTE_STOPS * 2);
  });

  it("stops() reflects live set_param writes", () => {
    const reg = new PaletteRegistry();
    reg.manifest.get("palette.primary.2")!.set("#00ff00");
    expect(reg.stops("primary")[2]).toBe("#00ff00");
    expect(reg.stops("secondary")).toHaveLength(PALETTE_STOPS);
  });
});

describe("fillRamp", () => {
  it("interpolates piecewise-linearly across the stops", () => {
    const data = new Uint8Array(256 * 4);
    fillRamp(data, ["#000000", "#000000", "#ffffff", "#ffffff", "#ffffff"]);
    expect(data[0]).toBe(0); // left edge = stop 0
    expect(data[255 * 4]).toBe(255); // right edge = stop 4
    expect(data[3]).toBe(255); // alpha opaque
    // x=128 sits at t=2.008 of 4 → just past stop 2 → white
    expect(data[128 * 4]).toBeGreaterThan(250);
    // x=32 sits at t≈0.5 between two black stops → black
    expect(data[32 * 4]).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @loom/runtime exec vitest run test/palette.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `packages/runtime/src/palette.ts`** (registry + ramp only; the scene-side `PaletteCtxImpl` is Task 3):

```ts
import { Manifest, normalizeHex, type Param } from "./param";

/**
 * Global color palettes (R7): two named palettes, five ordered color stops
 * each, living on a globals-side Manifest (palette.primary.0 …) served
 * through the same "globals" pseudo-instance path as the input rack.
 * Roles on indices (0 bg · 1 edge · 2/3 core · 4 accent) are documented
 * convention, not kernel vocabulary (R7.1).
 */

export type PaletteSource = "primary" | "secondary";
export const PALETTE_STOPS = 5;
export const PALETTE_SOURCES = ["primary", "secondary", "own"] as const;

const DEFAULTS: Record<PaletteSource, string[]> = {
  primary: ["#0b1026", "#1a4a5f", "#2ec4b6", "#9b5de5", "#f15bb5"], // night teal→magenta
  secondary: ["#1a0b16", "#641220", "#c9184a", "#ff758f", "#ffd166"], // ember
};

export class PaletteRegistry {
  readonly manifest = new Manifest();
  private readonly stopParams: Record<PaletteSource, Param<string>[]> = {
    primary: [],
    secondary: [],
  };

  constructor() {
    for (const source of ["primary", "secondary"] as const) {
      for (let i = 0; i < PALETTE_STOPS; i++) {
        this.stopParams[source].push(
          this.manifest.color(`palette.${source}.${i}`, {
            default: DEFAULTS[source][i]!,
            description: `${source} palette stop ${i}`,
          }),
        );
      }
    }
  }

  /** Current stop values, in order. */
  stops(source: PaletteSource): string[] {
    return this.stopParams[source].map((p) => p.value);
  }
}

/** Fill an RGBA byte ramp (width = data.length/4) with a piecewise-linear gradient. */
export function fillRamp(data: Uint8Array, stops: string[]): void {
  const rgb = stops.map((s) => {
    const hex = normalizeHex(s) ?? "#000000";
    return [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
    ];
  });
  const segs = rgb.length - 1;
  const width = data.length / 4;
  for (let x = 0; x < width; x++) {
    const t = (x / (width - 1)) * segs;
    const i = Math.min(Math.floor(t), segs - 1);
    const fr = t - i;
    for (let c = 0; c < 3; c++) {
      data[x * 4 + c] = Math.round(rgb[i]![c]! + (rgb[i + 1]![c]! - rgb[i]![c]!) * fr);
    }
    data[x * 4 + 3] = 255;
  }
}
```

- [ ] **Step 4: Export from `packages/runtime/src/index.ts`** — add alongside the existing exports:

```ts
export { fillRamp, PALETTE_SOURCES, PALETTE_STOPS, PaletteRegistry, type PaletteSource } from "./palette";
```

(Also add `normalizeHex` and `type ColorParamSpec` to the existing `./param` export line.)

- [ ] **Step 5: Run tests, then commit**

Run: `pnpm --filter @loom/runtime exec vitest run test/palette.test.ts` — Expected: PASS

```bash
git add packages/runtime/src/palette.ts packages/runtime/src/index.ts packages/runtime/test/palette.test.ts
git commit -m "M6 palettes: PaletteRegistry + fillRamp (globals-side kernel)"
```

---

### Task 3: `ctx.palette` — scene-side consumption, per-frame source resolution

**Files:**
- Modify: `packages/runtime/src/palette.ts` (add `PaletteCtxImpl`)
- Modify: `packages/runtime/src/buildctx.ts`, `packages/runtime/src/instance.ts`
- Test: `packages/runtime/test/palette.test.ts`

- [ ] **Step 1: Write the failing tests** — append to `test/palette.test.ts`:

```ts
import { Manifest } from "../src/param";
import { PaletteCtxImpl } from "../src/palette";
import { F } from "./helpers";
import type { Color, DataTexture } from "three/webgpu";

type ColorUniform = { value: Color };

function makeCtx(reg = new PaletteRegistry()) {
  const manifest = new Manifest();
  const updaters: Array<(f: ReturnType<typeof F>) => void> = [];
  const pal = new PaletteCtxImpl(manifest, updaters, reg);
  return { manifest, updaters, pal, reg };
}

describe("PaletteCtxImpl", () => {
  it("declares palette.source on finalize, defaulting to primary (0) without own()", () => {
    const { manifest, pal } = makeCtx();
    pal.color(0);
    pal.finalize();
    const src = manifest.get("palette.source");
    expect(src?.type).toBe("int");
    expect(src?.value).toBe(0);
  });

  it("defaults palette.source to own (2) when the scene declared own stops", () => {
    const { manifest, pal } = makeCtx();
    pal.own(["#000000", "#111111", "#222222", "#333333", "#444444"]);
    pal.color(1);
    pal.finalize();
    expect(manifest.get("palette.source")?.value).toBe(2);
  });

  it("declares nothing when palette was never used", () => {
    const { manifest, pal } = makeCtx();
    pal.finalize();
    expect(manifest.get("palette.source")).toBeUndefined();
  });

  it("color(i) tracks the active source per frame, switching without rebuild", () => {
    const { manifest, updaters, pal, reg } = makeCtx();
    const u = pal.color(2) as unknown as ColorUniform;
    pal.finalize();
    const tick = (n: number) => updaters.forEach((up) => up(F(n)));
    tick(0);
    expect(`#${u.value.getHexString()}`).toBe(reg.stops("primary")[2]);
    manifest.get("palette.source")!.set(1); // flip to secondary — plain param write
    tick(1);
    expect(`#${u.value.getHexString()}`).toBe(reg.stops("secondary")[2]);
  });

  it("a globals stop edit retints consumers on the next pull", () => {
    const { updaters, pal, reg } = makeCtx();
    const u = pal.color(0) as unknown as ColorUniform;
    pal.finalize();
    updaters.forEach((up) => up(F(0)));
    reg.manifest.get("palette.primary.0")!.set("#ff0000");
    updaters.forEach((up) => up(F(1)));
    expect(u.value.getHexString()).toBe("ff0000");
  });

  it("own falls back to primary when no own stops were declared", () => {
    const { manifest, updaters, pal, reg } = makeCtx();
    const u = pal.color(4) as unknown as ColorUniform;
    pal.finalize();
    manifest.get("palette.source")!.set(2);
    updaters.forEach((up) => up(F(0)));
    expect(`#${u.value.getHexString()}`).toBe(reg.stops("primary")[4]);
  });

  it("ramp() re-uploads its texture only when the resolved stops change", () => {
    const { manifest, updaters, pal } = makeCtx();
    pal.ramp(0.5);
    pal.finalize();
    const tex = pal.rampTexture() as DataTexture;
    updaters.forEach((up) => up(F(0)));
    const after1 = tex.version;
    updaters.forEach((up) => up(F(1)));
    expect(tex.version).toBe(after1); // unchanged stops → no re-upload
    manifest.get("palette.source")!.set(1);
    updaters.forEach((up) => up(F(2)));
    expect(tex.version).toBeGreaterThan(after1);
  });

  it("own() validates: 5 stops, hex format, once per build", () => {
    const { pal } = makeCtx();
    expect(() => pal.own(["#000000"])).toThrow(/5/);
    const good = ["#000000", "#111111", "#222222", "#333333", "#444444"];
    pal.own(good);
    expect(() => pal.own(good)).toThrow(/once/);
  });

  it("color(i) validates the stop index", () => {
    const { pal } = makeCtx();
    expect(() => pal.color(5)).toThrow();
    expect(() => pal.color(-1)).toThrow();
  });
});
```

(`tex.version` is three's upload counter — `needsUpdate = true` increments it. `rampTexture()` is a test/engine accessor added below.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @loom/runtime exec vitest run test/palette.test.ts`
Expected: FAIL — `PaletteCtxImpl` not exported.

- [ ] **Step 3: Add `PaletteCtxImpl` to `packages/runtime/src/palette.ts`**

Add imports at the top:

```ts
import { texture, uniform, vec2 } from "three/tsl";
import { Color, DataTexture, LinearFilter, SRGBColorSpace } from "three/webgpu";
import type { Node } from "three/webgpu";
import type { FrameCtx } from "./frame";
```

Append:

```ts
/** Neutral fallback when no registry is wired and the scene has no own stops (bare unit-test builds). */
const GRAY: string[] = ["#000000", "#404040", "#808080", "#bfbfbf", "#ffffff"];

/**
 * The scene-side palette surface (ctx.palette). Collects color uniforms and
 * at most one 256×1 ramp texture during build; finalize() (called by
 * buildInstance after build()) declares the palette.source param — deferred
 * so its default can honor own() — and registers ONE per-frame updater that
 * resolves the active stops and re-tints/re-uploads only on change.
 * Switching source or retuning a globals stop never rebuilds (R7.2).
 */
export class PaletteCtxImpl {
  private readonly colorUniforms = new Map<number, ReturnType<typeof uniform>>();
  private rampTex: DataTexture | null = null;
  private rampData: Uint8Array | null = null;
  private ownStops: string[] | null = null;
  private used = false;

  constructor(
    private readonly manifest: Manifest,
    private readonly updaters: Array<(f: FrameCtx) => void>,
    private readonly registry?: PaletteRegistry,
  ) {}

  /** Stop i of the active palette as a color uniform (vec3 in TSL expressions). */
  color(i: number): ReturnType<typeof uniform> {
    if (!Number.isInteger(i) || i < 0 || i >= PALETTE_STOPS) {
      throw new Error(`ctx.palette.color(${i}): stop index must be an int in 0..${PALETTE_STOPS - 1}`);
    }
    this.used = true;
    let u = this.colorUniforms.get(i);
    if (!u) {
      u = uniform(new Color("#000000"));
      this.colorUniforms.set(i, u);
    }
    return u;
  }

  /** Gradient lookup across the 5 stops; t in 0..1 (a TSL node or constant). Returns vec4. */
  ramp(t: Node | number): ReturnType<typeof texture> {
    this.used = true;
    if (!this.rampTex) {
      this.rampData = new Uint8Array(256 * 4);
      this.rampTex = new DataTexture(this.rampData, 256, 1);
      this.rampTex.minFilter = LinearFilter;
      this.rampTex.magFilter = LinearFilter;
      this.rampTex.colorSpace = SRGBColorSpace; // stops are sRGB hex; sampling converts
      this.rampTex.needsUpdate = true;
    }
    return texture(this.rampTex, vec2(t, 0.5));
  }

  /** Scene-default stops — exactly 5 "#rrggbb" strings; the "own" source. Once per build. */
  own(stops: string[]): void {
    if (this.ownStops) throw new Error("ctx.palette.own() may only be called once per build");
    if (stops.length !== PALETTE_STOPS) {
      throw new Error(`ctx.palette.own() needs exactly ${PALETTE_STOPS} stops (got ${stops.length})`);
    }
    this.ownStops = stops.map((s) => {
      const hex = normalizeHex(s);
      if (hex == null) throw new Error(`ctx.palette.own(): bad stop ${JSON.stringify(s)} — expected "#rrggbb"`);
      return hex;
    });
    this.used = true;
  }

  /** Engine/test accessor for the ramp's backing texture (null if ramp() unused). */
  rampTexture(): DataTexture | null {
    return this.rampTex;
  }

  /** Declare palette.source + the resolver updater. Called once, after build(). */
  finalize(): void {
    if (!this.used) return;
    const source = this.manifest.int("palette.source", {
      default: this.ownStops ? 2 : 0,
      min: 0,
      max: 2,
      step: 1,
      labels: [...PALETTE_SOURCES],
      description: "active palette: primary / secondary / own (scene defaults)",
    });
    let lastKey = "";
    this.updaters.push(() => {
      const name = PALETTE_SOURCES[source.value] ?? "primary";
      const stops =
        name === "own"
          ? (this.ownStops ?? this.registry?.stops("primary") ?? GRAY)
          : (this.registry?.stops(name) ?? this.ownStops ?? GRAY);
      const key = stops.join(",");
      if (key === lastKey) return;
      lastKey = key;
      for (const [i, u] of this.colorUniforms) (u.value as Color).set(stops[i]!);
      if (this.rampTex && this.rampData) {
        fillRamp(this.rampData, stops);
        this.rampTex.needsUpdate = true;
      }
    });
  }
}
```

Export it from `index.ts` (extend the Task 2 export line with `PaletteCtxImpl`).

- [ ] **Step 4: Wire into `BuildCtx`** — in `packages/runtime/src/buildctx.ts`:

Add import: `import { PaletteCtxImpl, type PaletteRegistry } from "./palette";`

Extend the constructor and add the getter + finalize:

```ts
  private paletteCtx: PaletteCtxImpl | null = null;

  constructor(
    readonly audio: AudioBusLike,
    readonly time: TimeBus,
    readonly inputs?: InputRegistry,
    readonly palettes?: PaletteRegistry,
  ) {}

  /**
   * The global palettes (R7): color(i) stops, ramp(t) gradient, own(stops)
   * scene defaults. Using it auto-declares a palette.source param resolved
   * per frame by the uniform updaters — switching never rebuilds.
   */
  get palette(): PaletteCtxImpl {
    this.paletteCtx ??= new PaletteCtxImpl(this.manifest, this.updaters, this.palettes);
    return this.paletteCtx;
  }

  /** Declare deferred params (palette.source). buildInstance calls this after build(). */
  finalize(): void {
    this.paletteCtx?.finalize();
  }
```

- [ ] **Step 5: Wire into `buildInstance`** — in `packages/runtime/src/instance.ts`:

```ts
import type { PaletteRegistry } from "./palette";

export function buildInstance(
  scene: SceneDef,
  buses: { audio: AudioBusLike; time: TimeBus; inputs?: InputRegistry; palettes?: PaletteRegistry },
): Instance {
  const ctx = new BuildCtx(buses.audio, buses.time, buses.inputs, buses.palettes);
  const out = scene.build(ctx);
  ctx.finalize();
  if (out?.color == null) {
    throw new Error(`scene "${scene.name}": build() must return a TexNode`);
  }
  return new Instance(scene.name, ctx.manifest, ctx.updaters, out.passes, out.color);
}
```

- [ ] **Step 6: Run all runtime tests, then commit**

Run: `pnpm --filter @loom/runtime exec vitest run` — Expected: PASS

```bash
git add packages/runtime/src packages/runtime/test
git commit -m "M6 palettes: ctx.palette — per-frame source resolution, ramp texture, finalize hook"
```

---

### Task 4: Modulators reject color params

**Files:**
- Modify: `packages/runtime/src/modulator-host.ts:44-49`
- Test: `packages/runtime/test/modulator-host.test.ts`

- [ ] **Step 1: Write the failing test** — append to the host describe block in `test/modulator-host.test.ts` (mirror the file's existing host/manifest setup helpers):

```ts
  it("rejects attaching to a color param", () => {
    const m = new Manifest();
    m.color("tint", { default: "#ffffff" });
    const host = new ModulatorHost({ bpm: () => 120, audio: fakeAudio });
    expect(() => host.attach(m, "tint", { type: "sine", periodSeconds: 1 })).toThrow(/color/);
  });
```

(Use the same `fakeAudio`/bus fixture the surrounding tests already construct; import `Manifest` if the file doesn't.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @loom/runtime exec vitest run test/modulator-host.test.ts`
Expected: FAIL — attach succeeds.

- [ ] **Step 3: Implement** — in `ModulatorHost.attach`, after the `if (!param)` guard:

```ts
    if ((param as { type?: string }).type === "color") {
      throw new Error(`"${path}" is a color param — modulators drive numeric/bool params only`);
    }
```

- [ ] **Step 4: Run to verify pass, then commit**

```bash
git add packages/runtime/src/modulator-host.ts packages/runtime/test/modulator-host.test.ts
git commit -m "M6 palettes: modulators reject color params at attach"
```

---

### Task 5: Protocol widening + `builds` counter

**Files:**
- Modify: `packages/sidecar/src/protocol.ts`
- Modify: `packages/engine-app/src/session.ts`

No new unit tests (zod shape + plumbing; covered end-to-end by validate-m6). `pnpm typecheck` is the gate.

- [ ] **Step 1: Widen the protocol** — in `packages/sidecar/src/protocol.ts`:

`SetParamArgs.value` (line ~62) and the set_param result `value` (line ~213):

```ts
  value: z.union([z.number(), z.boolean(), z.string()]),
```

`ParamDescriptor` (lines ~199-202): widen `value` and `default` the same way, and add:

```ts
  labels: z.array(z.string()).optional(),
```

`InstanceInfo` (the per-instance object inside `SessionSnapshot.instances`, line ~151): add

```ts
  builds: z.number().int(),
```

- [ ] **Step 2: Add the builds counter** — in `packages/engine-app/src/session.ts`:

`Entry` interface gains:

```ts
  /** Successful builds of this entry (1 on create) — validators assert "no rebuild" against this. */
  builds: number;
```

In `create()` add `builds: 1,` to the entry literal; in `rebuild()`'s success path (next to `e.lastUpdateRejected = false;`) add `e.builds += 1;`.

Also harden `applyTuned` (a corrupt color string in `values/<scene>.json` must never break a build):

```ts
  private applyTuned(instance: Instance, scene: string): void {
    const vals = this.tunedValues?.(scene);
    if (!vals) return;
    for (const [path, v] of Object.entries(vals)) {
      try {
        instance.manifest.get(path)?.set(v);
      } catch {
        // bad persisted value (e.g. malformed color) — keep the code default
      }
    }
  }
```

Widen the `tunedValues` callback type and `SessionStore` buses in the same file:

```ts
    private readonly buses: { audio: AudioBusLike; time: TimeBus; inputs?: InputRegistry; palettes?: PaletteRegistry },
    private readonly tunedValues?: (scene: string) => Record<string, number | boolean | string> | undefined,
```

(import `type PaletteRegistry` from `@loom/runtime`).

- [ ] **Step 3: Surface `builds`** — in `packages/engine-app/src/engine-api.ts` `snapshot()`, add `builds: e.builds,` to the `instances` mapper; in `packages/engine-app/src/main.ts`, add `builds: e.id ? e.builds : e.builds,` — concretely: add `builds: e.builds,` to the `dbg.instances` mapper and `builds: number;` to the `__loom` instances type in the `declare global` block.

- [ ] **Step 4: Typecheck, then commit**

Run: `pnpm typecheck` — Expected: clean (engine-api set_param casts still compile because the union widened; if a `as number | boolean` cast errors, widen it to `as number | boolean | string` — Task 6 touches those lines anyway).

```bash
git add packages/sidecar/src/protocol.ts packages/engine-app/src/session.ts packages/engine-app/src/engine-api.ts packages/engine-app/src/main.ts
git commit -m "M6 palettes: protocol takes string param values + labels; builds counter per entry"
```

---

### Task 6: Engine wiring — merged globals, persistence

**Files:**
- Modify: `packages/engine-app/src/engine-api.ts`
- Modify: `packages/engine-app/src/main.ts`

- [ ] **Step 1: engine-api merged globals** — in `engine-api.ts`:

`EngineDeps` gains (next to `inputs`):

```ts
  /** Global color palettes (R7): second globals-side manifest, path prefix "palette.". */
  palettes: PaletteRegistry;
```

and `persist` gains `palettes(): void;`. Import `type PaletteRegistry` from `@loom/runtime`.

Add two private helpers next to `requireParam`:

```ts
  /** "globals" = the input rack + the palettes, merged; routed by path prefix. */
  private globalsManifest(path: string): Manifest {
    return path.startsWith("palette.") ? this.deps.palettes.manifest : this.deps.inputs.manifest;
  }

  private globalsJson(): Record<string, unknown> {
    return { ...this.deps.inputs.manifest.toJSON(), ...this.deps.palettes.manifest.toJSON() };
  }
```

`get_manifest` globals branch becomes:

```ts
        if (instance === GLOBALS) {
          return { instance: GLOBALS, params: this.globalsJson() };
        }
```

`set_param` globals branch becomes:

```ts
        if (instance === GLOBALS) {
          const isPalette = path.startsWith("palette.");
          const param = this.requireParam(this.globalsManifest(path), path, GLOBALS);
          param.set(value);
          if (isPalette) this.deps.persist.palettes();
          else this.deps.persist.globals();
          return { instance: GLOBALS, path, value: param.value as number | boolean | string };
        }
```

(Widen the non-globals set_param return cast to `number | boolean | string` too.)

`resolveMidiTarget` globals branch: `this.requireParam(this.globalsManifest(path), path, GLOBALS);` (a CC bound to a color stop is a harmless no-op via `setNormalized`; binding `palette.source` to a knob is the point).

`consoleState()`: `manifests[GLOBALS] = this.globalsJson();`

- [ ] **Step 2: main.ts wiring** — in `main.ts`:

After `const inputs = new InputRegistry(...)` block:

```ts
// Global color palettes (R7): a second globals-side manifest, served through
// the same "globals" pseudo-instance and persisted like the rack tunings.
const palettes = new PaletteRegistry();
```

(import `PaletteRegistry` from `@loom/runtime`).

`persist` gains:

```ts
  palettes: () => state.save("palettes", () => palettes.manifest.values()),
```

`tunedValues` map type widens: `new Map<string, Record<string, number | boolean | string>>()` (and the matching cast in the state-restore loop).

`SessionStore` construction gains the registry:

```ts
const session = new SessionStore({ audio, time: timeBus, inputs, palettes }, (scene) =>
  tunedValues.get(scene),
);
```

MIDI CC globals routing (inside `midi.onCc`): replace `inputs.manifest.get(path)?.setNormalized(v01);` + `persist.globals();` with:

```ts
      const isPalette = path.startsWith("palette.");
      (isPalette ? palettes.manifest : inputs.manifest).get(path)?.setNormalized(v01);
      if (isPalette) persist.palettes();
      else persist.globals();
```

State restore (inside `if (state.enabled)`), after the inputs block — note the try/catch (a malformed color throws):

```ts
  const savedPalettes = await state.load("palettes");
  if (savedPalettes && typeof savedPalettes === "object") {
    for (const [path, v] of Object.entries(savedPalettes as Record<string, unknown>)) {
      try {
        palettes.manifest.get(path)?.set(v as never);
      } catch {
        // corrupt entry — keep the default
      }
    }
  }
```

Harden the existing inputs restore loop with the same try/catch shape while there.

`EngineApi` deps: add `palettes,` next to `inputs,`.

`window.__loom`: add `palettes: Record<string, number | boolean | string>;` to the declared type, `palettes: {},` to the init literal, and `dbg.palettes = palettes.manifest.values();` in the render loop next to `dbg.inputs`.

- [ ] **Step 3: Typecheck + smoke, then commit**

Run: `pnpm typecheck` — Expected: clean.
Run: `pnpm dev` briefly; in the browser console on `/?audio=test&state=off`: `window.__loom.palettes["palette.primary.0"]` → `"#0b1026"`.

```bash
git add packages/engine-app/src
git commit -m "M6 palettes: globals serves rack+palettes merged; palettes.json persistence"
```

---

### Task 7: Console UI — color input, labels toggle, palette rows, source selector

**Files:**
- Modify: `packages/engine-app/src/ui/engine-link.ts`
- Modify: `packages/engine-app/src/ui/console/ParamWidget.tsx`
- Create: `packages/engine-app/src/ui/PaletteSourceToggle.tsx`
- Create: `packages/engine-app/src/ui/console/Palettes.tsx`
- Modify: `packages/engine-app/src/ui/console/Rack.tsx`, `StageStrip.tsx`, `ConsoleApp.tsx`, `packages/engine-app/src/ui/staged/StagedApp.tsx`

- [ ] **Step 1: Widen `engine-link.ts`**

`ParamDesc`:

```ts
export type ParamDesc = {
  type: "float" | "int" | "bool" | "color";
  value: number | boolean | string;
  default: number | boolean | string;
  min?: number;
  max?: number;
  step?: number;
  /** Value names for int selectors (palette.source) — UI renders a toggle. */
  labels?: string[];
  description?: string;
  /** Active modulator config, or null when the param is hand-driven (FR-8). */
  modulator?: Record<string, unknown> | null;
};
```

`sendParam` value type and the `queued` map value type: `number | boolean | string`.

- [ ] **Step 2: `ParamWidget.tsx` — color + labels branches**

`valueText` becomes:

```ts
  const valueText =
    p.type === "bool" || p.type === "color"
      ? String(p.value)
      : (drag ?? Number(p.value)).toFixed(p.type === "int" ? 0 : 3);
```

Hide ∿ and M for colors — change the two button conditions to:

```tsx
        {instance !== "globals" && p.type !== "color" && ( /* ∿ IconButton unchanged */ )}
        {p.type !== "color" && ( /* learn Button unchanged */ )}
```

(Colors can't be modulated — Task 4 — and `setNormalized` ignores them, so a learn button would lie.)

Control branch — replace the bool/slider ternary with a four-way:

```tsx
      {p.type === "bool" ? (
        <Switch
          size="small"
          checked={p.value === true}
          disabled={modulated}
          inputProps={inputAttrs}
          onChange={(e) => link.sendParam(instance, path, e.target.checked)}
        />
      ) : p.type === "color" ? (
        <Box
          component="input"
          type="color"
          value={String(p.value)}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            link.sendParam(instance, path, e.target.value)
          }
          {...inputAttrs}
          sx={{
            width: dense ? 44 : 64,
            height: 26,
            p: 0,
            border: 1,
            borderColor: "divider",
            borderRadius: 1,
            bgcolor: "transparent",
            cursor: "pointer",
          }}
        />
      ) : p.labels != null ? (
        <ToggleButtonGroup
          exclusive
          size="small"
          data-path={path}
          value={Number(drag ?? p.value)}
          onChange={(_, v) => {
            if (typeof v === "number") link.sendParam(instance, path, v);
          }}
        >
          {p.labels.map((l, i) => (
            <ToggleButton key={l} value={i + (p.min ?? 0)} sx={{ py: 0, px: 1, fontSize: 11 }}>
              {l}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      ) : (
        <Slider /* unchanged */ />
      )}
```

Add `ToggleButton, ToggleButtonGroup` to the MUI import. DOM contract for validators: color params put `data-path` on a real `<input type="color">`; labels selectors put it on the group container with `<button>` children whose text is the label.

- [ ] **Step 3: Create `packages/engine-app/src/ui/PaletteSourceToggle.tsx`** (shared by StageStrip and StagedApp — R7.2's "choosable from the stage strip"):

```tsx
import { ToggleButton, ToggleButtonGroup } from "@mui/material";
import type { ParamDesc } from "./engine-link";
import { useEngine } from "./hooks";

/**
 * primary/secondary/own switch for the staged instance's palette.source
 * (R7.2). Rendered only when the staged manifest declares the param.
 * DOM contract: #palettesource with one <button> per label.
 */
export function PaletteSourceToggle({ instance, p }: { instance: string; p: ParamDesc }) {
  const link = useEngine();
  const labels = p.labels ?? ["primary", "secondary", "own"];
  return (
    <ToggleButtonGroup
      id="palettesource"
      exclusive
      size="small"
      value={Number(p.value)}
      onChange={(_, v) => {
        if (typeof v === "number") link.sendParam(instance, "palette.source", v);
      }}
    >
      {labels.map((l, i) => (
        <ToggleButton key={l} value={i} sx={{ py: 0, px: 1, fontSize: 11 }}>
          {l}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}
```

- [ ] **Step 4: Create `packages/engine-app/src/ui/console/Palettes.tsx`** and mount it in the Rack drawer (palettes are globals — the rack drawer is the globals surface):

```tsx
import { Box, Stack, Typography } from "@mui/material";
import type { ParamDesc } from "../engine-link";
import { ParamWidget } from "./ParamWidget";

/**
 * The two global palettes as rows of five color swatches (R7), editing
 * "globals" through the same ParamWidget path as the rack tunings.
 * DOM contract: #palettes, .paletterow[data-name].
 */
export function Palettes({ globals }: { globals: Record<string, ParamDesc> }) {
  return (
    <Box id="palettes" sx={{ pt: 1.5 }}>
      <Typography variant="caption" color="text.secondary" sx={{ letterSpacing: "0.08em" }}>
        GLOBAL PALETTES
      </Typography>
      {(["primary", "secondary"] as const).map((source) => (
        <Stack
          key={source}
          direction="row"
          className="paletterow"
          data-name={source}
          spacing={1.75}
          alignItems="center"
          sx={{ py: 0.75 }}
        >
          <Typography sx={{ width: 80, flex: "0 0 auto", fontWeight: 700 }}>{source}</Typography>
          <Box sx={{ display: "flex", gap: 1.75 }}>
            {[0, 1, 2, 3, 4].map((i) => {
              const path = `palette.${source}.${i}`;
              const p = globals[path];
              return p ? (
                <ParamWidget key={path} instance="globals" path={path} p={p} label={String(i)} dense />
              ) : null;
            })}
          </Box>
        </Stack>
      ))}
    </Box>
  );
}
```

In `Rack.tsx`, import it and render after the rack rows (inside the `#rack` Box, after the `names.map(...)`):

```tsx
      <Palettes globals={globals} />
```

- [ ] **Step 5: Source selector in the stage strip and /staged**

`ConsoleApp.tsx`: pass manifests down — `<StageStrip session={session} manifests={manifests} onCreated={setSelected} />`.

`StageStrip.tsx`: props become

```ts
import type { Manifests } from "../engine-link";
import { PaletteSourceToggle } from "../PaletteSourceToggle";

type Props = { session: SessionSnapshot; manifests: Manifests; onCreated: (id: string) => void };
export function StageStrip({ session: s, manifests, onCreated }: Props) {
```

and right after the `#stagedname` Typography / before the unstage button:

```tsx
      {s.staged != null && manifests[s.staged]?.["palette.source"] != null && (
        <PaletteSourceToggle instance={s.staged} p={manifests[s.staged]!["palette.source"]!} />
      )}
```

`StagedApp.tsx`: it already has `useEngineState()` — destructure `manifests` too, and add the same conditional block in the header `Stack`, after `#fadeinfo`:

```tsx
      {staged != null && manifests[staged]?.["palette.source"] != null && (
        <PaletteSourceToggle instance={staged} p={manifests[staged]!["palette.source"]!} />
      )}
```

- [ ] **Step 6: Verify by eye, then commit**

Run: `pnpm typecheck && pnpm test`, then `pnpm dev`; open `/console.html`, press `i` → palettes rows render with 10 swatches; pick a color → output retints (after Task 8 converts a scene, the boot scene won't consume palettes yet — verify the globals manifest value changes via the value text).

```bash
git add packages/engine-app/src/ui
git commit -m "M6 palettes: Console color swatches, labels toggle, staged source selector"
```

---

### Task 8: Content — convert `lava` to `ctx.palette`, add `gradient` ramp scene

**Files:**
- Modify: `content/scenes/lava.scene.ts`
- Create: `content/scenes/gradient.scene.ts`

(Leave `pulse` alone — validators pin it as the live scene.)

- [ ] **Step 1: Convert `lava.scene.ts`** — replace the hardcoded `vec3` colors (lines 54-58) with palette stops. At the top of `build`, after the param declarations:

```ts
    // Palette stops (documented roles: 0 bg · 1 edge · 2/3 core blend · 4 accent flash).
    // own() reproduces the original ink/ember look; flip palette.source to retint live.
    const pal = ctx.palette;
    pal.own(["#161238", "#76102c", "#f37627", "#da3089", "#ffc15e"]);
```

Replace the color math:

```ts
    const body = smoothstep(0.1, 0.9, field.color.x);
    const glow = field.color.y;
    const inkDark = pal.color(0);
    const lavaEdge = pal.color(1);
    const lavaCore = mix(pal.color(2), pal.color(3), hueU);
    const lava = mix(lavaEdge, lavaCore, glow);
    const rgb = mix(inkDark, lava, body).add(pal.color(4).mul(glow).mul(kickU.mul(0.9)));
```

(`vec3` may drop from the `three/tsl` import if now unused. The own stops are the sRGB equivalents of the previous linear `vec3` constants; the kick flash uses the new accent stop.)

- [ ] **Step 2: Create `content/scenes/gradient.scene.ts`** — the minimal `ramp()` consumer (also the validator's ramp target):

```ts
import { defineScene, Signal, texNode } from "@loom/runtime";
import { fract, uv } from "three/tsl";

/**
 * Full-screen horizontal gradient across the active palette's five stops,
 * slowly scrolling. The simplest ctx.palette.ramp consumer — retint it from
 * the Console palettes drawer or flip palette.source live.
 */
export default defineScene({
  name: "gradient",
  description: "Scrolling horizontal gradient across the active palette's five stops.",
  tags: ["palette", "gradient", "minimal"],
  build(ctx) {
    const speed = ctx.float("speed", {
      default: 0.02,
      min: 0,
      max: 0.5,
      description: "scroll speed (ramps per second)",
    });
    const speedS = speed.signal();
    let phase = 0;
    // Stateful: uniformOf registration guarantees the per-frame pull.
    const phaseU = ctx.uniformOf(new Signal((f) => (phase = (phase + f.dt * speedS.get(f)) % 1)));
    return texNode(ctx.palette.ramp(fract(uv().x.add(phaseU))));
  },
});
```

- [ ] **Step 3: Verify live**

Run: `pnpm typecheck` (regenerates `content/CATALOG.md` — commit it too). Then `pnpm dev`, open `/console.html`, spawn a `gradient` instance from the scene picker: tile shows the primary gradient; edit `palette.primary.2` in the rack drawer → tile retints; select the tile and flip `palette.source` in the param panel → instant change. Spawn `lava` → looks like before; flip its source to `primary` → night-teal lava.

- [ ] **Step 4: Commit**

```bash
git add content/scenes/lava.scene.ts content/scenes/gradient.scene.ts content/CATALOG.md
git commit -m "M6 palettes: lava consumes ctx.palette stops; gradient scene exercises ramp()"
```

---

### Task 9: `validate:m6` (palette half) + script wiring

**Files:**
- Create: `scripts/validate-m6.mjs`
- Modify: `package.json` (root scripts)

The chains half of M6 will append its checks to this same script later.

- [ ] **Step 1: Add the script entry** — in `loom/package.json` scripts, after `validate:m5`:

```json
    "validate:m6": "node scripts/validate-m6.mjs",
```

- [ ] **Step 2: Write `scripts/validate-m6.mjs`**

Copy the harness from `scripts/validate-m5.mjs` verbatim: the header constants (use `PORT = 5203`, `WS_PORT = 7346`), `sleep`/`check`/`waitForServer`/`toolJson`/`callOk`/`waitFor`/`waitForFps` helpers, the state-dir snapshot/restore wrapping (state stays ON — palette persistence is under test), the live-scene pin to `pulse` (the `SCENE` write/restore), the Vite + sidecar spawn with fail-fast on early exit, and the Playwright launch of the output page + `/console.html`. Add a pngjs pixel helper (pattern exists in validate-m1/m4):

```js
import { PNG } from "pngjs";

/** Decode a screenshot tool result and average its RGB. */
function avgColor(shot) {
  const png = PNG.sync.read(Buffer.from(shot.base64, "base64"));
  let r = 0, g = 0, b = 0;
  const n = png.width * png.height;
  for (let i = 0; i < n; i++) {
    r += png.data[i * 4]; g += png.data[i * 4 + 1]; b += png.data[i * 4 + 2];
  }
  return { r: r / n, g: g / n, b: b / n };
}
const dist = (a, b) => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
```

Then the checks, in order (each `check(...)` line is one of the acceptance results; screenshot artifacts go to `artifacts/m6-*.png`):

```js
// 1. Globals manifest carries both palettes as color params.
const globals = toolJson(await callOk(client, "get_manifest", { instance: "globals" }));
const stopPaths = ["primary", "secondary"].flatMap((s) => [0, 1, 2, 3, 4].map((i) => `palette.${s}.${i}`));
check(
  "globals manifest lists 10 color stops",
  stopPaths.every((p) => globals.params[p]?.type === "color"),
);

// 2. A ramp consumer + a stops consumer, built in sandboxes.
const grad = toolJson(await callOk(client, "create_instance", { scene: "gradient" }));
const lava = toolJson(await callOk(client, "create_instance", { scene: "lava" }));
check("gradient auto-declares palette.source", grad.paramPaths.includes("palette.source"));
const gradBefore = avgColor(toolJson(await callOk(client, "screenshot", { instance: grad.instance })));

// 3. Globals palette edit retints the consumer (R7 / shipped-when: "within a frame" —
//    asserted as: the FIRST screenshot after the set_param ack already differs).
for (const i of [0, 1, 2, 3, 4]) {
  await callOk(client, "set_param", { instance: "globals", path: `palette.primary.${i}`, value: "#ff0000" });
}
const gradRed = avgColor(toolJson(await callOk(client, "screenshot", { instance: grad.instance })));
check("globals palette edit retints the ramp consumer", dist(gradBefore, gradRed) > 25, `Δ=${dist(gradBefore, gradRed).toFixed(1)}`);
check("retinted ramp is red-dominant", gradRed.r > gradRed.g + 40 && gradRed.r > gradRed.b + 40);

// 4. No rebuild: builds counter untouched by retint + source flips.
const buildsOf = async (id) =>
  toolJson(await callOk(client, "get_session", {})).instances.find((x) => x.id === id)?.builds;
check("retint caused no rebuild", (await buildsOf(grad.instance)) === 1);
await callOk(client, "set_param", { instance: grad.instance, path: "palette.source", value: 1 });
const gradSecondary = avgColor(toolJson(await callOk(client, "screenshot", { instance: grad.instance })));
check("flipping palette.source changes pixels", dist(gradRed, gradSecondary) > 25);
check("source flip caused no rebuild", (await buildsOf(grad.instance)) === 1);

// 5. own(): lava defaults to its authored stops and can flip away and back.
const lavaManifest = toolJson(await callOk(client, "get_manifest", { instance: lava.instance }));
check("own() scene defaults palette.source to own", lavaManifest.params["palette.source"]?.value === 2);

// 6. Format-validating clamp: garbage is rejected, value untouched.
const bad = await client.callTool({
  name: "set_param",
  arguments: { instance: "globals", path: "palette.primary.0", value: "#nope" },
});
check("invalid color value is rejected", bad.isError === true);

// 7. Modulators refuse color params.
const badMod = await client.callTool({
  name: "modulate_param",
  arguments: { instance: "globals" === "x" ? "" : grad.instance, path: "palette.source", modulator: { type: "cycle", periodBeats: 4, values: [0, 1] } },
});
check("cycle modulator CAN ride palette.source (int)", badMod.isError !== true);
await callOk(client, "clear_modulation", { instance: grad.instance, path: "palette.source" });

// 8. Console: rack drawer shows color inputs; editing one writes through.
await consolePage.keyboard.press("i");
await consolePage.waitForSelector('#palettes input[type="color"][data-path="palette.primary.0"]');
await consolePage.evaluate(() => {
  const el = document.querySelector('input[data-path="palette.primary.0"]');
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  set.call(el, "#00ff00");
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
});
await waitFor(async () => {
  const g = toolJson(await callOk(client, "get_manifest", { instance: "globals" }));
  return g.params["palette.primary.0"].value === "#00ff00" ? true : null;
}, 5_000, "swatch edit to land");
check("Console swatch edits write through to globals", true);
await consolePage.screenshot({ path: join(ARTIFACTS, "m6-1-palettes-drawer.png") });

// 9. Stage strip source selector (R7.2).
await callOk(client, "stage", { instance: grad.instance });
await consolePage.waitForSelector("#palettesource");
await consolePage.click('#palettesource button:has-text("own")');
await waitFor(async () => {
  const m = toolJson(await callOk(client, "get_manifest", { instance: grad.instance }));
  return m.params["palette.source"].value === 2 ? true : null;
}, 5_000, "selector click to land");
check("stage-strip selector flips palette.source", true);
await callOk(client, "unstage", {});

// 10. Persistence: palettes.json round-trips a reload (state is ON in this run).
await output.reload();
await waitForFps(output);
const reloaded = toolJson(await callOk(client, "get_manifest", { instance: "globals" }));
check("palette tunings survive a reload", reloaded.params["palette.primary.0"].value === "#00ff00");
```

Adjust helper names/page handles to match the m5 harness exactly (`output`, `consolePage`, `client`). Finish with the m5-style results summary + non-zero exit on failure, artifact screenshots of the gradient before/after (`m6-2-grad-primary.png`, `m6-3-grad-red.png`), and the state-dir restore in a `finally`.

- [ ] **Step 3: Run it**

Run: `pnpm validate:m6`
Expected: all checks PASS, artifacts written under `loom/artifacts/`.

- [ ] **Step 4: Re-run every prior gate**

```bash
pnpm typecheck && pnpm test
pnpm validate:m0 && pnpm validate:m1 && pnpm validate:m2 && pnpm validate:m3 && pnpm validate:m4 && pnpm validate:m5 && pnpm validate:modulators
```

Expected: all green. Known risk spots: m2 asserts pulse's manifest as a subset (untouched — pulse wasn't converted); m5 round-trips `content/state/` (new `palettes.json` must not confuse its snapshot/restore — it snapshots the whole dir, so it won't).

- [ ] **Step 5: Commit**

```bash
git add scripts/validate-m6.mjs package.json artifacts
git commit -m "M6 palettes: validate:m6 palette checks (retint, no-rebuild source flip, Console, persistence)"
```

---

### Task 10: Docs + logs

**Files:**
- Modify: `DECISIONS.md`, `agent-updates.md`, `.claude/CLAUDE.md`, `.claude/skills/scene-composition/SKILL.md`

- [ ] **Step 1: `DECISIONS.md`** — append entries (newest at bottom) covering: color clamp **throws** on bad input (set_param surfaces it; both state-restore paths and `applyTuned` got per-param try/catch so corrupt JSON can't break boot); `setNormalized` is a no-op on colors; `labels` meta on ranged specs (generic int-selector affordance, first user `palette.source`); `palette.source` as int 0..2 declared in `BuildCtx.finalize()` so its default honors `own()`; "own" falls back to primary when undeclared; `builds` counter on session entries (M6 needs "no rebuild" assertions twice; chains will reuse it); palettes persist to `content/state/palettes.json`; `gradient` scene added as the minimal ramp consumer.

- [ ] **Step 2: `.claude/CLAUDE.md`** (the in-engine agent guide) — in "Your eyes and hands", extend the `"globals"` bullet: the globals manifest now also carries `palette.primary.0`…`palette.secondary.4` (color params, `"#rrggbb"`). Add a short rule under the architecture key-kernel-facts: scenes consume palettes via `ctx.palette.color(i)` / `ctx.palette.ramp(t)`; `ctx.palette.own([...5 stops])` sets scene defaults; using any of them auto-declares `palette.source` (0 primary · 1 secondary · 2 own — flip with plain `set_param`, never a rebuild). Stop roles 0 bg · 1 edge · 2/3 core · 4 accent are convention.

- [ ] **Step 3: `.claude/skills/scene-composition/SKILL.md`** — add a "Palettes" section with the same contract plus the golden snippet from `gradient.scene.ts` and the lava `own()` example.

- [ ] **Step 4: `agent-updates.md`** — append a dated entry (2026-06-11) once all gates are green: what shipped (kernel color type, PaletteRegistry, ctx.palette, merged globals, Console swatches + source selector, lava/gradient, validate:m6 palette half N/N), gates re-run results, and any deviation/stumble worth knowing.

- [ ] **Step 5: Final gate + commit**

```bash
pnpm typecheck && pnpm test && pnpm validate:m6
git add DECISIONS.md agent-updates.md .claude
git commit -m "Docs: M6 palette decisions, agent guide + scene-composition skill, progress log"
```

---

## Self-Review Notes

- **Spec coverage:** R7 (two global 5-stop palettes, Console + agent adjustable) → Tasks 2, 6, 7; R7.1 (index/ramp consumption, roles as convention) → Tasks 3, 8; R7.2 (live `palette.source`, instant, stage-strip selectable) → Tasks 3, 7, 9. M6 plan bullets: color param type → Task 1; PaletteContext (`color`/`ramp`/`own`, vec3 uniforms, 256×1 DataTexture re-uploaded on change, auto `palette.source`, per-frame resolution) → Task 3; stage strip + /staged selector → Task 7; "convert one scene" → Task 8; shipped-when palette assertions → Task 9. NOT in scope (the chains half): `set_chain`, `chainParams`, `ModuleOutput` formalization, effect retrofits.
- **Type consistency:** `Manifest.color` returns `Param<string>`; `values()`/protocol/`ParamDesc`/`sendParam` all widened to `number | boolean | string`; `PaletteCtxImpl(manifest, updaters, registry?)` matches both the BuildCtx getter and the tests; `builds` appears in Entry, snapshot mapper, protocol `InstanceInfo`, and `__loom`.
- **Never-go-black:** no render-path changes; the only new per-frame work is one updater per palette-consuming instance with a string-key early-out. Bad color writes throw at the API boundary, never inside the render loop; corrupt persisted state is contained by try/catch in all three restore paths.
