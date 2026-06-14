# LOOM roadmap

What's shipped, what's next. Supersedes `docs/history/implementation-plan-v1.md`
(the original M0–M9 plan, kept verbatim for the record); requirements live in
`docs/requirements-v1.md`. Rough size: S ≈ a weekend, M ≈ 2–3 weekends, L ≈ a
focused month of evenings.

## Standing stack decisions

- TypeScript everywhere, pnpm monorepo, Vite (dev server + HMR is the deploy
  mechanism); zod for metadata validation; `tsc --noEmit` as the contract gate.
  (A static `vite build` also exists for the per-PR Cloudflare Pages preview —
  "view + tweak", not the live runtime; see `docs/ci-and-preview.md`.)
- Three.js `WebGPURenderer` + TSL (WebGL2 fallback in headless validation); the
  TexNode layer compiles to fullscreen passes on top of it.
- Plain Chrome windows + a Node sidecar (WS bridge + MCP over stdio). No Electron
  in v1 — NDI is the first thing that would force a native shell, and it's out of
  scope.
- One `"globals"` pseudo-instance serves all global state (rack tunings, palettes)
  through the existing `get_manifest`/`set_param` path.
- Tuned state persists via the `loom:state` Vite middleware to `content/state/`
  (plain JSON in git).

## Shipped

| Milestone | Goal | Acceptance |
|---|---|---|
| M0 Pixels (2026-06-09) | edit→hot-render loop, never-go-black layer 1 | `validate:m0` |
| M1 Signals (2026-06-09) | pull-based kernel, InputBus, first 6 modules, NFR-2 | `validate:m1` |
| M2 Agent eyes & hands (2026-06-10) | sidecar + MCP tools, the magic-moment loop | `validate:m2` |
| M3 Stage & Console (2026-06-10) | multi-instance, human-gated commit, PANIC, cockpit | `validate:m3` |
| M4 Clean stage (2026-06-10) | pure Output, cover scaling, `set_audio`, staging UX | `validate:m4` |
| M5 Input rack (2026-06-10) | named channels, globals manifest, persistence, MIDI-learn | `validate:m5` |
| Param modulators (2026-06-10) | runtime LFO/follower attach on any param | `validate:modulators` |
| Console React+MUI rebuild (2026-06-11) | cockpit pages on React 19 + MUI 7, EngineLink | all validators |
| M6 Color & palettes — palette half (2026-06-11) | color param type, global palettes, `ctx.palette`, source switch with no rebuild | `validate:m6` |
| Console UI redesign (2026-06-11) | cohesive dense cockpit: brand, tap-BPM, "+" tile w/ live previews, drag-reorder, drop-to-commit, agent commit armed by default, resizable drawer, swatch palettes | `validate:m3`/`m4` (updated) |
| Housekeeping (2026-06-11) | scene cull (hello/pulse-glitch/vinyl), param groups (fireflies/mandelbrot/mandelbloom + value-key migration), 20 s modulator default, double-click instance rename, 2× tiles, whole-top drop-to-go-live zone | `validate:m3`/`m4` (updated), full suite green |
| Stdlib tests & robustness (2026-06-11) | headless content/ test root (real BuildCtx + probe uniforms), tier-1 contract + tier-2 extremes sweeps over all 22 modules, golden-pattern scans (caught 2 scenes re-detecting kick), broken-module self-test, tier-3 smoke render | `pnpm test:content` (144 tests) + `validate:stdlib` |
| M6 Chains half (2026-06-12) | per-instance FX chains (`set_chain`/`save_chain`), wet/dry mix as a bindable param, insert/reorder, scene-default + restore, saved-chain composites | `validate:m6` (chain checks) |
| Layers (2026-06-11) | `ctx.layer(name, tex)` named nodes: uniform-driven rigs (`<name>.layer.*`, no rebuild), per-node FX chains (`set_chain {node}`, `<name>.fx.*`), `nodes` in manifests, Console node tree, scenes wrapped | `validate:layers` |
| Projects (2026-06-11) | set lists: save/load named instance sets (values, modulators, root + node chains, tile order) to `content/state/projects/`; audience-safe load (sandboxes, deferred cull after commit); MCP list/save/load (agent save arming-gated); Console switcher + save dialog | `validate:projects` |
| M9 Video sources (2026-06-11) | `video` module (speed/scrub/loop as Signals, muted, image-parity placement), `loom:media` middleware (Range/206, registered roots in `media-roots.json`), `beeple-wall` scene on real VJ clips | `validate:m9` |
| Fixtures (2026-06-11) | deterministic input traces: `record_fixture` → `content/state/fixtures/`, `create_instance({inputs:"fixture:…"})` replay, byte-identical `screenshot({frames})` offline pass; TSL `time` banned from content (frame clock only) | `validate:fixtures` |
| M7 Geo (2026-06-11) | GeoNode/CamNode, box/sphere/torus/orbitCam/`model` (glTF + FBX, hippo verified), `render3d` bridge into the TexNode chain, `mediafs` path-style serving, per-instance frame-time HUD + screenshot fps, geo-rave + hippo3d scenes | `validate:m7` |
| M8 Particles (2026-06-11) | `particleEmitter`: mesh-surface sampling (seeded — fixture replays byte-identical), CPU sim over a GPU-instanced pool (WebGL2-validatable; TSL compute = post-v1 upgrade), rate/lifetime/turbulence live; `hippo-swarm` flagship scene (hats → turbulence) committed through feedback+paletteMap via set_chain | `validate:m8` |
| M11 Library & parallel build (2026-06-12) | stdlib burndown (33 modules + 8 scenes) + catalog ⛓chainable/⚡inputs columns, *library-use* skill, parallel proof: 3 subagents built static-haunt/biolume/prism-array concurrently (types-only coordination), hot-registration + concurrent fixture sandboxes validated | `validate:m11` |

