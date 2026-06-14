# Application instrumentation — a structured, agent-readable diagnostics surface

Status: requested (2026-06-13) · Owner: unassigned

## Summary

LOOM already has the *beginnings* of telemetry — `window.__loom`, `frameMs`/`slowSignals`,
`fps`/`frame`, `instanceError`, the loop guard, and a tiny sidecar `ToolMetrics` digest — but
it's scattered across three shapes (a window object validators poll, a `get_session` snapshot
agents poll, and `[loom]`-prefixed `console.*` lines no one can read remotely) and it only
ever describes the *present instant*. There is no history: when the agent saves a scene and
the live fps craters two seconds later, nothing remembers the build event, the swap, the HMR
update, or the frame-time spike that connected them. The agent — the primary consumer here,
working blind through MCP — can poll the current number but cannot ask *what just happened*.

This feature adds a **structured, queryable, in-process event log** (a bounded ring buffer of
typed events) and surfaces it to the agent through MCP — a new `get_diagnostics` tool plus a
thin perf rollup — so the agent can correlate cause and effect across the build/swap/render
path. It is deliberately **local-first and hot-path-safe**: no cloud, no library in the render
loop, nothing that can block "Never go black."

## Current state (what telemetry exists today)

Three disjoint surfaces, all snapshot-only, none with a timeline:

- **`window.__loom`** — `packages/engine-app/src/debug-surface.ts`. Refreshed every frame
  (scalars) / every 6 frames (the `instances` array, `INSTANCES_EVERY`, debug-surface.ts:158).
  Carries `fps`, `frame`, `instanceError`, `clockSource` ("raf" | "worker", debug-surface.ts:127),
  per-instance `slowSignals`/`builds`, panic state, inputs, palettes. **Validators read it; the
  Console does not** (only `resumeAudio`). It's a same-page global — invisible to the sidecar
  and therefore to the agent.
- **`get_session` snapshot** — `packages/sidecar/src/protocol.ts` `SessionSnapshot` (protocol.ts:571)
  + `InstanceInfo` (protocol.ts:504). Carries `fps`, `frame`, per-instance `frameMs`
  (protocol.ts:518, rounded in `engine-api.ts:888`), `slowSignals` (protocol.ts:524),
  `instanceError`, `builds`. Assembled in `engine-api.ts` `snapshot()`. This is the agent's
  only real window — and it's a **point sample with no past**.
- **`console.*` logs** — ~22 `[loom]`/`[loom-ui]` lines across `main.ts`, `session.ts`,
  `panic-controller.ts`, `effects.ts`, `bridge.ts`, `console-channel.ts`. These are exactly the
  high-value *events* (scene hot-swapped main.ts:574; instance rebuilt main.ts:612; scene
  rejected main.ts:298 / session.ts:211; effect library reloaded main.ts:628; mic fallback
  main.ts:320; NFR-2 freeze, `instance.ts:73`). But they go to the browser console — the agent
  cannot read them, and they vanish on scroll. **This is the single biggest gap**: the most
  diagnostic information LOOM produces is the least reachable.

Cost-measurement primitives that already exist and should be *reused, not rebuilt*:

- **Per-frame CPU cost**: `Instance.frameMs` (EMA of `performance.now()` deltas,
  `packages/runtime/src/instance.ts:62-77`).
- **Per-signal attribution**: `Instance.runUpdatersProfiled` / `slowSignals()`
  (instance.ts:81-103), gated by `Instance.profilingEnabled` (instance.ts:37, `?profile=0` off).
- **Engine fps**: `packages/engine-app/src/fps.ts` (500 ms window, `performance.now()`).
- **Sidecar tool metrics**: `packages/sidecar/src/metrics.ts` — `ToolMetrics` counts
  `set_param`/`set_params`/`batch` and the `missedBatchable` run-length; flushed to **stderr**
  every 25 calls and on shutdown (`index.ts`). In-memory, no per-call latency, no timeline.
- **Sidecar round-trip plumbing**: `packages/sidecar/src/broker.ts` already mints a correlation
  id per request (`r${++seq}`, broker.ts:40) and holds a pending-promise map with per-tool
  timeout budgets — the natural place to *measure* call latency, which it does not do today.

