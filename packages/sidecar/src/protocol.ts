import { z } from "zod";

/**
 * The WS wire contract between sidecar and engine. The sidecar sends `req`
 * envelopes; the engine answers each with exactly one `res` envelope carrying
 * the same id. Shared by both sides (the engine imports this file through the
 * `@loom/sidecar/protocol` alias), so keep it free of Node and DOM APIs.
 */

export const DEFAULT_WS_PORT = 7341;

/**
 * The sidecar↔engine wire-protocol generation (NFR-1, mirrors module-packs'
 * `loomApi` hint). The standalone plugin sidecar and the user's engine are
 * shipped separately, so a mismatch is possible; both sides advertise this
 * value on connect (the optional `hello` envelope below) and the sidecar logs
 * a loud warning when they disagree, so a version skew fails loudly rather than
 * weirdly. Bump it whenever the request/response wire contract changes
 * incompatibly. In-repo dev shares this source, so dev never mismatches.
 */
export const PROTOCOL_VERSION = "1";

/**
 * Optional, unsolicited handshake either side may send on connect to advertise
 * its {@link PROTOCOL_VERSION}. It is NOT a request/response pair — a peer that
 * predates it simply can't parse it and drops it (the engine's `respond` and
 * the sidecar's broker both ignore anything that isn't a known envelope), so
 * adding it is fully backward-compatible.
 */
export const HelloMsg = z.object({
  kind: z.literal("hello"),
  /** "engine" or "sidecar" — who is announcing itself. */
  role: z.enum(["engine", "sidecar"]),
  /** The sender's PROTOCOL_VERSION. */
  protocol: z.string().min(1),
});
export type HelloMsg = z.infer<typeof HelloMsg>;

/**
 * The full engine command vocabulary. The MCP sidecar exposes the agent
 * subset; panic/resume/set_transport/arm_agent_commit are human-only and
 * reachable only from the Console (BroadcastChannel uses these same
 * envelopes — one dispatch in the engine serves both).
 */
export const RequestType = z.enum([
  "get_session",
  "get_manifest",
  "set_param",
  "set_params",
  "set_param_range",
  "modulate_param",
  "clear_modulation",
  "set_modulation_enabled",
  "set_color_space",
  "set_chain",
  "save_chain",
  "preview_effect",
  "screenshot",
  "screenshot_console",
  "create_instance",
  "destroy_instance",
  "rename_instance",
  "stage",
  "unstage",
  "commit",
  "live_step",
  "panic",
  "resume",
  "arm_panic_mode",
  "set_panic_instance",
  "set_transport",
  "set_audio",
  "set_preview",
  "arm_agent_commit",
  "midi_learn",
  "midi_unbind",
  "list_projects",
  "save_project",
  "load_project",
  "record_fixture",
  "get_diagnostics",
  "batch",
]);
export type RequestType = z.infer<typeof RequestType>;

export const RequestMsg = z.object({
  id: z.string().min(1),
  kind: z.literal("req"),
  type: RequestType,
  args: z.record(z.string(), z.unknown()).default({}),
});
export type RequestMsg = z.infer<typeof RequestMsg>;

export const ResponseMsg = z.discriminatedUnion("ok", [
  z.object({ id: z.string().min(1), kind: z.literal("res"), ok: z.literal(true), result: z.unknown() }),
  z.object({ id: z.string().min(1), kind: z.literal("res"), ok: z.literal(false), error: z.string().min(1) }),
]);
export type ResponseMsg = z.infer<typeof ResponseMsg>;

// ---- per-request args (validated engine-side; M2 has a single "live" instance) ----

export const InstanceArgs = z.object({ instance: z.string().default("live") });
export type InstanceArgs = z.infer<typeof InstanceArgs>;

export const SetParamArgs = z.object({
  instance: z.string().default("live"),
  path: z.string().min(1),
  value: z.union([z.number(), z.boolean(), z.string()]),
});
export type SetParamArgs = z.infer<typeof SetParamArgs>;

/**
 * Set many params on ONE instance in a single round-trip (the batched form of
 * set_param). `values` is a path→value map applied in one engine handler call,
 * so every knob lands on the same frame (no tearing). Partial success: a bad
 * path is collected in the result's `errors[]` without dropping the others.
 */
export const SetParamsArgs = z
  .object({
    instance: z.string().default("live"),
    values: z.record(z.string(), z.union([z.number(), z.boolean(), z.string()])),
  })
  .refine((a) => Object.keys(a.values).length > 0, {
    message: "set_params needs at least one path in `values`",
  });
export type SetParamsArgs = z.infer<typeof SetParamsArgs>;

