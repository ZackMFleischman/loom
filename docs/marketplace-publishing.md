# Publishing to the LOOM marketplace (Phase 1)

The Phase-1 marketplace is **git-native**: no backend, no accounts, no upload.
Publishing is a pull request adding one entry to the community `index.json`;
moderation is that PR's review; ratings are a field maintainers keep. This page
is the one-pager for authors and for the trust posture everyone should read
before installing.

## Publish your pack (FR-7)

1. **Ship a pack** following [module packs](architecture.md#module-packs): a repo
   mirroring `content/`'s layout with a `loom-pack.json`
   (`{ name, version, loomApi, description }`). Authoring rules (metadata, tags,
   a `test/cases.ts` entry per module) are the same quality bar as in-repo
   content — the `library-use` skill. A pack that follows them is already
   catalog-ready and test-gated.
2. **Open a PR to the community index** adding one entry to `index.json`'s
   `packs` array:

   ```json
   {
     "name": "myPack",
     "gitUrl": "https://github.com/me/my-pack.git",
     "gitRef": "v1.0.0",
     "description": "One line: what's in it and the vibe.",
     "tags": ["organic", "audio-reactive"],
     "author": "me",
     "loomApi": "^1",
     "rating": 0
   }
   ```

   - `name` and `loomApi` must match your `loom-pack.json`.
   - `tags` SHOULD come from the catalog vocabulary (`base`, `finish`,
     `stateful`, `audio-reactive`, `generative`, `geometric`, `organic`,
     `retro`, `3d`, `particles`, `video`, `feedback`, `color`, `warp`) — those
     are the terms searchers already filter local content by. An off-vocabulary
     tag is a warning, not a rejection.
   - `gitRef` (optional) pins a branch/tag/SHA — the install hint passes it
     through as `pack:add … --ref <gitRef>` so installs match your pin.
   - `rating` (optional) is a maintained popularity aggregate (see below).
3. **CI validates** your entry against the frozen schema (the same validator the
   `pnpm test:scripts` suite runs over the seed). A malformed entry fails the
   check; an off-vocabulary tag warns.
4. **A maintainer merges.** Your pack now appears in `pnpm pack:search` and the
   agent's `search_content`. Removal is a revert.

## The index schema is FROZEN (FR-1)

`{ schemaVersion: 1, packs: [{ name, gitUrl, gitRef?, description, tags[],
author, loomApi, rating? }] }`. Phase 2's hosted store returns the **same
shape** with extra fields — adding optional fields does not bump
`schemaVersion`; only an incompatible change does. Build against this shape and
it survives the Phase-2 transport swap (the index is the contract, not the
transport — NFR-1).

## Ratings are git-native (FR-8) — and are NOT a security signal

Before a backend exists, a rating is just the `rating` field. In Phase 1 it's a
maintained aggregate (a star-count mirror or a PR-appended tally). The CLI and
`search_content` surface whatever the field carries and tie-break ranking by it.
Phase 2 replaces the source with real account-based aggregation — same field.

**A rating is popularity, not a security audit.** It tells you others used a
pack; it tells you nothing about whether the code is safe.

## Moderation is the merge queue (FR-9)

With no backend, moderation *is* the index repo's PR review: an entry appears
only after a maintainer merges it; takedown is a revert. Maintainers listing an
entry is **not** a claim that they vetted its code. The line between "we listed
it" and "we vetted it" is "we listed it" — read the source yourself.

## Trust posture — loud and UNCHANGED (NFR-3)

The marketplace **widens reach**, which **raises the stakes** of the module-pack
trust model — it does not change it:

- **Installing a pack runs arbitrary code** at the same trust level as editing
  `content/` yourself. There is **no sandbox** in Phase 1 (documented, not
  promised).
- **Install is human-gated, like `commit`.** Discovery (`search_content`,
  `pack:search`) pulls nothing and needs no arming; turning a search hit into
  installed code is a separate, deliberate `pnpm pack:add` step a human runs.
- **Search the local catalog first** (`content/CATALOG.md`, `availableScenes`,
  `availableEffects`) before reaching for a remote pack — the `library-use`
  reflex, aimed wider. Don't pull a stranger's pack when a local module fits.
- **Every entry shows author + source URL** so you can read the code before you
  run it.

## Remix a pack you installed

- **Tune, don't fork (first resort):** an installed pack's scenes/effects retune
  live via the existing param / chain / layer tools — zero new code.
- **Override one module (local-shadow):** author a bare-name local
  `content/modules/.../<name>.ts`; LOCAL-WINS precedence shadows the pack's
  same-named item without touching the pack.
- **Fork the whole pack:** `pnpm pack:fork <name>` copies it into an editable,
  un-pinned `forks/<name>/` tree and detaches the pin — the files are now yours
  to edit; `pnpm pack:update` leaves a fork alone.

## Offline (NFR-2)

Search needs the index (a local file or a URL). If it's missing or unreachable
you get a clean error — discovery is strictly additive. **Already-installed
packs are unaffected**: they load offline from `content/state/packs.json`, so a
live performance never depends on reaching the marketplace.
