# Feature request: `screenshot_console` — agent eyes on the cockpit

Status: proposed (post-v1 candidate) · Requested: 2026-06-10 · Owner: unassigned

## Summary

The agent has eyes on the *picture* (`screenshot`: Output canvas for live, preview targets
for sandboxes) but is blind to the *cockpit*: the Console page — tiles, badges, param
panels, status bar, stage strip — has no capture path at all. This feature adds a
`screenshot_console` MCP tool that returns a PNG of the human's actual Console window, so
the agent can see the UI it's reasoning about: verify that a staged badge actually shows,
check param panel layout after adding knobs, and give concrete feedback (or propose
human-reviewed diffs) on Console UX.

## Why it doesn't work today (the routing gap)

- `screenshot` resolves to **instance pixels** — `canvas.toDataURL` in the Output window's
  render loop, or a preview render target readback. The Console's DOM is never in frame.
- The sidecar's WS bridge connects to the **engine page only**. The Console is a sibling
  page that talks to the engine over `BroadcastChannel("loom")`, with a `hello` presence
  beacon. Today's message directions are Console→engine (command envelopes) and
  engine→Console (state/thumbs broadcasts). There is no engine-initiated request that the
  Console answers — that reverse request/response is the one new primitive this needs.
- A headless browser driven from the sidecar can't help: `BroadcastChannel` is same-origin
  *and same browser profile*, so a sidecar-launched Console would see no engine. Capturing
  the human's real window is also the point — their viewport, their theme, their layout.

## Concepts

- **Self-capture**: the Console rasterizes its own DOM in-page (SVG `foreignObject`
  technique — serialize the DOM into an SVG, draw it to a canvas, export PNG). No browser
  permissions, no user gesture, no external process. The Console's UI is vanilla DOM +
  `<img>` thumbnails (already dataURLs), which is the friendly case for this technique.
- **Reverse envelope**: engine→Console request with correlation id and timeout, the mirror
  of the existing Console→engine envelopes.

## Requirements

### Functional

- **FR-1** New MCP tool `screenshot_console {}` → `{ mime: "image/png", base64, width,
  height, consoleId }`. No instance argument — it captures the page, not a tile.
- **FR-2** Routing: MCP → sidecar → WS → engine → BroadcastChannel request → Console
  self-captures → reply → engine → WS → sidecar. Reuses every existing hop; only the
  engine→Console request/response leg is new.
- **FR-3** No Console open (no `hello` within the presence window) → clean tool error:
  `"no Console connected — open /console.html"`. Multiple Consoles → capture the most
  recently hello'd one; include `consoleId` in the result so repeat calls are comparable.
- **FR-4** Capture covers the full Console viewport at device-pixel resolution, including
  tile thumbnails (`<img>` dataURLs serialize fine) and current param panel state.
- **FR-5** Self-capture failure (rasterizer throw, oversized canvas) → structured tool
  error, never a hung request: the engine-side request carries a timeout (~3 s) and maps
  expiry to `"console did not answer"`.
- **FR-6** Fidelity is documented as **approximate**: SVG-foreignObject rasterization is a
  re-render, not a compositor read. Good enough for layout/state/feedback; not for
  pixel-perfect color work (that stays with `screenshot` on instances). The tool
  description says so, so agents don't over-trust it.
- **FR-7** Capture must not disturb the performance: rasterization runs in the Console
  page (its own window/thread), never blocks the Output window's render loop, and the
  engine's role is relay-only.

### Non-functional

- **NFR-1** Rasterizer dependency (e.g. `html-to-image`) is pinned exact like `three`, or
  vendored if it's small enough to audit — it runs inside the performance browser.
- **NFR-2** The reverse-envelope primitive is generic (request kind + payload + timeout),
  not screenshot-specific — it's the obvious carrier for future Console-side queries
  (theme, layout metrics, focused control).
- **NFR-3** Payload size: PNG of a ~1080p Console ≈ 200–600 KB base64 — fine for WS and
  MCP, but the tool should downscale to a `maxWidth` (default 1280) to keep responses
  snappy; full-res via explicit `maxWidth: 0`.

