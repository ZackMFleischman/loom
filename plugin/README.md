# loom-use — drive a LOOM rig with an agent

`loom-use` is a Claude Code plugin for **using** LOOM (the AI-driven live-visuals
instrument): the `loom` MCP control surface plus the using-LOOM skills. Install it
and you can describe visuals in natural language and have an agent tune scenes,
switch looks, stage/commit, and screenshot a running LOOM rig — **without cloning
the LOOM monorepo or inheriting its engineering tooling**.

This plugin is for people who have LOOM running. It deliberately ships **none** of
the engine-development surface (no `packages/` guidance, no validator skill, no
`validate:*` scripts).

## What's inside

| Component | What it does |
|---|---|
| `loom` MCP server (`.mcp.json` → `server/index.js`) | The bundled, self-contained sidecar: a WebSocket server the LOOM engine dials into, exposing the agent tools (`get_session`, `set_param(s)`, `set_chain`, `create_instance`, `stage`, `commit`, `screenshot`, `get_diagnostics`, `batch`, …). |
| `loom-driving` skill | The MCP tool reference, the live-performance rules, and the "make me a visual" workflow. |
| `library-use` skill | Search the catalog, reuse before rewriting, register what you write. |
| `module-authoring` skill | The `defineModule` contract, TSL/shader gotchas, the golden example. |
| `scene-composition` skill | `defineScene`, the InputBus, params as the tuning surface, palettes, layers. |

## How it connects (important)

The sidecar is the WebSocket **server**; your LOOM **engine** is the client that
connects to it. The two must agree on a port:

- The plugin prompts for **`ws_port`** at enable time (default **7341**). It is
  passed to the sidecar as `LOOM_WS_PORT`.
- Point your LOOM engine at the same port (its `?ws=` URL param / `LOOM_WS_PORT`).
- Until the engine connects, every tool returns a clean
  **"engine not connected — start LOOM"** error. That means *launch your LOOM*,
  not "the plugin is broken".

`get_diagnostics { scope: "sidecar" }` reports whether the engine is connected and
the sidecar's `protocolVersion`; the engine logs a loud **PROTOCOL MISMATCH**
warning if the plugin and engine are on different protocol generations.

## Install

```
/plugin marketplace add ZackMFleischman/loom
/plugin install loom-use@loom
```

Then start your LOOM engine on the same WS port and ask the agent to drive it.

## Authoring content as a dependency

If you didn't clone LOOM, you have no in-repo `content/` to write into. Author
your modules/scenes as a **module pack** — a plain folder mirroring `content/`'s
layout (`modules/`, `scenes/`, `loom-pack.json`) that your LOOM install loads via
`pack:add` / `content/state/packs.json`. The `library-use`, `module-authoring`,
and `scene-composition` skills carry pack-aware phrasing for where to write and
how to register. See the LOOM docs on module packs.

## Building the bundled sidecar

`server/index.js` is generated from the LOOM monorepo's `packages/sidecar` by
esbuild (single self-contained ESM file, no `tsx`, no `node_modules` at run time):

```
node packages/sidecar/build.mjs plugin/server/index.js
```