export const SetParamsResult = z.object({
  instance: z.string(),
  /** Paths that applied, with their clamped values. */
  set: z.array(z.object({ path: z.string(), value: z.union([z.number(), z.boolean(), z.string()]) })),
  /** Paths that failed (unknown/modulated/out-of-domain), each with its reason. */
  errors: z.array(z.object({ path: z.string(), error: z.string() })),
});
export type SetParamsResult = z.infer<typeof SetParamsResult>;

/**
 * Widen/narrow a float|int param's slider bounds live (Console power-tool —
 * the declared range is the author's default, this overrides it). `min`/`max`
 * are individually optional (the engine fills a missing side from the current
 * effective range); `restoreDefault` snaps back to the declared range.
 */
export const SetParamRangeArgs = z
  .object({
    instance: z.string().default("live"),
    path: z.string().min(1),
    min: z.number().optional(),
    max: z.number().optional(),
    restoreDefault: z.boolean().optional(),
  })
  .refine((a) => a.restoreDefault === true || a.min !== undefined || a.max !== undefined, {
    message: "set_param_range needs min and/or max (or restoreDefault: true)",
  });
export type SetParamRangeArgs = z.infer<typeof SetParamRangeArgs>;

export const ModulateParamArgs = z.object({
  instance: z.string().default("live"),
  path: z.string().min(1),
  /** Spec JSON — validated engine-side against @loom/runtime's ModulatorSpec (FR-11). */
  modulator: z.record(z.string(), z.unknown()),
});
export type ModulateParamArgs = z.infer<typeof ModulateParamArgs>;

export const ClearModulationArgs = z.object({
  instance: z.string().default("live"),
  path: z.string().min(1),
});
export type ClearModulationArgs = z.infer<typeof ClearModulationArgs>;

/** Pause/resume a param's modulator without detaching it (the param holds). */
export const SetModulationEnabledArgs = z.object({
  instance: z.string().default("live"),
  path: z.string().min(1),
  enabled: z.boolean(),
});
export type SetModulationEnabledArgs = z.infer<typeof SetModulationEnabledArgs>;

/**
 * Decompose a color param into H/S/V or R/G/B channel sliders (each then
 * modulatable + MIDI-bindable), or collapse it back to a plain picker ("hex").
 * Works on instance color params and the "globals" palette stops (R7.4).
 */
export const SetColorSpaceArgs = z.object({
  instance: z.string().default("live"),
  path: z.string().min(1),
  space: z.enum(["hex", "hsv", "rgb"]),
});
export type SetColorSpaceArgs = z.infer<typeof SetColorSpaceArgs>;

export const CreateInstanceArgs = z.object({
  scene: z.string().min(1),
  id: z.string().min(1).optional(),
  /** "fixture:<name>" replays a recorded input trace instead of the live rack. */
  inputs: z
    .string()
    .regex(/^fixture:[a-z0-9][a-z0-9_-]*$/i, 'inputs must be "fixture:<name>"')
    .optional(),
});
export type CreateInstanceArgs = z.infer<typeof CreateInstanceArgs>;

/** Screenshot args: `frames` (fixture instances only) renders a deterministic
 * offline pass — same fixture + frame list always returns identical pixels. */
export const ScreenshotArgs = z.object({
  instance: z.string().default("live"),
  frames: z.array(z.number().int().min(0).max(36_000)).min(1).max(16).optional(),
});
export type ScreenshotArgs = z.infer<typeof ScreenshotArgs>;

/** Record the live input rack for N frames into content/state/fixtures/<name>.json. */
export const RecordFixtureArgs = z.object({
  name: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9][a-z0-9_-]*$/i, "letters, digits, - and _ (must start alphanumeric)"),
  frames: z.number().int().min(1).max(3600),
});
export type RecordFixtureArgs = z.infer<typeof RecordFixtureArgs>;

export const RecordFixtureResult = z.object({
  saved: z.string(),
  path: z.string(),
  frames: z.number().int(),
  channels: z.array(z.string()),
  bpm: z.number(),
});
export type RecordFixtureResult = z.infer<typeof RecordFixtureResult>;

/** One deterministic frame capture from a fixture replay. */
export const FixtureShot = z.object({
  frame: z.number().int(),
  mime: z.literal("image/png"),
  base64: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type FixtureShot = z.infer<typeof FixtureShot>;

export const ScreenshotFramesResult = z.object({
  fixture: z.string(),
  frames: z.array(FixtureShot),
});
export type ScreenshotFramesResult = z.infer<typeof ScreenshotFramesResult>;

export const RenameInstanceArgs = z.object({
  instance: z.string().default("live"),
  to: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9][a-z0-9_-]*$/i, "letters, digits, - and _ (must start alphanumeric)"),
});
export type RenameInstanceArgs = z.infer<typeof RenameInstanceArgs>;

