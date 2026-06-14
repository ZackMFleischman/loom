# mandelbloom Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a palette-showcase scene `mandelbloom` — a Mandelbrot set whose exterior filaments flow through the global palette *ramp* and whose black interior hosts a kick-blooming "garden" tinted with discrete palette *stops* — plus a new reusable `paletteMap` effect module, with the dive animation folded into the existing `mandelbrot` source module.

**Architecture:** Pure `content/` work (modules + scenes), no `packages/` changes. The `mandelbrot` module gains optional `glide`/`dive`/`depth`/`baseScale` opts so it can self-animate (back-compatible — absent ⇒ today's static behavior). `paletteMap` recolors luminance through `ctx.palette.ramp`. `mandelbloom` masks interior vs. exterior off the fractal's brightness (`b == 0` inside the set), colors each region from the same global palette, separates them with a bright accent rim, and runs feedback → glitch → levels. The existing `mandelbrot` scene is refactored onto the diving module to remove the duplicated dive math.

**Tech Stack:** TypeScript, three/TSL, `@loom/runtime` (Signal/BuildCtx/defineModule/defineScene/ctx.palette), LOOM MCP tools for eyes-on acceptance.

**Verification model:** This is visual content. The project's contract gate is `pnpm typecheck` (also regenerates `content/CATALOG.md` from module metadata); there is no unit-test harness under `content/`. Each task therefore verifies with `pnpm typecheck` + an eyes-on check via the LOOM MCP tools (`create_instance` → `screenshot` → `set_param` → `get_session`). **Prerequisite for eyes-on steps:** the engine is running (`pnpm dev`) and reachable; use `?audio=test` for synthetic kick. Build candidates in **sandboxes** (`create_instance`) — never hot-swap `live.scene.ts`.

**Spec:** `docs/superpowers/specs/2026-06-11-mandelbloom-design.md`

---

## File Structure

- **Modify** `content/modules/sources/mandelbrot.ts` — add optional `glide` (lag the center) + `dive`/`depth`/`baseScale` (internal ping-pong zoom integrator). Default path unchanged.
- **Create** `content/modules/effects/paletteMap.ts` — luminance → `ctx.palette.ramp(t)` effect.
- **Create** `content/scenes/mandelbloom.scene.ts` — the showcase scene composing both modules + noise/blobs/feedback/glitch/levels.
- **Modify** `content/scenes/mandelbrot.scene.ts` — consume the diving `mandelbrot`; identical param surface.
- **Regenerate** `content/CATALOG.md` — via `pnpm typecheck` (commit the diff).
- **Modify** `DECISIONS.md`, `agent-updates.md` — log the module abstraction + new scene.

---

### Task 1: Fold the dive into the `mandelbrot` module (back-compatible)

**Files:**
- Modify: `content/modules/sources/mandelbrot.ts`

- [ ] **Step 1: Widen the imports**

Replace the first import line:

```ts
import { BuildCtx, defineModule, texNode, type SignalLike, type TexNode } from "@loom/runtime";
```

with:

```ts
import {
  asSignal,
  BuildCtx,
  defineModule,
  lagSignal,
  Signal,
  texNode,
  type SignalLike,
  type TexNode,
} from "@loom/runtime";
```

- [ ] **Step 2: Extend `MandelbrotOpts`**

Replace the whole `MandelbrotOpts` interface (currently lines ~11-20) with:

```ts
export interface MandelbrotOpts {
  /** View center, real axis. */
  cx?: SignalLike;
  /** View center, imaginary axis. */
  cy?: SignalLike;
  /** Half the vertical extent of the view in set coordinates (smaller = deeper). Ignored when `dive` is set. */
  scale?: SignalLike;
  /** Escape-time iteration cap (10..500) — raise it as you zoom deeper. */
  iterations?: SignalLike;
  /** Lag seconds applied to cx/cy so retargeting glides instead of jump-cutting (default 0 = snap). */
  glide?: SignalLike;
  /** Zoom speed in octaves/sec; when set, drives an internal ping-pong zoom and overrides `scale`. */
  dive?: SignalLike;
  /** Max zoom depth in octaves for the ping-pong (default 14; f32 GPU limit ~18). */
  depth?: SignalLike;
  /** Half-extent at the top of the dive (default 1.25). */
  baseScale?: SignalLike;
}
```

- [ ] **Step 3: Compute glided center + dive scale in the factory**

Replace the first four uniform lines in the factory (currently):

```ts
    const cx = ctx.uniformOf(opts.cx ?? -0.6);
    const cy = ctx.uniformOf(opts.cy ?? 0);
    const scale = ctx.uniformOf(opts.scale ?? 1.25);
    const iterations = ctx.uniformOf(opts.iterations ?? 200);
```

with:

```ts
    // Optional center glide: lag cx/cy toward their targets (glide = seconds).
    const cxIn: SignalLike = opts.glide !== undefined ? lagSignal(opts.cx ?? -0.6, opts.glide) : (opts.cx ?? -0.6);
    const cyIn: SignalLike = opts.glide !== undefined ? lagSignal(opts.cy ?? 0, opts.glide) : (opts.cy ?? 0);
    const cx = ctx.uniformOf(cxIn);
    const cy = ctx.uniformOf(cyIn);

    // Optional self-dive: integrate a ping-pong zoom into the view scale.
    // Identical math to the old mandelbrot.scene.ts integrator.
    let scaleLike: SignalLike;
    if (opts.dive !== undefined) {
      const diveS = asSignal(opts.dive);
      const depthS = asSignal(opts.depth ?? 14);
      const baseS = asSignal(opts.baseScale ?? 1.25);
      let zoomAcc = 0;
      scaleLike = new Signal((f) => {
        zoomAcc += diveS.get(f) * f.dt;
        const d = Math.max(0.001, depthS.get(f));
        const m = ((zoomAcc % (2 * d)) + 2 * d) % (2 * d);
        const octaves = m < d ? m : 2 * d - m;
        return baseS.get(f) * Math.pow(2, -octaves);
      });
    } else {
      scaleLike = opts.scale ?? 1.25;
    }
    const scale = ctx.uniformOf(scaleLike);
    const iterations = ctx.uniformOf(opts.iterations ?? 200);
```

Leave the `shade()` body and `return texNode(shade())` unchanged.

- [ ] **Step 4: Typecheck (regenerates the catalog)**

Run: `pnpm typecheck`
Expected: clean (no type errors). `content/CATALOG.md` regenerates; the mandelbrot entry text is unchanged (metadata untouched).

- [ ] **Step 5: Eyes-on — the existing mandelbrot scene still works**

With the engine running, in the MCP client:
- `create_instance { scene: "mandelbrot" }`
- `screenshot { instance: <returned id> }`

Expected: a colored Mandelbrot dive, visually equivalent to before (the scene still passes static `scale` until Task 4 — so this confirms the default/back-compat path is intact). `get_session` → the instance's `instanceError` is null.
- `destroy_instance { instance: <id> }`

- [ ] **Step 6: Commit**

```bash
git add content/modules/sources/mandelbrot.ts content/CATALOG.md
git commit -m "mandelbrot module: optional glide + self-dive (back-compatible)"
```

---

### Task 2: `paletteMap` effect module

**Files:**
- Create: `content/modules/effects/paletteMap.ts`

- [ ] **Step 1: Write the module**

Create `content/modules/effects/paletteMap.ts`:

```ts
import { BuildCtx, defineModule, texNode, type SignalLike, type TexNode } from "@loom/runtime";
import { dot, fract, vec3 } from "three/tsl";

export interface PaletteMapOpts {
  /** Any source/effect output to recolor. */
  input: TexNode;
  /** Scroll offset added to the ramp lookup coordinate (wraps 0..1). */
  shift?: SignalLike;
  /** Luminance multiplier before the ramp lookup (banding/contrast). */
  gain?: SignalLike;
}

/**
 * Recolors an input's luminance through the active GLOBAL palette ramp (R7) —
 * the palette-native sibling of colorize (which only knows the cosine PALETTES
 * presets). Because it calls ctx.palette.ramp, any scene using it auto-declares
 * palette.source and is live-retintable (flip primary/secondary/own, no rebuild).
 */
export const paletteMap = defineModule(
  {
    name: "paletteMap",
    kind: "effect",
    description: "Recolors an input's luminance through the active global palette ramp.",
    tags: ["color", "palette", "ramp", "grade"],
    example: 'paletteMap(ctx, { input: src, shift: scrollSig })',
  },
  (ctx: BuildCtx, opts: PaletteMapOpts): TexNode => {
    const shift = ctx.uniformOf(opts.shift ?? 0);
    const gain = ctx.uniformOf(opts.gain ?? 1);
    const lum = dot(opts.input.color.rgb, vec3(0.299, 0.587, 0.114));
    const t = fract(lum.mul(gain).add(shift));
    return texNode(ctx.palette.ramp(t), opts.input.passes);
  },
);
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: clean. `content/CATALOG.md` gains a `paletteMap` line under `### effect`.

- [ ] **Step 3: Commit**

```bash
git add content/modules/effects/paletteMap.ts content/CATALOG.md
git commit -m "paletteMap effect: luminance through the global palette ramp"
```

(Eyes-on for paletteMap happens in Task 3, where the scene consumes it.)

---

### Task 3: `mandelbloom` scene

**Files:**
- Create: `content/scenes/mandelbloom.scene.ts`

- [ ] **Step 1: Write the scene**

Create `content/scenes/mandelbloom.scene.ts`:

```ts
import { defineScene, envelopeSignal, Signal, texNode } from "@loom/runtime";
import { mix, smoothstep, vec4 } from "three/tsl";
import { blobs } from "../modules/sources/blobs";
import { mandelbrot } from "../modules/sources/mandelbrot";
import { noise } from "../modules/sources/noise";
import { feedback } from "../modules/effects/feedback";
import { glitch } from "../modules/effects/glitch";
import { levels } from "../modules/effects/levels";
import { paletteMap } from "../modules/effects/paletteMap";

/**
 * A Mandelbrot set whose exterior filaments flow through the global palette
 * ramp while its black interior hosts a living "garden" — warped noise + drifting
 * blobs tinted with discrete palette stops, blooming on the kick. A bright accent
 * rim separates interior from exterior. Flip palette.source (own / primary /
 * secondary) to retint the entire frame live, no rebuild.
 *
 * Palette roles: 0 bg (dark interior base) · 1 edge · 2/3 garden core ·
 * 4 accent (rim + kick bloom). own() boots the authored look.
 */
export default defineScene({
  name: "mandelbloom",
  description:
    "Mandelbrot with a palette-ramped exterior and a kick-blooming garden inside the black interior; flip palette.source to retint everything.",
  tags: ["fractal", "palette", "audio-reactive", "showcase"],
  build(ctx) {
    const dive = ctx.float("dive", { default: 0.05, min: -0.5, max: 0.5, description: "zoom speed (octaves/sec, ping-pongs)" });
    const depth = ctx.float("depth", { default: 3, min: 0.5, max: 10, description: "zoom depth (octaves); low keeps the interior on screen" });
    const iter = ctx.int("iter", { default: 200, min: 40, max: 500, description: "escape-time iteration cap (detail vs cost)" });
    const scroll = ctx.float("scroll", { default: 0.05, min: -0.5, max: 0.5, description: "exterior ramp scroll speed" });
    const warp = ctx.float("warp", { default: 3, min: 0.5, max: 8, description: "interior texture scale (garden busyness)" });
    const garden = ctx.float("garden", { default: 1, min: 0, max: 2, description: "interior element intensity" });
    const bloom = ctx.float("bloom", { default: 1, min: 0, max: 3, description: "kick accent bloom strength" });
    const rim = ctx.float("rim", { default: 0.05, min: 0.005, max: 0.2, description: "set-boundary rim width" });
    const trail = ctx.float("trail", { default: 0.6, min: 0, max: 0.93, description: "feedback trail persistence" });
    const glitchAmt = ctx.float("glitch", { default: 0.12, min: 0, max: 1, description: "kick glitch burst amount" });

    // Authored default stops (roles above). own() boots this look; flipping
    // palette.source to primary/secondary retints filaments, garden and rim together.
    const pal = ctx.palette;
    pal.own(["#070a1e", "#1b3a6b", "#34d1c9", "#b15be0", "#ffd166"]);

    // Kick envelope: drives interior bloom, glitch burst and a small zoom punch.
    const kick = ctx.audio.onset({ band: "bass", threshold: 0.2 });
    const kickEnv = envelopeSignal(kick, { decay: 0.35 });
    const kickU = ctx.uniformOf(kickEnv);

    // Base fractal (grayscale; brightness b = 0 inside the set). Shallow, slow
    // dive keeps a chunky interior on screen for the garden to live in.
    const fractal = mandelbrot(ctx, {
      cx: -0.6,
      cy: 0,
      dive: dive.signal(),
      depth: depth.signal(),
      iterations: iter.signal(),
    });
    const b = fractal.color.r;
    const rimW = ctx.uniformOf(rim.signal());
    const inSet = smoothstep(0, rimW, b).oneMinus();       // 1 inside the set, 0 outside
    const rimMask = inSet.mul(inSet.oneMinus()).mul(4);    // parabola peaking at the boundary

    // Exterior: filaments mapped through the palette ramp, slowly scrolling.
    const scrollS = scroll.signal();
    let phase = 0;
    const scrollSig = new Signal((f) => (phase = (phase + f.dt * scrollS.get(f)) % 1));
    const exterior = paletteMap(ctx, { input: fractal, shift: scrollSig });

    // Interior garden: warped-noise hue mix of the two core stops, masked by
    // drifting blobs, on a dimmed bg stop; accent stop blooms on the kick.
    const warpN = noise(ctx, { scale: warp.signal(), speed: 0.15 });
    const orbs = blobs(ctx, { count: 6, size: 0.13, speed: 0.4, wobble: 0.06 });
    const orbInk = orbs.color.x;
    const orbCore = orbs.color.y;
    const gardenHue = mix(pal.color(2), pal.color(3), warpN.color.r);
    const gardenS = ctx.uniformOf(garden.signal());
    const bloomS = ctx.uniformOf(bloom.signal());
    const interior = pal
      .color(0)
      .mul(0.25)
      .add(gardenHue.mul(orbInk).mul(gardenS))
      .add(pal.color(4).mul(orbCore).mul(kickU.mul(bloomS).add(0.15)));

    // Composite exterior/interior by the set mask, then add the accent rim.
    const composited = mix(exterior.color.rgb, interior, inSet);
    const withRim = composited.add(pal.color(4).mul(rimMask));
    const src = texNode(vec4(withRim, 1), exterior.passes);

    // Effects: trails (zoom punches on the kick) → kick glitch burst → grade.
    const zoom = kickEnv.map((k) => 1.001 + k * 0.01);
    const trails = feedback(ctx, { input: src, amount: trail.signal(), zoom });
    const glitched = glitch(ctx, {
      input: trails,
      amount: glitchAmt.signal(),
      burst: kickEnv,
      split: 0.4,
    });
    return levels(ctx, { input: glitched, gain: 1.06, gamma: 1.05 });
  },
});
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: clean. `content/CATALOG.md` gains a `mandelbloom` scene line with the param list.

- [ ] **Step 3: Eyes-on — build it in a sandbox**

With the engine running on `?audio=test`, via MCP:
- `create_instance { scene: "mandelbloom" }` → note the id; `get_session` → its `instanceError` is null.
- `screenshot { instance: <id> }`

Expected: a Mandelbrot body that reads as a dark interior with glowing garden specks, colored filaments outside it, and a bright (yellow accent) rim at the boundary. Not a flat black blob, not a uniform wash.

- [ ] **Step 4: Eyes-on — palette flip retints, no rebuild**

- `get_manifest { instance: <id> }` → confirm `palette.source` exists with `value: 2` (own, because the scene called `own()`).
- `set_param { instance: <id>, path: "palette.source", value: 0 }` → `screenshot`: whole frame retints to the **primary** global palette (different hues, same structure).
- `set_param { ..., value: 1 }` → `screenshot`: retints to **secondary**.
- `get_session` → the instance's `builds` is still `1` (flip caused no rebuild).

- [ ] **Step 5: Eyes-on — knobs and kick**

- `set_param { instance: <id>, path: "rim", value: 0.15 }` → `screenshot`: thicker boundary rim.
- `set_param { instance: <id>, path: "garden", value: 2 }` → `screenshot`: brighter interior specks.
- With `?audio=test` running, watch a `screenshot` during a kick (or set `bloom` to 3) → interior accent visibly blooms.
- Reset tweaked params to defaults; leave the instance for Task 4's comparison or `destroy_instance`.

- [ ] **Step 6: Commit**

```bash
git add content/scenes/mandelbloom.scene.ts content/CATALOG.md
git commit -m "mandelbloom scene: palette ramp exterior + stop-tinted garden interior"
```

---

### Task 4: Refactor `mandelbrot.scene.ts` onto the diving module

**Files:**
- Modify: `content/scenes/mandelbrot.scene.ts`

Goal: remove the inline dive/glide math now that the module owns it. **The param surface and visual output must be unchanged.**

- [ ] **Step 1: Swap the imports**

Remove the `lag` import line:

```ts
import { lag } from "../modules/control/lag";
```

(`Signal`, `colorize`/`PALETTES`, `levels`, `mandelbrot` imports stay.)

- [ ] **Step 2: Replace the inline glide + zoom integrator with module opts**

Delete these blocks (the lag center signals and the `scale` integrator, currently ~lines 48-60):

```ts
    // Glide between targets instead of jump-cutting.
    const cx = lag(ctx, { input: new Signal((f) => POINTS[Math.round(pointSig.get(f))]!.x), seconds: 1.2 });
    const cy = lag(ctx, { input: new Signal((f) => POINTS[Math.round(pointSig.get(f))]!.y), seconds: 1.2 });

    // Integrate dive speed, fold into a 0..depth ping-pong, map to view scale.
    let zoomAcc = 0;
    const scale = new Signal((f) => {
      zoomAcc += diveSig.get(f) * f.dt;
      const d = Math.max(0.001, depthSig.get(f));
      const m = ((zoomAcc % (2 * d)) + 2 * d) % (2 * d);
      const octaves = m < d ? m : 2 * d - m;
      return 1.25 * Math.pow(2, -octaves);
    });
```

Then change the `fractal` line from:

```ts
    const fractal = mandelbrot(ctx, { cx, cy, scale, iterations: iter.signal() });
```

to:

```ts
    const fractal = mandelbrot(ctx, {
      cx: new Signal((f) => POINTS[Math.round(pointSig.get(f))]!.x),
      cy: new Signal((f) => POINTS[Math.round(pointSig.get(f))]!.y),
      glide: 1.2,
      dive: diveSig,
      depth: depthSig,
      iterations: iter.signal(),
    });
```

(`diveSig`/`depthSig`/`pointSig` already exist above. `baseScale` defaults to 1.25 in the module, matching the old `1.25 *` factor — identical math.)

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: clean. Watch for an unused `Signal` import warning — it's still used (the cx/cy signals), so it stays.

- [ ] **Step 4: Eyes-on — visually identical**

Via MCP:
- `create_instance { scene: "mandelbrot" }` → `screenshot`.
- Compare against the Task 1 baseline screenshot: the dive looks the same (same center glide on `point`, same ping-pong zoom). `set_param { path: "point", value: 3 }` → it glides to the new target.
- `destroy_instance` when satisfied.

- [ ] **Step 5: Commit**

```bash
git add content/scenes/mandelbrot.scene.ts
git commit -m "mandelbrot scene: consume the diving mandelbrot module (dedup dive math)"
```

---

### Task 5: Docs + decision log

**Files:**
- Modify: `DECISIONS.md`
- Modify: `agent-updates.md`

- [ ] **Step 1: `DECISIONS.md`** — append (newest at bottom):

```markdown
## mandelbloom / mandelbrot module dive (2026-06-11)

- The `mandelbrot` source module absorbed the dive animation (optional `glide`
  lag on cx/cy + `dive`/`depth`/`baseScale` ping-pong zoom integrator) instead of
  a separate `mandelDive` module — one abstract source covers both the static
  renderer and the self-diving case. Default path (no `dive`/`glide`) is
  byte-identical, so existing callers are unaffected; `mandelbrot.scene.ts` was
  refactored onto it, deleting its duplicated integrator.
- New `paletteMap` effect (`content/modules/effects/paletteMap.ts`): maps input
  luminance through the **global** palette ramp (`ctx.palette.ramp`), the
  palette-native sibling of `colorize` (which only knows the cosine PALETTES
  presets). Any scene using it auto-declares `palette.source`.
- New `mandelbloom` scene showcases M6 palettes: exterior filaments via the ramp,
  black-interior "garden" via discrete stops, accent-stop boundary rim for
  contrast, all retinted live by one `palette.source` flip.
```

- [ ] **Step 2: `agent-updates.md`** — append a dated entry:

```markdown
## 2026-06-11 — mandelbloom palette showcase

Shipped a palette-showcase scene and supporting modules (all `content/`, no
kernel changes):
- `mandelbrot` module made abstract: optional `glide` + self-`dive`/`depth`/
  `baseScale`; `mandelbrot.scene.ts` refactored onto it (dive math deduped).
- New `paletteMap` effect: luminance → `ctx.palette.ramp` (global-palette colorize).
- New `mandelbloom` scene: ramp-colored fractal exterior + stop-tinted, kick-
  blooming garden in the set interior + accent rim; flip `palette.source`
  (own/primary/secondary) to retint the whole frame, no rebuild.
Gates: `pnpm typecheck` + `pnpm test` green; `pnpm validate:m6` green; eyes-on via
MCP (retint with no `builds` increment, kick bloom on `?audio=test`).
```

- [ ] **Step 3: Commit**

```bash
git add DECISIONS.md agent-updates.md
git commit -m "Docs: mandelbloom scene + mandelbrot/paletteMap module decisions"
```

---

### Task 6: Final gates

- [ ] **Step 1: Contract + unit gates**

Run: `pnpm typecheck && pnpm test`
Expected: both green. (`content/CATALOG.md` already committed; if `typecheck` re-stages it, commit the diff.)

- [ ] **Step 2: Palette acceptance still passes**

Run: `pnpm validate:m6`
Expected: all checks PASS. (mandelbloom doesn't touch the palette plumbing; this confirms no regression.)

- [ ] **Step 3: Smoke the broader suite (only the dive refactor touched shared content)**

Run: `pnpm validate:m0 && pnpm validate:m1 && pnpm validate:m2`
Expected: green. (m2 asserts `pulse`'s manifest as a subset — untouched. No validator pins `mandelbrot` or `mandelbloom`.)

- [ ] **Step 4: If any catalog/diff remained, final commit**

```bash
git add -A
git commit -m "mandelbloom: catalog + final gate pass" || echo "nothing to commit"
```

---

## Self-Review Notes

- **Spec coverage:**
  - Extend `mandelbrot` (glide + dive) → Task 1; refactor existing scene onto it → Task 4.
  - `paletteMap` effect → Task 2.
  - `mandelbloom` scene (mask off `b==0`, exterior ramp, interior garden, accent rim, feedback/glitch/levels, kick bloom, `own()` defaults) → Task 3.
  - Eyes-on acceptance (build sandbox, palette flip no-rebuild, stop edit retint, kick bloom, mandelbrot unchanged) → Tasks 3-4 steps + Task 6.
  - Never-go-black / `content`-only / sandbox workflow → honored (no `packages/` edits; `create_instance` not `live.scene.ts`).
  - Out-of-scope (kernel changes, palette UI, kaleido, deep-dive heuristics) → none introduced.
- **Type/API consistency:** `asSignal`, `lagSignal`, `Signal`, `envelopeSignal`, `texNode`, `ctx.uniformOf`, `ctx.palette.color/ramp/own` all match `packages/runtime/src/index.ts` exports and existing usage (lava/gradient/mandelbrot scenes). Module opts (`glide`/`dive`/`depth`/`baseScale`) are read consistently in Task 1 and passed consistently in Tasks 3-4. `paletteMap` returns `texNode(ramp, input.passes)`; the scene reads `exterior.color.rgb` and `exterior.passes`.
- **Placeholders:** none — every code step is complete and self-contained.
- **Risk:** the only behavior-changing edit to existing content is the `mandelbrot.scene.ts` refactor; the module's default path is unchanged, and Task 4 verifies visual parity. Interior visibility depends on a shallow default `depth` (3) — documented; deep dives intentionally lose the interior.
