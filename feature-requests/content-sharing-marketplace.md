# Content sharing & marketplace — a discoverable, rated, remixable index of packs

Status: proposed (post-v1 candidate) · Requested: 2026-06-13 · Owner: unassigned

## Summary

[[module-packs]] makes a pack *importable* — a repo mirroring `content/`'s
layout, pinned in `content/state/packs.json`, globbed into the barrels, and
namespaced as `<pack>/<module>`. That solves **depend-on-a-known-URL**. It does
nothing for **find-something-you-didn't-know-existed**. This feature is the
discovery layer that sits on top: a registry/index of shareable packs and
content with search, ratings, and moderation, reachable from inside the cockpit
(Console) and from inside the agent (an MCP tool), plus the remix flow that
turns "I found a pack" into "I forked it and overrode one module."

The phasing is the whole design. **Phase 1** is frictionless: a flat JSON index
of `{ name, gitUrl, description, tags }` entries — no backend, no money, no
accounts — that `pack:add` and an agent can read, so sharing is "PR a line to
the index" and using is "find it, pull it, namespace it." **Phase 2** is a
hosted, searchable, rated, moderated store, only if Phase 1 proves the appetite.
Everything Phase 2 needs (the index shape, the search vocabulary, the trust
posture) is chosen in Phase 1 so it grows rather than gets rewritten.

This document does **not** restate [[module-packs]] — read that first for the
pack format, loading, and namespacing. This is the layer above it.

## Why discovery is the actual gap

The plumbing already makes content *cheap to author and load*; what's missing is
a way to **point at** content you don't already have a URL for.

- **Authoring is already a solved, documented contract.** Modules import only
  `@loom/runtime`; a module isn't "done" until it carries `name`/`description`/
  searchable `tags`/`example` metadata and a `content/test/cases.ts` entry (the
  `library-use` skill, `.claude/skills/library-use/SKILL.md:40-49`). A pack is
  the same files in the same layout ([[module-packs]]). So a third-party author
  already produces *catalog-ready, test-gated* content by following the existing
  rules — the marketplace inherits that quality bar for free.
- **The catalog is the search surface — but only for `content/` on disk.**
  `scripts/build-catalog.mjs` AST-extracts `defineModule`/`defineScene` metadata
  (`build-catalog.mjs:80-135`) into `content/CATALOG.md` with the ⛓chainable /
  ⚡inputs columns. [[module-packs]] notes the generator "grows pack-aware globs"
  so *installed* packs join the catalog. But you can't search a pack you haven't
  installed yet. The marketplace index is the catalog's reach extended to
  content that isn't on your disk.
- **Name resolution is already the binding mechanism.** Scenes resolve by
  `def.name` through an `import.meta.glob` barrel (`scenes.ts:9-21`); effects by
  `meta.name` through a parallel barrel (`effects.ts:25-71`); both surface to the
  agent as `availableScenes` / `availableEffects` in `get_session`
  (`engine-api.ts:901-902`). [[module-packs]] namespaces pack content into those
  same lists (`hippoPack/aurora`). So once a pack is installed, found content is
  usable *by name* with no further wiring — discovery's only job is to get the
  pack installed.

The marketplace is therefore a thin layer: an index that maps a search query to
a pack git URL, a way to read that index from Console and agent, and a remix
flow. The expensive parts (authoring contract, loading, namespacing, catalog
generation, name resolution) already exist or are designed in [[module-packs]].

## Concepts

- **The index** — a registry of *packs* (not individual modules), each entry
  `{ name, gitUrl, description, tags, author, loomApi }`. Granularity is the
  pack because that's the unit [[module-packs]] installs and pins; a pack's
  individual modules/scenes are discoverable via its own `loom-pack.json` +
  generated catalog once installed (or via a cached catalog snapshot in the
  entry — see open questions). The index reuses the catalog's tag vocabulary
  (`stateful`, `audio-reactive`, `base`, `finish`, `retro`, `organic`, `3d`, …
  per `library-use`), so search terms are the ones agents already filter by.
- **Phase-1 index = a JSON file + git.** `packs.json` already exists as the local
  *install* list ([[module-packs]]); the *marketplace* index is its public
  sibling — a single `index.json` in a community repo (or hosted as a static
  file). Sharing = open a PR adding your entry. Using = the index is fetched,
  searched, and an entry's `gitUrl` handed to `pack:add`. No service to run, no
  auth, fully forkable.
- **Discovery surfaces** — the same find-content capability exposed in two
  places, both reading the one index:
  - **Agent (MCP):** a read-only `search_content { query, tags? }` tool that
    returns matching index entries (name, description, tags, gitUrl, install
    hint). This is the natural home — agents already `get_session` for
    `availableScenes`/`availableEffects` and search `CATALOG.md` before writing
    (`library-use`). Searching the *wider* world is the same reflex aimed at the
    index instead of the local catalog.
  - **Console (human):** a "browse" panel in the scene/effect picker that lists
    index entries with their ratings, and an install button that triggers
    `pack:add` behind agent-commit-style arming (pulling arbitrary code is a
    human decision — see trust). Phase 1 can ship CLI-only
    (`pnpm pack:search <q>`) and add the Console panel later; the index is
    identical either way.
