---
name: library-use
description: Use BEFORE writing any new LOOM module or scene, and when composing visuals from existing modules — search the catalog first, reuse before rewriting, register what you write so the next agent finds it.
---

# Library use

The library only grows itself if every session searches before writing and
registers after writing. `content/CATALOG.md` is the search surface — generated,
always current in a live session (the dev server rebuilds it on every save).

## Search first — the order of resort

1. **Scan `content/CATALOG.md`** for what you need. Each module line carries:
   one-line description, a usage example, tags, **⛓chainable** (selectable as an
   FX-chain step via `set_chain`/the Console picker), and **⚡inputs** (named rack
   channels it consumes). Scene lines list params + inputs — steal wiring from
   the closest existing scene.
2. **Compose before writing.** Most "new" looks are two existing modules and a
   signal: `displace` over `voronoi`, `bloom` after `threshold`, `mixer` between
   two `video` decks. A chain (`set_chain`) may not need scene code at all.
3. **Tune before composing.** If an existing scene is 80% right, `set_param` /
   `set_chain` / layer rigs close the gap with zero new code.
4. Only then write a module — and check the saved-chain composites
   (`content/modules/effects/chains/`) too; the look may already be saved data.

## Match by capability, not name

- Need audio-reactivity? Filter for ⚡inputs and the `audio-reactive` tag — and
  remember ANY module's `SignalLike` opt accepts `ctx.input("kick")`.
- Need it in an FX chain? It must be ⛓chainable (declares `chainParams`).
  Two-input effects (`mixer`, `over`, `displace`-with-map) can never be chain
  steps — chains carry one input; those are scene-composition modules.
- Saved chains (composites) are ONE level deep: a composite may contain only
  primitives, never another composite. Its inner knobs namespace as
  `fx.<id>.<innerId>.<param>`.
- Need 3D? `geo` modules return GeoNodes/CamNodes; only `render3d` makes pixels.

## Register after writing

A new module isn't done until the NEXT agent can find and trust it:

1. Complete metadata: `name` (matches the export), one-line concrete
   `description`, searchable `tags` (reuse existing vocabulary: `stateful`,
   `audio-reactive`, `base`, `finish`, `retro`, `organic`, `3d` — grep the
   catalog before inventing a tag), and a real `example`.
2. Effects that belong in chains declare `chainParams` (that IS the
   registration for the FX picker).
3. A `content/test/cases.ts` entry — the completeness test fails without it.
4. Save the file: the catalog regenerates itself; `pnpm typecheck` is the
   offline check that it did.

## Parallel builds (the M11 workflow)

When building several scenes/modules at once, give each subagent its own
sandbox: own instance/tile (`create_instance`), a **fixture** input
(`inputs: "fixture:<name>"`) so audio is deterministic and shared with no one,
and ONLY independent files to write. Coordination is types: write each module's
exported interface + metadata stub first, get `pnpm typecheck` green, then fill
implementations. Scenes are independent files by construction — three agents
writing three `*.scene.ts` never collide.