## Surfaces

### MCP (agent)

- `screenshot_console { maxWidth? }` — as above. Tool description spells out: cockpit UI
  capture, approximate fidelity, requires an open Console.

### Console / engine

- No visible UI. Optional dev nicety: a keyboard shortcut in the Console (e.g. `s`) that
  triggers the same self-capture and downloads it — free debugging for the human, and it
  exercises the capture path without an agent.

## Implementation plan

### Phase 1 — Console self-capture module (`packages/engine-app`)

1. `src/console-capture.ts`: `captureConsole(maxWidth): Promise<{ dataUrl, width, height }>`
   wrapping the SVG-foreignObject rasterizer; inline `<img>`/canvas content; guard against
   oversized output by scaling to `maxWidth`.
2. The `s`-key download shortcut in the Console (exercises the path standalone).

### Phase 2 — reverse envelope (`packages/engine-app`)

1. `console-channel.ts`: engine-initiated `{ kind: "console-request", id, op, payload }` →
   Console answers `{ kind: "console-response", id, ok, ... }`; engine keeps a pending map
   with timeouts (mirror image of the bridge's pending map). Target = most recent `hello`.
2. `EngineApi`: `screenshot_console` op, source-tagged like everything else (agent-allowed;
   it's read-only).

### Phase 3 — protocol + sidecar (`packages/sidecar`)

1. `protocol.ts`: request/response types for `screenshot_console`.
2. MCP server: tool #9 (or wherever the count stands), JSON-Schema definition matching the
   existing style; unit tests beside the existing tool tests.

### Phase 4 — acceptance

- Extend `validate:m3` (it already drives a real Console page): call `screenshot_console`
  via MCP, assert non-blank PNG with plausible dimensions, and compare against Playwright's
  own `page.screenshot` of the same Console for gross agreement (both show the tile grid —
  e.g. luminance correlation or just both-non-black + matching aspect).
- No-Console case: close the page, assert the clean error.

Estimated size: console capture ~80 lines + dependency; channel ~60; protocol/sidecar ~60;
validation ~40.

## Edge cases & interactions

- **Console mid-drag / popovers**: captured as-is — that's a feature (the agent sees what
  the human sees, including open param popovers).
- **Thumbnails pause when no Console is present** (existing 5 s rule) — irrelevant here
  since the tool errors without a Console anyway.
- **Two Consoles** (e.g. laptop + tablet): most-recent-hello wins (FR-3); a `consoleId`
  argument to pick explicitly is future work if it ever matters.
- **PANIC**: capture still works — the Console is alive during PANIC; only output rendering
  holds. Useful: the agent can *see* the PANIC state it's being told about.
- **Security/origin**: same-origin DOM only; external images would taint the canvas, but
  the Console loads none (thumbnails are dataURLs). Keep it that way or captures break.

## Resolved decisions

1. **Separate tool, not a `target: "console"` flag on `screenshot`** — different semantics
   (page UI vs. instance pixels), different fidelity guarantees, different failure modes
   (needs a Console open). Overloading would muddy the contract agents rely on.
2. **In-page self-capture over CDP attach** — CDP (`Page.captureScreenshot` against the
   human's Chrome) is pixel-perfect but requires launching Chrome with
   `--remote-debugging-port`, which is setup friction and a remote-control foot-gun on a
   performance machine. Self-capture works in whatever browser is already open. CDP can
   land later as an opt-in "exact mode" without changing the tool's shape.
3. **Most-recent-hello targeting** for multiple Consoles — matches how a performer actually
   uses it (the Console they just touched is the one that matters).

## Out of scope — future candidates

- CDP-based pixel-perfect capture mode (opt-in via launch flag).
- Console video/streaming for continuous agent observation.
- Capturing arbitrary engine pages (the Output window's *DOM* — overlay, error chrome) —
  same primitive would carry it if ever needed.
- Region/element capture (`selector` argument) — wait for a real need.
