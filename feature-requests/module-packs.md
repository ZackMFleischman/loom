# Module packs — third-party repositories of modules & scenes

**Status:** v1 IMPLEMENTED (2026-06-13) — see `DECISIONS.md` "Module packs (v1)"
and the "Module packs" section of `docs/architecture.md`. The notes below are the
original design sketch (2026-06-12); the shipped schema/precedence rules live in
DECISIONS. Goal: anyone can maintain their own repo of LOOM modules/scenes and
import it into a project — the library stops being a monorepo-only artifact.

## Shape of a pack

A pack is a plain repo/folder mirroring `content/`'s layout — no build step:

```
my-pack/
  loom-pack.json          # { name, version, loomApi: "^1", description }
  modules/{control,sources,effects,geo}/*.ts
  scenes/*.scene.ts
  assets/**               # textures, clips, models the content references
  test/cases.ts           # the pack's minimal-opts registry (same contract)
```

Modules import ONLY `@loom/runtime` (+ three) — the same rule the golden
patterns already enforce in-repo. That contract is what makes packs portable.

## Registration & loading

- `content/state/packs.json` lists installed packs (path or git URL + pin),
  the same registered-roots idiom as `media-roots.json`.
- The engine's barrels (`scenes.ts`, `effects.ts`) and the catalog generator
  grow pack-aware globs: `packs/<name>/modules/**` etc. Vite aliases give
  packs the same `@loom/runtime` resolution the local content gets.
- Names namespace as `<pack>/<module>` in the catalog and `availableScenes`
  (`hippoPack/aurora`), with bare names still resolving for local content.
- `pnpm pack:add <git-url|path>` clones/links into `packs/` (gitignored,
  lockfile records the pin); `pack:update` re-pins.

## What already lines up (why this is cheap later)

- The catalog is AST-generated from files on disk — pointing it at more
  folders is trivial, and the ⛓/⚡ columns carry over.
- The tier-1/2 content tests discover by glob — a pack's `cases.ts` merges
  into the completeness sweep, so pack quality is enforced identically.
- Golden-pattern scans (no TSL `time`, no `audio.onset`, no engine imports)
  run over pack sources unchanged — the determinism/portability contract
  travels with the code.
- `media-roots`/`mediafs` already solve "content references files outside the
  repo" for pack assets.

## Open questions

- Versioning the runtime API surface (`loomApi` semver vs. typecheck-as-gate —
  probably both: typecheck is the real gate, the field is the fast hint).
- Param-path collisions when two packs ship a module with the same name
  (namespacing solves the catalog; `defineModule` meta may need the pack id).
- Trust: packs are arbitrary code executed in the engine — same trust level as
  editing `content/` yourself; document, don't sandbox, for v1 of packs.
