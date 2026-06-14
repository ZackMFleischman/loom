# Claude Code plugin for using LOOM

**Status:** requested (2026-06-13) · Owner: unassigned

## Ask

Refactor the **skills / subagents / MCP config** (or whatever is necessary) for the
AI that is **creating content and USING LOOM** — as opposed to **building LOOM
itself** — into a **Claude Code plugin** that a user can install. The user shouldn't
have to clone the LOOM monorepo and inherit our engineering tooling just to drive a
LOOM rig with an agent.

## Why this matters

Today the repo serves two audiences from one `.claude/` tree (`.claude/CLAUDE.md:1`,
the agent guide). The split is real but informal — it lives in prose, not in
packaging:

- **Building LOOM** (engine work, human-reviewed): `packages/*`, the architecture
  doc, `validate:*` suites, the `validator-authoring` skill. `CLAUDE.md:56`
  states the boundary outright — "`packages/*` changes get human review; `content/`
  is agent territory" — and `.claude/CLAUDE.md:34` tells the in-session agent to
  **never** touch `packages/`.
- **Using LOOM** (content + performance, agent territory): `content/` scenes and
  modules, plus the `loom` MCP server. This is exactly the surface a *user* of LOOM
  needs, and the only surface they need.

A Claude Code plugin is the native unit for shipping that second surface to someone
who has LOOM installed but isn't developing it. It also makes the
[[docs-skills-audit]] cleaner: once "using LOOM" is a plugin, our own
`.claude/CLAUDE.md` can shrink to engine-dev guidance and pull the user-facing
skills from the plugin like any other consumer.

## Current inventory — what serves which audience

### Skills (`.claude/skills/*/SKILL.md`)

| Skill | Audience | Notes |
|---|---|---|
| `library-use` | **using** | Search the catalog, reuse before rewriting, register after writing. Pure content workflow (`.claude/skills/library-use/SKILL.md:1`). |
| `scene-composition` | **using** | `defineScene`, InputBus, params, palettes, going live via `live.scene.ts` (`.claude/skills/scene-composition/SKILL.md:1`). |
| `module-authoring` | **using** | `defineModule` contract, TSL gotchas, the golden example (`.claude/skills/module-authoring/SKILL.md:1`). |
| `validator-authoring` | **building** | Playwright acceptance suites under `scripts/validate-*.mjs`, the isolation contract (`.claude/skills/validator-authoring/SKILL.md:1`). **Stays in the repo.** |

So three of the four skills are user-facing; one (`validator-authoring`) is pure
engine-dev tooling and does NOT belong in the plugin.

There are **no `.claude/agents/` and no `.claude/commands/` directories** today
(verified — `.claude/` contains only `CLAUDE.md` and `skills/`). So "subagents" in
the ask is aspirational; the plugin would *introduce* agents/commands if we want
them, not relocate existing ones.

### MCP server (`.mcp.json`)

```json
{ "mcpServers": { "loom": {
  "command": "node",
  "args": ["--import", "tsx", "packages/sidecar/src/index.ts"]
} } }
```

This is the heart of "using LOOM" — it spawns the sidecar
(`packages/sidecar/src/index.ts`), the MCP↔WS bridge that exposes every agent tool
documented in `.claude/CLAUDE.md:5` (`get_session`, `set_param`, `create_instance`,
`stage`, `commit`, `screenshot`, …). The user plugin must ship this MCP server, but
the current declaration is **repo-relative** and assumes a tsx toolchain — both
break for a plugin consumer (see Hard parts).

### The agent-guide prose (`.claude/CLAUDE.md`)

This 17 KB file is almost entirely **using-LOOM** content (the MCP tool reference,
the seven Rules, the "make me a visual" workflow). Its few building-LOOM bits are
the `packages/` map (`.claude/CLAUDE.md:44`) and the "never touch packages" rule
(`.claude/CLAUDE.md:34`) — which is exactly the rule a *user* never needs because
they don't have a `packages/` checkout. This file is the natural seed of the
plugin's top-level guidance, lightly edited.

### Repo dev tooling that stays behind (NOT in the plugin)

The root `package.json` is all engine-dev: `pnpm dev`, `pnpm typecheck`,
`pnpm test`, and the whole `validate:m0…stdlib` wall. `CLAUDE.md` (root) is the
human/engine-dev guide — doc map, "Never go black", the four test layers, PR
screenshot mechanics. None of this ships to a user.

## How a Claude Code plugin is shaped (researched)

A Claude Code **plugin** is a bundle that can carry, in one installable unit:

- **skills** — `skills/<name>/SKILL.md`, identical format to ours today.
- **MCP servers** — declared in the plugin manifest (an `.mcp.json`-equivalent),
  so installing the plugin registers the server.
- **subagents** — `agents/*.md`.
- **slash commands** — `commands/*.md`.
- a **plugin manifest** (`plugin.json` / `.claude-plugin/`) with name, version,
  description, and the component wiring.

Plugins are distributed through a **marketplace** (a `marketplace.json` listing one
or more plugins by name + source), which a user adds and then installs from.