What is **absent** entirely: any event history; any MCP-readable log; per-MCP-call latency;
build/swap/HMR events as data; WebGL/WebGPU resource counts (no `renderer.info` use anywhere);
`performance.mark`/`measure`/`PerformanceObserver` (zero usages); error capture beyond the
single live `instanceError` string.

## Why this matters for an agent specifically

The agent is not a human at a dashboard. It cannot watch a graph, cannot read the browser
console, and pays a full MCP round-trip for every observation. So the design constraints are
the inverse of a human-facing APM:

- **Structured over rendered.** The agent needs JSON it can filter and reason over, not pixels.
  (The human's in-UI perf view is a separate need — see [[console-performance-stability]] —
  and should be a *second reader of the same data*, not a competing pipeline.)
- **History over instants.** The agent acts, then looks. The thing it needs is "what changed
  between my last screenshot and now" — a windowed event/metric query, not a live number.
- **Pull, bounded, on demand.** No streaming, no push. The agent asks; it gets a capped recent
  slice. This keeps the surface cheap and the render loop untouched.
- **Causal, not just quantitative.** "frameMs jumped to 28" is weak; "frameMs jumped to 28 at
  frame 5102, 40 frames after `instance.rebuilt aurora-2 (chain +bloom)`" is actionable.

## Requirements

### Functional

- **FR-1 In-process event ring buffer (engine).** A bounded (~512 entries, configurable),
  append-only ring of typed events in `packages/engine-app`. Each event:
  `{ seq, frame, t, level: "info"|"warn"|"error", kind, instance?, msg, data? }`. Append is
  O(1), allocation-light, and **never throws** into a caller on the render path.
- **FR-2 The existing `console.*` events become structured events.** Route the high-value
  `[loom]` logs (the ~22 call sites above) through the buffer *in addition to* (or instead of)
  `console.*`. These are the build/swap/HMR/rejection/freeze/fallback events the agent most
  needs — they already exist as English strings; this gives them a `kind`, a `frame`, and a
  reader. Minimum kinds: `scene.swapped`, `scene.rejected`, `instance.rebuilt`,
  `instance.rejected`, `instance.frozen` (NFR-2), `inputs.redefined`, `effects.reloaded`,
  `audio.fallback`, `panic.*`, `loopguard.tripped`.
- **FR-3 Frame-perf events (sampled, not per-frame).** Emit a rolling perf event on a fixed
  cadence (e.g. every ~60 frames) and on **threshold crossings** (fps drops below / recovers
  above a budget; an instance's `frameMs` crosses a high-water mark). Carries engine `fps`,
  `clockSource`, and the current `frameMs`/`slowSignals` top entries. Threshold-edge emission is
  what lets the agent find spikes without polling every frame.
- **FR-4 MCP `get_diagnostics` tool.** `get_diagnostics { since?, kinds?, instance?, level?,
  limit? }` → `{ events: [...], dropped, now: { frame, fps } }`. `since` is a `seq` cursor (the
  agent pages forward from its last read); `dropped` reports ring eviction since that cursor so
  the agent knows when it missed events. Default returns the recent tail.
- **FR-5 MCP perf rollup.** Either a `get_perf {}` tool or a `perf` block folded into
  `get_session` (see open questions): `{ fps, clockSource, frameBudgetMs, instances: [{ id,
  frameMs, slowSignals }], worstFrameMsRecent }`. This is the at-a-glance "is the engine
  healthy" read, distinct from the event timeline.
- **FR-6 Sidecar MCP-call latency.** Instrument `broker.request` (broker.ts:34) to record
  per-tool duration (mint-to-settle) and outcome (ok / error / timeout), extending
  `ToolMetrics` (metrics.ts) into a small latency table (count, p50/p95, last error per tool).
  Expose it via `get_diagnostics` (or a `scope: "sidecar"` argument) so the agent can see *its
  own* call cost and which tools are slow — the one telemetry layer the engine ring can't see.
- **FR-7 Resource counts (best-effort).** Fold `renderer.info` (three's WebGPU/WebGL render +
  memory counters: geometries, textures, draw calls) into the perf rollup if cheap to read.
  Marked best-effort because the WebGPU backend's `info` coverage should be verified (open
  question). This is the early-warning meter for texture/geometry leaks across rebuilds.

### Non-functional