- **Remix / fork-and-override** — the after-import flow. Because a pack is just
  files and namespacing keeps `<pack>/<module>` distinct from bare local names,
  remixing has two tiers: (1) **tune without forking** — `set_param`/`set_chain`/
  layer rigs already retune any installed scene live with zero new code
  (`library-use:18-25`); (2) **fork to modify code** — copy the pack into your
  own (un-pinned, editable) tree, or shadow one module by authoring a local
  `content/modules/.../<name>.ts` that wins name resolution over the pack's. The
  local-shadow precedence rule (local beats pack on a bare-name collision) is the
  one new resolution behavior this needs, and [[module-packs]] already flags
  per-pack-id meta for collisions — same machinery.

## Requirements

### Functional

- **FR-1 The index format.** A versioned `index.json`: `{ schemaVersion,
  packs: [{ name, gitUrl, gitRef?, description, tags[], author, loomApi }] }`.
  `name` and `loomApi` mirror `loom-pack.json` ([[module-packs]]); `tags` draw
  from the catalog vocabulary. The schema is frozen in Phase 1 so the Phase-2
  store is the same shape with extra fields (ratings, moderation status).
- **FR-2 Search, agent side.** `search_content { query, tags? }` MCP tool →
  matching entries ranked by name/description/tag match. Read-only, no arming
  (it pulls nothing). Result includes the exact `pack:add` invocation so the
  agent can propose it.
- **FR-3 Search, human side.** `pnpm pack:search <query> [--tag t]` CLI
  (Phase 1) and a Console browse panel (Phase 2) over the same index. The
  Console panel lists rating + author + tags and offers an install action.
- **FR-4 Install from a found entry.** Installing is exactly `pack:add <gitUrl>`
  from [[module-packs]] — discovery hands off, it does not reimplement loading.
  After install the pack's content appears in `CATALOG.md` and
  `availableScenes`/`availableEffects` by namespaced name (already true per
  [[module-packs]]); no marketplace-specific wiring on the run path.
- **FR-5 Remix: tune.** No new mechanism — an installed pack's scenes/effects
  retune live via the existing param/chain/layer tools. Documented as the
  first-resort remix.
- **FR-6 Remix: fork & override.** `pnpm pack:fork <name>` copies an installed
  pack into an editable, un-pinned location (or detaches the pin) so its files
  become yours to edit. **Local-shadow rule:** a bare-name local module/scene
  takes precedence over a pack's same-named one in the barrels — the documented
  way to override a single pack module without forking the whole pack.
- **FR-7 Publish.** Sharing in Phase 1 is "add your entry to `index.json`" — a
  PR to the community index repo, validated against the FR-1 schema by a CI
  check. No upload, no account. Document it as a one-pager.
- **FR-8 Ratings (Phase 1 = git-native).** Before a backend exists, a rating is
  data in the index: an entry carries an aggregate the index maintainers update,
  or ratings lean on the pack repos themselves (GitHub stars as the zeroth-order
  signal). The MCP/CLI search surfaces whatever rating field the schema carries;
  Phase 2 replaces the source with real aggregation.
- **FR-9 Moderation (Phase 1 = the merge queue).** With no backend, moderation
  *is* the PR review on the index repo — an entry only appears after a maintainer
  merges it, and removal is a revert. The trust posture (below) makes this an
  explicit, documented gate, not an implied safety guarantee.

### Non-functional

- **NFR-1 The index is the contract, not the transport.** Phase 1 fetches a flat
  JSON file (committed repo, raw URL, or a tiny static host); Phase 2 swaps the
  *fetch* for an API call returning the same shape. Nothing downstream (search
  ranking, Console panel, install handoff) changes when the transport upgrades —
  the schema (FR-1) is the stable seam.
- **NFR-2 Offline-degrades.** A live performance must never depend on reaching
  the index. Search failing (no network) is a clean tool/CLI error, never a
  blocked use of *already-pinned* packs — discovery is strictly additive to the
  [[module-packs]] install path, which works from the lockfile offline.
- **NFR-3 Trust is loud and unchanged.** Installing a pack runs arbitrary code
  at the same trust level as editing `content/` yourself ([[module-packs]] open
  questions). The marketplace *widens reach*, which *raises* the stakes of that
  trust — so the install action is human-gated (arming, like `commit`), the index
  entry shows author + source URL, and the docs say plainly: a rating is a
  popularity signal, not a security audit. No sandboxing in Phase 1; document,
  don't promise.
- **NFR-4 Reuses the agent's existing reflex.** Search should feel like the
  `library-use` "search before you write" step, just aimed wider: local
  `CATALOG.md` first, then the index. The tool description says so, so agents
  don't pull a remote pack when a local module already fits.