> Open question (verify before building): the exact manifest filenames, the MCP
> declaration schema inside a plugin, and whether a plugin MCP server can read
> install-time configuration (e.g. a port or an install path) are all
> **version-dependent** — pin these against the Claude Code version we target and
> the current plugin docs. Marked as an open question, not asserted.

## Target plugin shape

A `loom` user plugin (working name `loom-use`) would contain:

```
loom-use/
  .claude-plugin/plugin.json     # name, version, description, component wiring
  skills/
    library-use/SKILL.md         # lifted verbatim from .claude/skills
    scene-composition/SKILL.md
    module-authoring/SKILL.md
  agents/                        # NEW (optional) — see "Subagents"
  commands/                      # NEW (optional) — e.g. /loom-live, /loom-stage
  mcp/                           # the loom MCP server declaration (see Hard parts)
  PLUGIN.md / top-level guidance # distilled from .claude/CLAUDE.md, packages-free
```

And a `marketplace.json` (ours, or folded into [[content-sharing-marketplace]]'s
store) that lists `loom-use` so users can `add` + `install` it.

What is deliberately **out**: `validator-authoring`, the `validate:*` scripts, the
`packages/` map, the "never touch packages" rule, and everything in root
`CLAUDE.md`.

## The hard parts

These are the reason this is a feature request and not a five-minute file move.

### 1. The MCP server needs the engine running locally — and the wiring is inverted

Critically, the **sidecar is the WS *server*** and the **engine (browser) is the
client that dials in** — not the other way around. `packages/sidecar/src/index.ts:38`
does `new WebSocketServer({ port })`, and the engine page connects to it
(`?ws=` on the URL; `validator-authoring` confirms this idiom). The default port is
`7341` (`packages/sidecar/src/protocol.ts:10`, `DEFAULT_WS_PORT`), overridable via
`LOOM_WS_PORT` (`packages/sidecar/src/index.ts:36`).

Consequences for a plugin:

- The plugin's MCP server **doesn't need to "find" the engine** — it listens, and
  the user's running engine connects to it. What it DOES need is to **agree on a
  port** with the user's engine. The plugin must let the user set `LOOM_WS_PORT`
  (or document the default `7341`) so engine and sidecar rendezvous.