/**
 * Where a chain step's extra input slot reads its TexNode from (multi-input
 * chain steps). Exactly one key is set — mirrors runtime `SourceRef`:
 *  - `{ instance }` — another live tile's output, sampled as a texture.
 *  - `{ step }` — an EARLIER step's folded output (linear chain → small DAG;
 *    a cycle/ordering guard rejects self/forward refs).
 *  - `{ asset }` — **DEFERRED, not yet wired (needs the M10 asset explorer).**
 *    Carried in the schema now for forward-compat; the fold rejects it until
 *    M10 lands, so an asset source never half-builds.
 */
export const SourceRefSchema = z.union([
  z.object({ instance: z.string().min(1) }).strict(),
  z.object({ step: z.string().min(1) }).strict(),
  z.object({ asset: z.string().min(1) }).strict(),
]);
export type SourceRefSchema = z.infer<typeof SourceRefSchema>;

/** One desired chain step. `id` is omitted for a new step, kept for a surviving one. */
export const ChainStepInputSchema = z.object({
  id: z.string().min(1).optional(),
  effect: z.string().min(1),
  /** Initial knob values (sub-paths under fx.<id>); omitted = carry forward / defaults. */
  params: z.record(z.string(), z.union([z.number(), z.boolean()])).optional(),
  /** Wet/dry 0..1; omitted = carry forward or 1. */
  mix: z.number().min(0).max(1).optional(),
  /**
   * Extra input-slot bindings (multi-input chain steps): slot name → SourceRef.
   * Additive/optional — a classic single-input step omits it (existing chains
   * unchanged). Each slot the effect declares in `chainInputs` must be bound.
   */
  inputs: z.record(z.string(), SourceRefSchema).optional(),
});
export type ChainStepInputSchema = z.infer<typeof ChainStepInputSchema>;

/**
 * Full-list chain edit (M6): the whole desired step list, so attach/detach/
 * reorder/insert are one idempotent verb. `restoreDefault` resets to the scene's
 * declared chain (ignores `steps`). Agent edits to the LIVE chain need arming.
 */
export const SetChainArgs = z
  .object({
    instance: z.string().default("live"),
    /** Target a named layer node's chain (Layers); omitted = the root chain. */
    node: z.string().min(1).optional(),
    steps: z.array(ChainStepInputSchema).optional(),
    restoreDefault: z.boolean().optional(),
  })
  .refine((a) => a.restoreDefault === true || a.steps != null, {
    message: "set_chain needs steps[] (or restoreDefault: true)",
  });
export type SetChainArgs = z.infer<typeof SetChainArgs>;

/**
 * Render a candidate effect over an instance's current output for the picker
 * grid (Console-only — not an MCP tool). Returns a JPEG data URL.
 */
export const PreviewEffectArgs = z.object({
  instance: z.string().default("live"),
  effect: z.string().min(1),
});
export type PreviewEffectArgs = z.infer<typeof PreviewEffectArgs>;

/** Save the instance's current chain as a reusable composite effect (data file). */
export const SaveChainArgs = z.object({
  instance: z.string().default("live"),
  name: z
    .string()
    .regex(/^[a-z][a-zA-Z0-9]*$/, "saved-chain names are lowerCamelCase identifiers"),
  description: z.string().optional(),
});
export type SaveChainArgs = z.infer<typeof SaveChainArgs>;

export const CommitArgs = z.object({
  durationFrames: z.number().int().min(0).max(600).default(60),
});
export type CommitArgs = z.infer<typeof CommitArgs>;

export const ArmAgentCommitArgs = z.object({ armed: z.boolean() });
export type ArmAgentCommitArgs = z.infer<typeof ArmAgentCommitArgs>;

/** Step LIVE to the next (+1) or previous (-1) healthy tile in the deck ring. */
export const LiveStepArgs = z.object({ dir: z.union([z.literal(1), z.literal(-1)]) });
export type LiveStepArgs = z.infer<typeof LiveStepArgs>;

/** PANIC behavior: hold the last frame, or cut to the designated safe scene. */
export const PanicMode = z.enum(["hold", "scene"]);
export type PanicMode = z.infer<typeof PanicMode>;

/** PANIC executes the armed mode unless an explicit override is supplied. */
export const PanicArgs = z.object({ mode: PanicMode.optional() });
export type PanicArgs = z.infer<typeof PanicArgs>;

export const ArmPanicModeArgs = z.object({ mode: PanicMode });
export type ArmPanicModeArgs = z.infer<typeof ArmPanicModeArgs>;

/** Designate which existing instance the SAFE SCENE panic cuts to (Console). */
export const SetPanicInstanceArgs = z.object({ instance: z.string().min(1) });
export type SetPanicInstanceArgs = z.infer<typeof SetPanicInstanceArgs>;

/**
 * Projects — set lists (serialized instance sets in content/state/projects/).
 * Saving captures the current set; agent saves are arming-gated like commit.
 * Loading builds every project instance into sandboxes and NEVER touches LIVE.
 */