## Surfaces

### MCP (agent)

- `search_content { query, tags? }` → ranked index entries `{ name, description,
  tags, gitUrl, author, rating?, installHint }`. Read-only, source-tagged like
  every tool, agent-allowed (it changes nothing). Description: searches the
  *shareable* index, after you've checked the local catalog; pulling a result is
  a separate, human-gated step.

### CLI (human / scripts)

- `pnpm pack:search <query> [--tag t]` — same index, terminal output. Phase 1's
  primary human surface (no Console work needed to ship sharing).
- `pnpm pack:fork <name>` — copy an installed pack into an editable tree for
  remixing (FR-6).
- (`pnpm pack:add` / `pack:update` are [[module-packs]], reused as-is.)

### Console (human)

- Phase 2: a "browse" tab beside the scene/effect picker — index entries with
  rating, author, tags, and an arming-gated install button. No visible Phase-1
  Console work; the picker already lists installed (namespaced) content via
  `availableScenes`/`availableEffects`.

## Phased plan

### Phase 1 — frictionless share + depend + remix (no money, no backend)

1. Freeze the `index.json` schema (FR-1) — the load-bearing decision.
2. Stand up a community index repo (the file + a schema-validation CI check) and
   a one-page "publish your pack" doc (FR-7).
3. `pnpm pack:search` over the fetched index (FR-3 CLI half).
4. `search_content` MCP tool (FR-2) — search from inside the agent.
5. `pnpm pack:fork` + the local-shadow precedence rule for override (FR-6).
6. Ratings/moderation as git artifacts (FR-8/9): GitHub stars + the merge queue.

This is shippable on top of [[module-packs]] with **no new running service**.

### Phase 2 — hosted, searchable, rated, moderated store (only if Phase 1 lands)

1. Replace the index *fetch* with a hosted API of the same shape (NFR-1).
2. Real ratings (accounts, aggregation) and active moderation (reports, takedown)
   feeding the same FR-1 fields.
3. The Console browse panel (FR-3 Console half).
4. (Out of scope even here: money/payments — explicitly deferred per the ask.)

## Open questions

- **Per-module vs per-pack discovery.** The index lists packs, but authors will
  want a single *module* found. Cache each pack's generated catalog snapshot in
  its index entry (search hits a module, install brings its pack), or keep
  pack-granular and lean on the post-install `CATALOG.md`? The snapshot is richer
  but can go stale against the pack's actual content — needs a refresh story (CI
  on the pack repo? maintainer re-pull?). *Unverified which is worth Phase-1
  cost.*
- **Discovery UX home — Console vs CLI vs agent.** Recommendation: agent MCP +
  CLI in Phase 1 (cheap, no UI), Console panel in Phase 2. But if humans are the
  primary content-hunters, the Console panel may need to come first — depends on
  who actually browses. *Open: who is the Phase-1 searcher, agent or human?*
- **Ratings without a backend.** GitHub stars are free but coarse and off-
  platform; an index-embedded aggregate needs *someone* to maintain it. Is a
  star-count mirror enough for Phase 1, or does even Phase 1 need a minimal votes
  file (PR-appended) per pack? *Leaning star-mirror; flagging the tension.*
- **Moderation liability.** "Moderation = the merge queue" means index
  maintainers implicitly vouch for merged entries. Where's the line between "we
  listed it" and "we vetted it"? The docs must disclaim, but the social
  expectation may outrun the disclaimer. *Policy question, not technical.*
- **Trust escalation at scale.** [[module-packs]] accepts "document, don't
  sandbox" because a pack is as trusted as your own `content/`. A *marketplace*
  invites pulling from strangers — does that change the calculus enough to want a
  capability boundary (e.g. a vetted-author tier, or a read-the-source gate in
  the install flow) before Phase 2? *Revisit when reach is real.*
- **Override precedence formalization.** FR-6's local-shadow rule (bare local
  name beats pack name) needs the barrels (`scenes.ts:9-21`, `effects.ts:25-71`)
  to define a deterministic merge order; [[module-packs]] raised per-pack-id meta
  for collisions but didn't pin local-vs-pack precedence. *Unverified that the
  current glob order is deterministic enough to rely on.*

## Related

- [[module-packs]] — the pack format, `packs.json`, namespacing, and
  `pnpm pack:add` plumbing this marketplace sits directly on top of. **Read it
  first; this doc deliberately does not restate it.**
- [[loom-user-plugin]] — packaging the content-authoring skills/subagents/MCP as
  an installable Claude Code plugin; the `search_content` tool (FR-2) is a
  natural member of that plugin's toolset.
- The `library-use` skill (`.claude/skills/library-use/SKILL.md`) — "search
  before you write, register after"; the marketplace is that reflex aimed at the
  wider index, and a published pack inherits its metadata/test discipline.