- **NFR-1 Never block the render loop.** Hard constraint, inherited from "Never go black"
  (CLAUDE.md). Instrumentation on the hot path is append-to-array + integer compares only — no
  JSON serialization, no I/O, no allocation storms, no synchronous library calls. Serialization
  happens **only** when `get_diagnostics` is called (off the render tick, in the request
  handler). The buffer write must be wrapped so a bug in instrumentation can never throw into
  `renderFrame`/`tick`.
- **NFR-2 No cloud, no agent/collector in the hot path.** LOOM is a local-first live
  instrument. An OpenTelemetry SDK with a network exporter, or anything that batches-and-ships,
  is disqualified for the render loop. (An *optional* OTel/file exporter draining the ring out
  of band is acceptable future work — NFR-5.)
- **NFR-3 Bounded memory.** Fixed-size ring; old events evicted, not retained. No unbounded
  growth across a multi-hour set.
- **NFR-4 Determinism untouched.** Like the existing profiler (instance.ts:34-37), the buffer
  only *measures* — it never feeds values back into render, so fixture replays stay
  byte-identical. `?profile=0` semantics carry over; instrumentation should have its own off
  switch (`?diag=0`) for the same belt-and-suspenders reason.
- **NFR-5 The wire format is the contract.** Event/perf schemas live in
  `packages/sidecar/protocol.ts` (Zod, like everything else) so engine and sidecar share them
  and validators can assert on them. Keep `kind` an open string-union the buffer doesn't gate,
  so new event kinds don't require a protocol bump to *emit* (only to *type-narrow*).

## Surfaces

### MCP (agent)

- **`get_diagnostics { since?, kinds?, instance?, level?, limit? }`** — the event timeline.
  Tool description must teach the agent the loop: *act → `get_diagnostics { since: <lastSeq> }`
  → see what your action triggered → screenshot to confirm*. Pair it with `screenshot` the way
  the guide already pairs `get_session` + `screenshot`.
- **`get_perf {}`** (or a `perf` block on `get_session`) — the health rollup.
- Both are **read-only**, agent-allowed, source-tagged like every other tool
  (`engine-api.ts handleRequest`), and need no arming.

### Console / engine (human)

- No new UI in this request, but the buffer is explicitly the **data source for the in-UI perf
  view** described in [[console-performance-stability]] — the Console subscribes to the same
  ring (it already shares the engine page, unlike the sidecar) and renders a perf strip / event
  feed from it. One pipeline, two readers (agent via MCP, human via DOM). A `?diag=0` URL knob
  mirrors the existing `?profile=0`/`?hud=1` family.

## Library / service choice

**Recommendation: a small in-house structured ring buffer + the Web Performance API for
timing, with the protocol Zod schemas as the wire contract. No telemetry framework on the hot
path.** Rationale below; this is the only option that satisfies NFR-1/NFR-2 without compromise.

Concretely:
- **Timing**: keep using `performance.now()` (already pervasive). *Consider* `performance.mark`/
  `measure` for build/swap spans so they show up in Chrome's own profiler timeline for the
  human — but read marks via `PerformanceObserver` lazily, never on the render tick.
- **Storage/transport**: the ring buffer (FR-1) + the existing WS/MCP path. The buffer is
  ~100 lines; it owns no dependency and runs inside the performance browser.
- **Sidecar latency**: extend the existing `ToolMetrics` (metrics.ts) — it's already there and
  already the right home.

### Alternatives considered

- **OpenTelemetry (JS SDK).** The industry-standard structured-telemetry answer, and genuinely
  attractive for the *schema discipline* (spans/attributes) and the *future* (an out-of-band
  exporter to a local Jaeger/file for deep human debugging). **Rejected for the hot path**: the
  SDK + context propagation + exporter batching is weight and allocation LOOM cannot afford in
  `renderFrame`, and its value proposition (distributed tracing across services, cloud
  backends) is largely moot for a two-process local instrument. **Keep it as an optional drain**
  (NFR-5): the ring buffer can be shaped to emit OTel-compatible records that an opt-in exporter
  ships when a human is deep-debugging — out of band, never in the loop.