export const SaveProjectArgs = z.object({
  name: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9][a-z0-9_-]*$/i, "letters, digits, - and _ (must start alphanumeric)"),
  /** Console-supplied tile order; omitted = engine (creation) order. */
  tileOrder: z.array(z.string()).optional(),
});
export type SaveProjectArgs = z.infer<typeof SaveProjectArgs>;

export const LoadProjectArgs = z.object({ name: z.string().min(1) });
export type LoadProjectArgs = z.infer<typeof LoadProjectArgs>;

/**
 * Batch — run several engine commands in one round-trip. Each call names a tool
 * and its args (validated per-type when it runs); they execute serially in the
 * given order inside a single engine dispatch. Per-call gates (human-only verbs,
 * live-commit arming) still apply, and `batch` may not nest. `stopOnError` aborts
 * the remainder on the first failure; otherwise every call runs and each carries
 * its own ok/result | ok/error. Mode is serial-only for now (renderer-bound ops
 * — screenshot/create_instance — can't safely run concurrently).
 */
export const BatchCall = z.object({
  tool: RequestType,
  args: z.record(z.string(), z.unknown()).default({}),
});
export type BatchCall = z.infer<typeof BatchCall>;

export const BatchArgs = z.object({
  mode: z.enum(["serial"]).default("serial"),
  stopOnError: z.boolean().default(false),
  calls: z.array(BatchCall).min(1).max(64),
});
export type BatchArgs = z.infer<typeof BatchArgs>;

export const BatchCallResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), tool: z.string(), result: z.unknown() }),
  z.object({ ok: z.literal(false), tool: z.string(), error: z.string() }),
]);
export type BatchCallResult = z.infer<typeof BatchCallResult>;

export const BatchResult = z.object({
  mode: z.enum(["serial"]),
  /** One entry per call, in request order. */
  results: z.array(BatchCallResult),
});
export type BatchResult = z.infer<typeof BatchResult>;

export const SaveProjectResult = z.object({
  saved: z.string(),
  /** Repo-relative path of the written project file. */
  path: z.string(),
  instances: z.number().int(),
});
export type SaveProjectResult = z.infer<typeof SaveProjectResult>;

export const LoadProjectResult = z.object({
  loaded: z.string(),
  /** Created instance ids, in project tile order. */
  created: z.array(z.string()),
  skipped: z.array(z.object({ id: z.string(), scene: z.string(), reason: z.string() })),
  /** LIVE is untouched by a load — always reported so agents see it held. */
  live: z.string().nullable(),
});
export type LoadProjectResult = z.infer<typeof LoadProjectResult>;

export const ListProjectsResult = z.object({ projects: z.array(z.string()) });
export type ListProjectsResult = z.infer<typeof ListProjectsResult>;

export const TransportArgs = z.object({
  bpm: z.number().positive().optional(),
  tap: z.boolean().optional(),
});
export type TransportArgs = z.infer<typeof TransportArgs>;

export const SetAudioArgs = z.object({
  mode: z.enum(["mic", "test"]),
  deviceId: z.string().optional(),
});
export type SetAudioArgs = z.infer<typeof SetAudioArgs>;

/**
 * Human-only: drive the Console's full-resolution preview stream (the
 * full-screen preview overlay). `instance` null stops it. `maxHeight` is the
 * user-chosen ceiling (e.g. 1080/720/540/360); the engine streams that instance
 * at min(ceiling, adaptive cap) — it auto-reduces when the live fps dips and
 * climbs back toward the ceiling once it's safe.
 */
export const SetPreviewArgs = z.object({
  instance: z.string().nullable(),
  maxHeight: z.number().int().positive().default(1080),
});
export type SetPreviewArgs = z.infer<typeof SetPreviewArgs>;


export const BindingModeZ = z.enum(["absolute", "set", "cycle"]);
export type BindingModeZ = z.infer<typeof BindingModeZ>;

/**
 * MIDI-learn target: a param path on an instance (resolved to its scene
 * engine-side — bindings are durable across instance churn), on "globals",
 * or on the "actions" pseudo-instance (live.next / live.prev). mode/value
 * choose the binding semantics; omitted = absolute.
 */
export const MidiTargetArgs = z.object({
  instance: z.string().default("live"),
  path: z.string().min(1),
  mode: BindingModeZ.optional(),
  value: z.number().optional(),
});
export type MidiTargetArgs = z.infer<typeof MidiTargetArgs>;

// ---- results (produced by the engine, consumed by MCP clients) ----

export const InstanceStatus = z.enum(["ok", "frozen", "rejected"]);
export type InstanceStatus = z.infer<typeof InstanceStatus>;

export const AudioDevice = z.object({ id: z.string(), label: z.string() });
export type AudioDevice = z.infer<typeof AudioDevice>;