Details: `DECISIONS.md` (rationale), `docs/history/agent-updates-m0-m6.md`
(build diary), git history.

## Remaining

*(Build order, top to bottom. M-numbers are identities from the original plan,
not sequence — M9 deliberately builds before M7.)*

### CI — mostly shipped; remainder optional

`.github/workflows/loom-ci.yml` already runs on every PR **and** push to main:
the blocking `checks` job (typecheck → `pnpm test` incl. content sweeps →
production build) plus the Cloudflare Pages preview with scene stills
(`docs/ci-and-preview.md`). The screenshot validators are **deliberately not in
CI** (documented decision: flaky on the runners' software GL; the
never-go-black tests intentionally write broken scenes, which reads as error
spam) — they run locally on real hardware before merges. Optional remainder:
a *scheduled* (weekly) `pnpm validate` run on SwiftShader, informational
rather than blocking, to catch bit-rot between local runs.

### M6 chains half — SHIPPED 2026-06-12

Shipped (see the table above and `DECISIONS.md`), with scope pulled forward beyond
the original sketch: per-instance chains (`chain: ChainStep[]` on the session entry,
folded inside `buildInstance` via `ChainHost`); **enable/disable is a wet/dry
`fx.<id>.mix` float param, not a structural field** (bypass with no rebuild,
MIDI-bindable, ride on a fader); insert-anywhere + drag-reorder; `set_chain`
(full-list/idempotent, arming-gated on the LIVE chain) and `save_chain` (saved-chain
**composites** under `content/modules/effects/chains/`, one level deep); scenes may
declare a default `chain` and `restoreDefault` resets to it. Output types formalized
(`ModuleOutput`, `ChainableEffect`); `glitch`/`feedback`/`levels` carry `chainParams`.
M7 inherits the now-shipped "save as" mechanism for *scenes*; full chain
snapshot/restore across reload stays M9.

### M10 — Asset explorer (M)

**Goal:** everything you can reach for is visible in one pane.

- Left-hand explorer pane in the Console: all modules grouped by kind — control / sources / effects, TouchDesigner-style bins — fed from the generated catalog, so it’s always current.
- **External asset folders:** register additional directories (e.g. a `VJ Assets` folder) that appear alongside the module bins, listing images, videos, 3D models — anything a scene can consume. Registered folders persist in `content/state/`; listings served through the existing Vite/sidecar middleware.
- Selection/drag is the interaction model: anything in the explorer can be selected or dragged onto a tile/param wherever the engine can accept it (image/video paths into source params; scenes into the picker; models once M7 lands).