- **Pino / structured JSON logger.** Good for the *sidecar* (it's a Node process; Pino is fast
  and the `console.error`→stderr lines there would benefit from structure). **But it doesn't
  reach the agent** — the agent reads MCP results, not the sidecar's stderr. And in the browser
  (engine) a Node logger is the wrong tool. Pino could tidy the sidecar's own logging as a minor
  side-improvement, but it does not address the core ask. Not adopted as the primary mechanism.
- **Web Performance API alone (`mark`/`measure`/`PerformanceObserver`).** Zero-dependency and
  native, great for *human* profiling in DevTools. **But it's not agent-readable as a queryable
  feed** (the agent can't run `PerformanceObserver` over MCP), the entry buffer has its own size
  limits, and it models spans, not the leveled domain events (scene.rejected, panic) that
  dominate LOOM's diagnostics. Use it as a *complement* for build/swap spans, not the backbone.
- **Status quo (more `console.log`).** Free, and where the events already are — but
  fundamentally unreachable by the agent and history-less. The whole point is to make these
  reachable and queryable.

The ring buffer wins because the consumer is an agent on an MCP round-trip and the environment
forbids hot-path overhead: a bounded array of typed records, serialized only on demand, is the
minimal thing that is both agent-queryable and "Never go black"-safe.

## What to instrument (the event/metric catalog)

Grounded in the events LOOM already produces (so much of this is *re-routing*, not new
plumbing):

- **Build/swap/HMR** (the agent's most-needed causal events): `scene.swapped` (main.ts:574),
  `scene.rejected` (main.ts:298, session.ts:211), `instance.rebuilt`/`instance.rejected`
  (main.ts:612), `instance.removed` (main.ts:606), `inputs.redefined` (main.ts:589),
  `effects.reloaded` (main.ts:628). Tag with `instance` and `frame`.
- **Containment / errors**: `instance.frozen` (NFR-2, instance.ts:73), `loopguard.tripped`
  (`packages/runtime/src/loopguard.ts`), `scene.buildError` for panic health
  (panic-controller.ts:69). These are the "something broke but output is fine" signals the
  safety net produces — exactly what the agent should learn about without reading the console.
- **Frame timing**: sampled perf events + threshold crossings (FR-3) carrying `fps`,
  `clockSource`, and `frameMs`/`slowSignals` (reused from instance.ts). Surfaces the
  `raf`→`worker` clock fallback (hidden tab) as an event too.
- **Resources** (best-effort, FR-7): `renderer.info` geometry/texture/drawCall counts in the
  perf rollup — leak detection across rebuilds.
- **Audio/transport**: `audio.fallback` (main.ts:320), audio mode changes, BPM/tap — low
  priority, cheap to fold in.
- **Sidecar / MCP**: per-tool latency + outcome (FR-6), engine connect/disconnect
  (`index.ts`), WS reconnects (bridge.ts) — the agent-call layer the engine ring can't see.

### How an agent reads it (worked loop)

```
edit live.scene.ts  →  (save)                       # action
get_diagnostics { since: lastSeq }
  → events: [ { kind:"scene.rejected", frame:5101,
               level:"error", msg:"scene \"aurora\" rejected; keeping previous",
               data:{ error:"…" } } ]               # the agent now KNOWS the save failed
screenshot                                          # confirm the previous scene still runs
```
Without this, the same situation is: `get_session` shows `instanceError` is null (the *previous*
scene is fine) and the screenshot looks unchanged — the agent has no idea its edit was rejected.
The event log is what closes that blind spot.

## Implementation plan

### Phase 1 — the ring buffer + event re-routing (`packages/engine-app`)

1. `src/diagnostics.ts`: the bounded ring (`push(event)`, `since(seq)`, `tail(n)`), a `frame`
   stamper fed from the render service, and a `?diag=0` off switch. Append wrapped to never
   throw into the loop (NFR-1).
2. Replace/augment the high-value `[loom]` `console.*` call sites (FR-2) with `diag.push(...)`
   — start with the build/swap/HMR/freeze set in `main.ts`, `session.ts`, `instance.ts`(*),
   `panic-controller.ts`, `effects.ts`. (*runtime emits via a thin injected sink so the kernel
   keeps no engine dependency — mirror how profiling is a static toggle there.)
3. Sampled + threshold perf events (FR-3) emitted from the render-service tick, reading the fps
   meter and `Instance.frameMs`/`slowSignals` already computed there.

### Phase 2 — protocol + MCP surface (`packages/sidecar`)

1. `protocol.ts`: `DiagEvent`, `PerfSnapshot` Zod schemas; `GetDiagnosticsArgs`/`Result`,
   `GetPerfArgs`/`Result` (or a `perf` field on `SessionSnapshot`).
2. `engine-api.ts`: `get_diagnostics` / `get_perf` handlers reading the ring (serialize here,
   off the tick); add `RequestType` entries.
3. `index.ts`: two new MCP tools with JSON-Schema definitions matching house style; agent-allowed.

### Phase 3 — sidecar call latency (`packages/sidecar`)

1. Extend `metrics.ts` with a per-tool latency/outcome table; instrument `broker.request`
   (broker.ts:34) at mint and settle.
2. Surface it through `get_diagnostics { scope: "sidecar" }` (or fold into the result).

### Phase 4 — acceptance

- Extend an MCP e2e suite (the `validate:m2` family already drives real agent tools + latency):
  force a build rejection (save a throwing scene against a sandbox), assert a `scene.rejected`
  event appears via `get_diagnostics` with the right `frame`/`instance`, and assert the live
  pixels never changed (Never-go-black). Assert `dropped`/`since` paging works. Assert
  `get_perf` reports plausible `fps`/`frameMs` and that instrumentation overhead is negligible
  (frame budget unchanged with `?diag=1` vs `?diag=0`).

Estimated size: ring + re-routing ~150 lines; protocol/MCP ~100; sidecar latency ~60;
validation ~60.

## Edge cases & interactions

- **PANIC**: the buffer keeps recording during PANIC (the engine ticks; only output holds) — so
  the agent can read the event trail that *led to* a human PANIC. High value.
- **Ring eviction during a long quiet period**: `dropped` + `since` cursor make missed events
  explicit rather than silent.
- **`?profile=0`**: `slowSignals` is empty (instance.ts), so perf events should degrade
  gracefully to `frameMs`-only. Document it.
- **Sidecar restart**: `ToolMetrics`/latency table is in-memory and resets — fine; it's
  per-session telemetry, not durable history.
- **Two readers**: the agent (MCP, serialized snapshot) and the future Console perf view (DOM,
  same in-page ring). The ring is the shared truth; neither reader mutates it.

## Open questions

- **`get_perf` as a tool vs. a `perf` block on `get_session`.** Folding into `get_session` saves
  a round-trip and matches how `fps`/`frameMs` already ride there; a separate tool keeps the
  snapshot lean and lets perf be polled at a different cadence. Leaning toward a `perf` block for
  the rollup + a separate `get_diagnostics` for the timeline (different shapes, different cadences).
- **`renderer.info` under the WebGPU backend** (FR-7): how complete are the counters on three's
  WebGPU renderer vs. WebGL? Unverified — gate FR-7 on a quick spike.
- **Ring size & perf-event cadence**: 512 entries / every-60-frames are guesses; tune against a
  real multi-instance set so a busy moment doesn't evict the event that explains it.
- **Should the runtime kernel emit directly?** It currently keeps no engine dependency
  (profiling is a static toggle). An injected event sink preserves that; confirm it's worth the
  indirection vs. having the engine wrap the throw sites it already catches.
- **Optional OTel/file drain** (NFR-5): worth shaping events to be OTel-compatible *now* so a
  later opt-in human-debug exporter is free, or defer entirely? Lean: keep the event shape
  exporter-friendly, build no exporter yet.
- **Sidecar logging cleanup**: adopt Pino for the sidecar's own stderr while we're here, or
  leave the `[loom-sidecar]` `console.error` lines (index.ts:32) as-is? Out of scope for the
  agent-facing goal; note it as a possible side-tidy.

## Related

- [[console-performance-stability]] — the in-UI perf diagnostics and the "Aw, snap" stability
  hunt should consume **this** ring buffer as their data source (one pipeline, two readers); the
  perf-event/threshold work here is exactly the signal that effort needs.
- [[validator-test-consolidation]] — validators already poll `window.__loom`; a structured event
  log gives them cleaner assertions (assert an event happened, not scrape a console string).
- [[docs-skills-audit]] — the agent guide (`.claude/CLAUDE.md`) should grow a "read the
  diagnostics after you act" loop alongside the existing `get_session` + `screenshot` guidance.