/** A persisted MIDI binding (shape mirrors @loom/runtime's BindingSchema). */
export const MidiBinding = z.object({
  cc: z.number(),
  ch: z.number().nullable(),
  scene: z.string(),
  path: z.string(),
  mode: BindingModeZ.default("absolute"),
  value: z.number().optional(),
});
export type MidiBinding = z.infer<typeof MidiBinding>;

/** One raw incoming MIDI message (mirrors @loom/runtime's MidiMessageLog). */
export const MidiMessageLog = z.object({
  kind: z.string(),
  ch: z.number().nullable(),
  data: z.array(z.number()),
});
export type MidiMessageLog = z.infer<typeof MidiMessageLog>;

export const MidiStatus = z.object({
  /** "off" = no WebMIDI access yet (Chrome gates it behind a permission). */
  status: z.enum(["off", "ready"]),
  devices: z.array(z.string()),
  /** Armed MIDI-learn target, or null. */
  learning: z
    .object({
      scene: z.string(),
      path: z.string(),
      mode: BindingModeZ.optional(),
      value: z.number().optional(),
    })
    .nullable(),
  /**
   * Raw-message monitor (newest last), including non-CC traffic the engine
   * ignores — the eyes for "this control does nothing" (default [] so an
   * older engine snapshot still parses).
   */
  recent: z.array(MidiMessageLog).default([]),
});
export type MidiStatus = z.infer<typeof MidiStatus>;

export const ModulatorSummary = z.object({
  path: z.string(),
  type: z.string(),
  /** Non-null = detached: eval threw or the param vanished on rebuild. */
  error: z.string().nullable(),
  /** False = paused (attached but not writing; the param is hand-drivable). */
  enabled: z.boolean().default(true),
});
export type ModulatorSummary = z.infer<typeof ModulatorSummary>;

/** One folded chain step, for `get_session`. Knob values come from `get_manifest`. */
export const ChainStepInfo = z.object({
  id: z.string(),
  effect: z.string(),
  kind: z.enum(["primitive", "composite"]),
  /** Current wet/dry mix 0..1. */
  mix: z.number(),
  /** The step's on/off toggle (`fx.<id>.enabled`) — off fades to bypass. */
  enabled: z.boolean().default(true),
  /** Bound extra input slots (multi-input chain steps); omitted for single-input. */
  inputs: z.record(z.string(), SourceRefSchema).optional(),
});
export type ChainStepInfo = z.infer<typeof ChainStepInfo>;

/**
 * A named layer node registered by ctx.layer() (Layers): its rig params live at
 * `<id>.layer.*`, its chain's at `<id>.fx.<stepId>.*`. `parent` is the closest
 * enclosing node (null = feeds the root). The root chain is just the root node's.
 */
export const LayerNode = z.object({
  id: z.string(),
  parent: z.string().nullable(),
  /** The node's FX chain steps in order (empty when never chained). */
  chain: z.array(ChainStepInfo),
});
export type LayerNode = z.infer<typeof LayerNode>;

export const InstanceInfo = z.object({
  id: z.string(),
  scene: z.string(),
  status: InstanceStatus,
  error: z.string().nullable(),
  paramPaths: z.array(z.string()),
  modulators: z.array(ModulatorSummary),
  /** Post-effect chain steps in order (M6). */
  chain: z.array(ChainStepInfo),
  /** Named layer nodes in wrap order (Layers); [] when the scene wraps none. */
  nodes: z.array(LayerNode).default([]),
  /** The input-trace name this instance replays, or null for the live rack (Fixtures). */
  fixture: z.string().nullable().default(null),
  /** Smoothed per-frame render cost in ms (M7 frame-time HUD). */
  frameMs: z.number().default(0),
  /**
   * Costliest CPU signals this instance pulls, by smoothed ms (descending) —
   * per-signal attribution of frameMs. Labelled by param path / "palette" /
   * "input.<name>" (else "uniform#<i>"). Empty when profiling is off.
   */
  slowSignals: z
    .array(z.object({ label: z.string(), ms: z.number() }))
    .default([]),
  /** Successful builds (1 on create, ++ per rebuild) — validators assert "no rebuild". */
  builds: z.number().int(),
  /** Pinned role, if any: "panic" = the designated SAFE target for scene-panic. */
  pinned: z.literal("panic").nullable().default(null),
});
export type InstanceInfo = z.infer<typeof InstanceInfo>;

/** A chainable effect offered by the library (code primitive or saved composite). */
export const EffectInfo = z.object({
  name: z.string(),
  kind: z.enum(["primitive", "composite"]),
  description: z.string().optional(),
  /**
   * Extra input slots beyond the piped `input` (multi-input chain steps); the
   * Console grows a source-picker row per slot. Absent/[] = classic single-input.
   */
  chainInputs: z
    .array(z.object({ name: z.string(), kind: z.literal("tex"), description: z.string().optional() }))
    .optional(),
});
export type EffectInfo = z.infer<typeof EffectInfo>;