**Shipped when:** the explorer shows every cataloged module by kind plus a registered external folder; dragging a video from that folder onto a source param plays it live; the folder registration survives restart. (`validate:m10`)

### Panels & save-as (S/M) *(R3.5 + R3.4, split out of M11 — they only depend on M5’s params + bindings)*

- Panel files (R3.5): declarative `{paramPath → widget, midi}` subsets; Console renders open panels; opening activates bindings; *panel-authoring* skill.
- “Save as” flows (R3.4): persist tuned scene; factor a selection into a custom module. The library (M11) is what makes saving worth it, so this lands after — but nothing blocks it earlier if wanted.

**Shipped when:** the R3.5 panel prompt produces a working bound panel; “save it as bass-tunnel” round-trips through restart.

### M12 — Gig hardening (M) *(old M7)*

**Goal:** trust it in a dark room.

- Session snapshot/restore **built on Projects**: crash recovery = autosave of an
  implicit `_session` project every few seconds (transport, slots, open panels,
  values, globals tunings, palettes, chains, bindings) — one serialization path.
- Perf budget: enforce against the per-instance frame-time HUD (built in M7);
  document a perf-check step in the commit skill.
- 90-minute soak test on fixtures (memory/VRAM stability, HMR churn, **rack-tuning and chain-edit churn**).
- A starter set: 8–10 tagged, tuned scenes in the repo **using palettes, chains, and named input channels**; a one-page performer cheatsheet; the §9 magic test executed clean, timed, from fresh clone.

**Shipped when:** you play a real (or fully simulated) 60+ minute set: agent staging looks between tracks, you committing and riding knobs, zero output interruptions. **This is v1.**

-----

## Cross-cutting rules

- Every milestone merges with: typecheck green, the previous milestones’ demos still passing (keep them as scripted checks where possible), and CLAUDE.md/skills updated to match reality — stale conventions poison every future agent session.
- `runtime/` changes get human review; `content/` is agent territory.
- Log non-obvious decisions and ≤6-line SHIPPED entries in `DECISIONS.md`; grep it when touching an unfamiliar subsystem.

## Risks & mitigations

|Risk                                              |Mitigation                                                                                                                                    |
|--------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------|
|HMR semantics fight the instance model            |NFR-5 rebuild-on-change keeps it trivial; revisit only after v1.                                                                              |
|Browser audio latency/quality (Analyser smoothing)|Acceptable for v1 reactivity; AudioWorklet onset/BPM is a contained M5+ upgrade inside InputBus.                                              |
|Agent writes sprawling untyped code               |zod-validated metadata + skills with golden examples + catalog-first rule; reject via tsc, not vibes.                                         |
|Scope creep (this conversation’s natural hazard)  |§8 out-of-scope list is load-bearing. New ideas go to `DECISIONS.md` as post-v1 candidates.                                                   |
|M8 compute has no headless validation path (headless Chromium lacks a WebGPU adapter; TSL compute won’t run on the WebGL2 fallback)|Decide the `validate:m8` strategy before M8 starts: SwiftShader-backed WebGPU, a documented headed GPU run as the gate, or a non-compute fallback path.|

## Post-v1 horizon (ordered candidates)

1. **Module packs** — third-party repos of modules/scenes imported into projects (`feature-requests/module-packs.md`; the catalog/tests/golden-pattern machinery already generalizes)
1. Embedded perform-mode chat pane (Claude Agent SDK client on the existing MCP/WS boundary)
1. NDI out (forces the Electron/native-shim decision)
1. AudioWorklet beat tracking + look-ahead quantization
1. OSC in/out (GrandMA3 says hello)
1. Generative-video source module (Mirage-class / StreamDiffusion as a TexNode source)
1. Pop-out OS-window panes; multi-display layouts
1. Embeddings over the catalog when flat JSON stops scaling
1. PANIC safe-scene mode (`feature-requests/panic-scene.md`)
1. Console screenshot for agents (`feature-requests/console-screenshot.md`)
