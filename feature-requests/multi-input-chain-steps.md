# Multi-input / branching chain steps (post-v1 candidate)

**Status:** idea, not scheduled. Captured from PR #7 review.

## The gap

The M6 chain is a **linear pipe**: every step is a single-input post-effect
(`(input: TexNode) => TexNode`). That's why the picker only offers single-input
effects and excludes `over` (needs an `overlay` TexNode) and `flyby` (needs image
`urls`). Anything that takes a *second* source can't be a chain step today.

## The idea

Let a chain step declare extra **inputs** beyond the piped one, each bound to a
source the human/agent picks:

- **an asset** — image/video/model from an asset picker (ties into the M10 asset
  explorer): `over`'s overlay, `flyby`'s sprite urls.
- **another instance** — a live tile's output as a texture (instance-as-source).
- **an earlier chain entry** — tap the output of step *k* as this step's second
  input (turns the linear chain into a small DAG).

## Sketch

- Effects declare typed input slots in metadata, e.g.
  `meta.chainInputs: [{ name: "overlay", kind: "tex" }]` alongside `chainParams`.
- `ChainStep` gains `inputs: { [slot]: SourceRef }` where `SourceRef` is
  `{ asset: path } | { instance: id } | { step: id }`.
- The fold resolves each `SourceRef` to a TexNode before calling the factory:
  an asset → an `image`/`video` source; an instance → `texture(entry.target)`;
  a step → that step's folded TexNode. Cycle/ordering guard for `{ step }`.
- Console: each step card grows an input-slot row with a source picker
  (asset / instance / earlier-step), mirroring the param rows.

## Why later

Real scope: typed input slots in metadata + the registry, `SourceRef` resolution
in the fold (with cycle detection once steps can reference steps), asset-picker UI
(wants the M10 asset explorer), and instance-as-texture plumbing. Lands naturally
after assets (M10) and the Geo/source work, reusing this PR's `chainParams`/picker
machinery for the param half.