/**
 * One frame of the Console's full-res preview stream (broadcast separately from
 * the session snapshot, like thumbnails). Carries the live res + whether the
 * engine auto-reduced below the chosen ceiling so the overlay can show it.
 */
export const PreviewFrame = z.object({
  instance: z.string(),
  /** JPEG data URL at this instance's current preview resolution. */
  image: z.string(),
  width: z.number(),
  height: z.number(),
  /** Streamed height (after any auto-reduction) and the user-chosen ceiling. */
  actualHeight: z.number(),
  ceilingHeight: z.number(),
  /** True when fps forced a reduction below the ceiling. */
  reduced: z.boolean(),
});
export type PreviewFrame = z.infer<typeof PreviewFrame>;

/**
 * Health of the designated SAFE target (scene-panic).
 *
 * Scene-panic is **opt-in**: at boot nothing is designated, so the resting state
 * is `"none"` — distinct from `"error"` (chosen but broken). The Console reads
 * `"none"` as "pick a SAFE target" and `"error"` as the scary ⚠; an agent reads
 * either as "scene-panic can't fire → PANIC will hold."
 */
export const PanicSceneInfo = z.object({
  /** The designated instance's scene name; "" when nothing is designated. */
  name: z.string(),
  /**
   * "none"  = no SAFE target designated (scene-panic unavailable → PANIC holds);
   * "ok"    = a healthy designated instance exists (scene-panic available);
   * "error" = a designated instance that has errored (PANIC holds).
   */
  status: z.enum(["none", "ok", "error"]),
  /** Last build error for an errored target, else null. */
  error: z.string().nullable(),
});
export type PanicSceneInfo = z.infer<typeof PanicSceneInfo>;

/**
 * The at-a-glance "is the engine healthy" rollup (FR-5). Folded onto
 * `get_session` (the `perf` block) AND returned standalone by `get_diagnostics`
 * — distinct from the event timeline. `renderer` resource counts are best-effort
 * (FR-7; absent when the backend doesn't expose them cheaply).
 */
export const PerfSnapshot = z.object({
  fps: z.number(),
  /** Which clock drove the last frame: "raf" (visible) or "worker" (hidden tab). */
  clockSource: z.enum(["raf", "worker"]),
  /** The frame-time budget in ms (1000/60 ≈ 16.7) the threshold events fire against. */
  frameBudgetMs: z.number(),
  frame: z.number().int(),
  /** Per-instance frame cost + costliest signals (reused from get_session). */
  instances: z.array(
    z.object({
      id: z.string(),
      frameMs: z.number(),
      slowSignals: z.array(z.object({ label: z.string(), ms: z.number() })),
    }),
  ),
  /** The worst single-instance frameMs seen across the recent sampling window. */
  worstFrameMsRecent: z.number(),
  /**
   * Wall-time (ms) of the most recent OFF-LOOP thumbnail readback pass — the
   * Console back-pressure meter (PerfOverlay / FR-6). 0 until a pass has run.
   */
  thumbPassMs: z.number().optional(),
  /**
   * three's renderer.info counters (geometries/textures/draw calls), best-effort
   * (FR-7) — the early-warning meter for texture/geometry leaks across rebuilds.
   * Absent when the active backend doesn't expose them.
   */
  renderer: z
    .object({
      geometries: z.number().int(),
      textures: z.number().int(),
      drawCalls: z.number().int(),
    })
    .optional(),
});
export type PerfSnapshot = z.infer<typeof PerfSnapshot>;

export const SessionSnapshot = z.object({
  // Live-instance views (kept flat for M2 compatibility and quick reads).
  scene: z.string().nullable(),
  instance: z.string().nullable(),
  instanceError: z.string().nullable(),
  paramPaths: z.array(z.string()),
  // Stage (M3)
  instances: z.array(InstanceInfo),
  live: z.string().nullable(),
  staged: z.string().nullable(),
  /** Crossfade progress 0..1, or null when not fading. */
  mix: z.number().nullable(),
  panicked: z.boolean(),
  /** Armed PANIC behavior the button will execute (human-set, Console). */
  panicMode: PanicMode,
  /** Active PANIC mode, or null when not panicked. */
  panicActive: PanicMode.nullable(),
  /** The designated Panic Scene's name + build health. */
  panicScene: PanicSceneInfo,
  agentCommitArmed: z.boolean(),
  availableScenes: z.array(z.string()),
  /** Chainable effects for the "+ effect" picker and `set_chain` (M6). */
  availableEffects: z.array(EffectInfo),
  /** Saved project names (Projects switcher) — engine-cached, refreshed on list/save/load. */
  projects: z.array(z.string()).default([]),
  // World
  audioMode: z.string(),
  audioDevices: z.array(AudioDevice),
  /** Input-rack channel values (live meters), tuned via instance "globals". */
  inputs: z.record(z.string(), z.number()),
  midi: MidiStatus,
  bindings: z.array(MidiBinding),
  bpm: z.number(),
  rms: z.number(),
  onsetCount: z.number(),
  fps: z.number(),
  frame: z.number(),
  /**
   * Engine-health rollup (app-instrumentation FR-5): fps/clockSource/frameBudget,
   * per-instance frameMs+slowSignals, worst recent frame, best-effort renderer
   * counts. The at-a-glance perf read; the event TIMELINE is `get_diagnostics`.
   * `.optional()` so an older engine snapshot (pre-instrumentation) still parses.
   */
  perf: PerfSnapshot.optional(),
});
export type SessionSnapshot = z.infer<typeof SessionSnapshot>;