- When no engine is connected, tools must fail cleanly ("engine not connected —
  start LOOM"), the way the existing broker already handles a null `engineSocket`
  (`packages/sidecar/src/index.ts:51`). A plugin user WILL hit this; the error must
  tell them to launch their LOOM, not look like a plugin bug.

### 2. The MCP command is repo-relative and needs a toolchain

`.mcp.json` runs `node --import tsx packages/sidecar/src/index.ts` — a path
relative to the monorepo root, executing TypeScript via `tsx` from the repo's
`devDependencies`. A plugin consumer has neither the path nor the toolchain.
Options, with rationale:

- **(A) Ship a built sidecar.** Compile `packages/sidecar` to plain JS and ship it
  inside the plugin (or as a published `@loom/sidecar` npm package the plugin's MCP
  command runs). Removes the `tsx` dependency and the repo-path assumption — the
  plugin's MCP `command` points at its own bundled entry. **Recommended.** Today
  the sidecar's only runtime deps are `@modelcontextprotocol/sdk`, `ws`, `zod`
  (`packages/sidecar/package.json`) — small and self-contained, so a standalone
  build is realistic.
- **(B) Plugin points at the user's LOOM checkout.** A config value
  (`LOOM_HOME`) that the MCP `command` resolves against. Keeps one source of
  truth but reintroduces the "user must clone the monorepo" friction the plugin is
  meant to remove. Reasonable as a dev/escape-hatch mode, not the default.

### 3. content/ authoring when LOOM is a dependency, not a checkout

The using-LOOM skills assume a writable `content/` tree (`module-authoring` writes
`content/modules/<kind>/<name>.ts`; `scene-composition` edits
`content/scenes/*.scene.ts` and re-points `content/scenes/live.scene.ts`). A plugin
user who didn't clone LOOM has no `content/` to write into.

This is the deepest coupling and where the plugin **overlaps with**
[[module-packs]] and [[content-sharing-marketplace]]. A user plugin without a place
to put content is half a product. The likely resolution: a plugin user authors
content as a **pack** (a plain folder mirroring `content/`'s layout —
[[module-packs]]) that their LOOM install loads, rather than editing the engine's
in-repo `content/`. The skills' "register after writing" and "search the catalog"
steps then need a pack-aware phrasing. **A user plugin and content packs are
complementary, not alternatives** — the plugin ships the *workflow* (skills + MCP +
agents), packs are the *artifact* that workflow produces and shares.

> Open question: does the v1 plugin require [[module-packs]] to have landed, or can
> v1 ship the MCP control surface + skills for *driving an existing LOOM rig*
> (tune params, stage/commit, switch scenes, screenshot) and defer authoring-as-a-
> dependency to when packs exist? The control surface alone is a coherent, shippable
> first cut.

### 4. Splitting from the repo's own dev tooling without duplicating it

If the plugin's skills are lifted copies of `.claude/skills/{library-use,
scene-composition,module-authoring}`, we now maintain two copies. Options:

- Make the plugin the **single source** and have our own dev setup *install the
  plugin too* (we are also "users" of LOOM when authoring content in-repo). Cleanest
  long-term; pairs naturally with [[docs-skills-audit]].
- Generate the plugin's skills from the repo at release time (a build step). Avoids
  drift but adds machinery.

Recommend deciding this jointly with [[docs-skills-audit]], since that audit is
already going to reorganize `.claude/` and the skills.

## Requirements

### Functional

- **FR-1** A `loom-use` plugin a user installs via a Claude Code marketplace, after
  which the three using-LOOM skills and the `loom` MCP server are available with no
  monorepo clone.
- **FR-2** The plugin's MCP server runs without the repo's `tsx`/path assumptions —
  a self-contained, built entry (Hard part #2, option A).
- **FR-3** Engine/sidecar rendezvous is user-configurable (`LOOM_WS_PORT`, default
  `7341`) and documented; "no engine connected" is a clean, actionable tool error.
- **FR-4** `validator-authoring`, the `validate:*` scripts, and all `packages/`
  guidance are **excluded** — the plugin carries zero engine-dev surface.
- **FR-5** Skills are not forked into permanent divergence — one source of truth
  (FR via Hard part #4).

### Non-functional

- **NFR-1** Versioning: the plugin's MCP protocol version must match the user's
  installed engine. Surface a version hint (mirrors [[module-packs]]'s `loomApi`
  thinking) so a mismatched plugin/engine fails loudly, not weirdly.
- **NFR-2** No secrets / no repo internals leak into the published plugin (it's
  distributed publicly via a marketplace).
- **NFR-3** The plugin works on the platforms LOOM targets (Windows is a first-class
  dev env here — `taskkill`/win32 handling shows up in `validator-authoring`); the
  built sidecar must launch identically on win32/macOS/Linux.

## Phased extraction plan

### Phase 0 — pin the plugin spec

Resolve the open questions in "How a plugin is shaped": exact manifest filenames,
the in-plugin MCP declaration schema, and whether install-time config (port/path)
is expressible. Build a one-skill throwaway plugin to validate the format before
moving real content. Do NOT touch repo code.

### Phase 1 — standalone sidecar

Make `packages/sidecar` buildable/publishable as a self-contained MCP server (Hard
part #2A): no `tsx` at runtime, no repo-relative path, port via env. This is the
only code change and it's additive (engine-dev side, human-reviewed) — it doesn't
alter the existing `.mcp.json` dev flow.

### Phase 2 — assemble the plugin (control surface first)

Plugin manifest + the three using-LOOM skills + the built MCP server, scoped to
**driving an existing rig** (get_session/screenshot/set_param(s)/set_chain/stage/
commit/scene-switch). Authoring-into-`content/` skills ship but are documented as
requiring a writable content root (Phase 3). Distilled top-level guidance from
`.claude/CLAUDE.md`, `packages/`-free.

### Phase 3 — content authoring as a dependency

Wire the authoring story to [[module-packs]]: a plugin user authors into a pack the
engine loads, and the `library-use`/`module-authoring`/`scene-composition` skills
gain pack-aware phrasing for "where do I write, how do I register." Likely gated on
module-packs landing.

### Phase 4 — de-duplicate & publish

Pick the single-source strategy (Hard part #4), make our own dev env consume the
plugin, and publish to the marketplace alongside [[content-sharing-marketplace]].
Fold the leftover engine-dev guidance cleanup into [[docs-skills-audit]].

## Open questions

- Plugin manifest format specifics and whether a plugin MCP server can take
  install-time config — **verify against the targeted Claude Code version** (not
  asserted here).
- v1 scope: ship the **control surface** for an existing rig now, or wait for
  [[module-packs]] so authoring-as-a-dependency works on day one? (Leaning: control
  surface first — it's coherent and unblocks the common "drive my LOOM with an
  agent" case.)
- Standalone sidecar packaging: bundle inside the plugin vs. publish `@loom/sidecar`
  to npm and have the plugin invoke it. (`packages/sidecar/package.json` is
  `private: true` and `0.0.1` today — publishing is a deliberate step.)
- Engine discovery UX: if a user runs multiple LOOM instances or non-default ports,
  how does the plugin make the rendezvous obvious? (Today it's a shared port number
  and the engine dials in.)
- Single-source-of-truth for skills: live in the plugin (and we consume it) vs.
  generate the plugin from the repo — decide with [[docs-skills-audit]].

## Related

- [[docs-skills-audit]] — splitting "using LOOM" out of `.claude/` is the audit's
  natural companion; it cleans up the engine-dev guidance left behind.
- [[content-sharing-marketplace]] — a user plugin (the *workflow*) and content packs
  (the *artifacts*) are complementary; the marketplace is where both are published.
- [[module-packs]] — the import/dependency plumbing that makes content authoring
  work when LOOM is a dependency, not a checkout (Hard part #3).
- [[app-instrumentation]] — adjacent agent-facing surface.