export const CreateInstanceResult = z.object({
  instance: z.string(),
  scene: z.string(),
  paramPaths: z.array(z.string()),
});
export type CreateInstanceResult = z.infer<typeof CreateInstanceResult>;

export const ParamDescriptor = z.looseObject({
  type: z.enum(["float", "int", "bool", "color"]),
  value: z.union([z.number(), z.boolean(), z.string()]),
  default: z.union([z.number(), z.boolean(), z.string()]),
  /** Value names for int selectors (palette.source) — UI renders a toggle. */
  labels: z.array(z.string()).optional(),
  /** Hidden from the default params box (e.g. the auto-added input trim); still
   *  fully live (set_param, MIDI, modulators). The Console's advanced toggle reveals it. */
  hidden: z.boolean().optional(),
  /** Active modulator config, or null when the param is hand-driven (FR-8). */
  modulator: z.record(z.string(), z.unknown()).nullable().optional(),
  /** Author-declared [min, max] — present only when the live range was widened/narrowed. */
  defaultRange: z.tuple([z.number(), z.number()]).optional(),
});
export const ManifestResult = z.object({
  instance: z.string(),
  params: z.record(z.string(), ParamDescriptor),
  /** Layer nodes (Layers) — instances only; absent on "globals". */
  nodes: z.array(LayerNode).optional(),
});
export type ManifestResult = z.infer<typeof ManifestResult>;

export const SetParamResult = z.object({
  instance: z.string(),
  path: z.string(),
  value: z.union([z.number(), z.boolean(), z.string()]),
});
export type SetParamResult = z.infer<typeof SetParamResult>;

export const SetParamRangeResult = z.object({
  instance: z.string(),
  path: z.string(),
  /** Effective range after the edit. */
  min: z.number(),
  max: z.number(),
  /** Current value, re-clamped into the new bounds. */
  value: z.number(),
});
export type SetParamRangeResult = z.infer<typeof SetParamRangeResult>;

export const ModulateParamResult = z.object({
  instance: z.string(),
  path: z.string(),
  modulator: z.record(z.string(), z.unknown()),
});
export type ModulateParamResult = z.infer<typeof ModulateParamResult>;

export const ClearModulationResult = z.object({
  instance: z.string(),
  path: z.string(),
  cleared: z.boolean(),
});
export type ClearModulationResult = z.infer<typeof ClearModulationResult>;

export const SetModulationEnabledResult = z.object({
  instance: z.string(),
  path: z.string(),
  enabled: z.boolean(),
});
export type SetModulationEnabledResult = z.infer<typeof SetModulationEnabledResult>;

export const SetChainResult = z.object({
  instance: z.string(),
  /** The edited node's id, or null for the root chain. */
  node: z.string().nullable().default(null),
  chain: z.array(ChainStepInfo),
});
export type SetChainResult = z.infer<typeof SetChainResult>;

export const SaveChainResult = z.object({
  saved: z.string(),
  /** Repo-relative path of the written composite. */
  path: z.string(),
  steps: z.number().int(),
});
export type SaveChainResult = z.infer<typeof SaveChainResult>;

export const ScreenshotResult = z.object({
  mime: z.literal("image/png"),
  base64: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  frame: z.number(),
  /** Engine render rate at capture time — agents self-police perf (M7). */
  fps: z.number().default(0),
});
export type ScreenshotResult = z.infer<typeof ScreenshotResult>;

/**
 * `screenshot_console` args — capture the human's Console COCKPIT UI (tiles,
 * badges, param panels, status bar), not instance pixels. No instance arg: it
 * captures the page. `maxWidth` caps the PNG width (default 1280; the height
 * scales to preserve aspect) to keep responses snappy; `maxWidth: 0` = native
 * device-pixel resolution (NFR-3).
 */
export const ScreenshotConsoleArgs = z.object({
  maxWidth: z.number().int().min(0).max(7680).optional(),
});
export type ScreenshotConsoleArgs = z.infer<typeof ScreenshotConsoleArgs>;

/**
 * `screenshot_console` result. Same image shape as `ScreenshotResult` but with
 * `consoleId` (which Console answered — most-recent-hello targeting, FR-3) and
 * no engine `frame`/`fps`: this is a DOM re-render in the Console page, not a
 * read of the Output render loop. Fidelity is APPROXIMATE (FR-6).
 */
export const ScreenshotConsoleResult = z.object({
  mime: z.literal("image/png"),
  base64: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** The Console that produced this capture (stable across repeat calls). */
  consoleId: z.string(),
});
export type ScreenshotConsoleResult = z.infer<typeof ScreenshotConsoleResult>;

// ---- Diagnostics (app-instrumentation): the structured, queryable event log ----

/** Severity of a diagnostics event. */
export const DiagLevel = z.enum(["info", "warn", "error"]);
export type DiagLevel = z.infer<typeof DiagLevel>;

/**
 * One structured diagnostics event from the engine's in-process ring
 * (packages/engine-app/src/diagnostics.ts). The agent pages forward with the
 * `seq` cursor and correlates cause→effect on `frame`.
 *
 * `kind` is an OPEN string (not an enum) on purpose (NFR-5): the engine emits
 * new dotted domain kinds — `scene.swapped`, `scene.rejected`, `instance.rebuilt`,
 * `instance.frozen`, `loopguard.tripped`, `perf.sample`, `perf.fps.low`,
 * `sidecar.tool`, … — without a protocol bump. Validators type-narrow on the
 * specific kinds they assert.
 */
export const DiagEvent = z.object({
  /** Monotonic sequence number — the agent's `since` cursor. */
  seq: z.number().int(),
  /** Engine frame at emit time (the causal anchor). */
  frame: z.number().int(),
  /** performance.now() ms at emit time. */
  t: z.number(),
  level: DiagLevel,
  /** Open dotted domain name, e.g. "scene.rejected". */
  kind: z.string().min(1),
  /** The instance this event is about, if any. */
  instance: z.string().optional(),
  /** Short English summary (reuses the existing `[loom]` log strings). */
  msg: z.string(),
  /** Optional structured payload (error text, fps, frameMs, …). */
  data: z.record(z.string(), z.unknown()).optional(),
});
export type DiagEvent = z.infer<typeof DiagEvent>;

/** Per-tool sidecar call latency/outcome row (FR-6). */
export const SidecarToolStat = z.object({
  tool: z.string(),
  count: z.number().int(),
  ok: z.number().int(),
  error: z.number().int(),
  timeout: z.number().int(),
  /** Latency percentiles in ms over the observed calls. */
  p50: z.number(),
  p95: z.number(),
  /** Slowest observed call in ms. */
  max: z.number(),
  /** Last error message for this tool, or null. */
  lastError: z.string().nullable(),
});
export type SidecarToolStat = z.infer<typeof SidecarToolStat>;

/**
 * `get_diagnostics` args. `since` is a `seq` cursor (page forward from the last
 * read); the other fields filter. `scope:"sidecar"` returns the sidecar's own
 * per-tool latency table instead of the engine ring (FR-6) — the one telemetry
 * layer the engine can't see.
 */
export const GetDiagnosticsArgs = z.object({
  scope: z.enum(["engine", "sidecar"]).default("engine"),
  since: z.number().int().optional(),
  kinds: z.array(z.string()).optional(),
  instance: z.string().optional(),
  level: DiagLevel.optional(),
  limit: z.number().int().min(1).max(512).optional(),
});
export type GetDiagnosticsArgs = z.infer<typeof GetDiagnosticsArgs>;

/** `get_diagnostics { scope:"engine" }` result — the event timeline. */
export const GetDiagnosticsResult = z.object({
  scope: z.literal("engine"),
  events: z.array(DiagEvent),
  /** Events evicted from the ring since the requested `since` (missed-events flag). */
  dropped: z.number().int(),
  /** The current cursor + health, so the agent's next `since` is one read away. */
  now: z.object({ frame: z.number().int(), fps: z.number(), seq: z.number().int() }),
  perf: PerfSnapshot,
});
export type GetDiagnosticsResult = z.infer<typeof GetDiagnosticsResult>;

/** `get_diagnostics { scope:"sidecar" }` result — the MCP-call latency table. */
export const GetSidecarDiagnosticsResult = z.object({
  scope: z.literal("sidecar"),
  /** Whether the engine WS bridge is currently attached. */
  engineConnected: z.boolean(),
  /** The sidecar's wire-protocol generation (NFR-1) — compare against the engine. */
  protocolVersion: z.string().default(PROTOCOL_VERSION),
  tools: z.array(SidecarToolStat),
});
export type GetSidecarDiagnosticsResult = z.infer<typeof GetSidecarDiagnosticsResult>;
