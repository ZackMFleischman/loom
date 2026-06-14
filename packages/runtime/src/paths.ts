/**
 * Manifest path conventions — the single source of truth for the stringly-typed
 * path schema that couples scenes, the Manifest, MCP, MIDI, persistence, and the
 * Console. Every `<namespace>.<...>` path is built and parsed through here, so a
 * convention change is one edit instead of a cross-package grep.
 *
 * Namespaces on a manifest path:
 *   input.<name>.amount        per-instance input-rack trim (BuildCtx.input)
 *   inputs.<channel>.<knob>    globals input-rack channel tuning (InputRegistry)
 *   palette.<source>.<i>       globals palette stop; palette.source selects active
 *   <node>.layer.<knob>        a layer node's uniform rig (Layers)
 *   fx.<id>.<sub>              root post-effect chain step (M6)
 *   <node>.fx.<id>.<sub>       a layer node's post-effect chain step
 * Argument/binding prefixes (not manifest paths):
 *   mod:<paramPath>            MIDI binding that toggles a param's modulator
 *   fixture:<name>             create_instance input ref replaying a trace
 */

/** Namespace head segments. Also the reserved layer-node names (a node may not
 *  shadow a manifest namespace or an instance alias). */
const NS = {
  input: "input",
  inputs: "inputs",
  palette: "palette",
  layer: "layer",
  fx: "fx",
} as const;

// ---- input rack ----

/** Per-instance trim a scene consumes via ctx.input(name): `input.<name>.amount`. */
export const inputTrimPath = (name: string): string => `${NS.input}.${name}.amount`;

/** A globals rack channel knob: `inputs.<channel>.<knob>`. */
export const rackKnobPath = (channel: string, knob: string): string => `${NS.inputs}.${channel}.${knob}`;

// ---- palettes ----

/** A globals palette stop: `palette.<source>.<i>`. */
export const paletteStopPath = (source: string, i: number): string => `${NS.palette}.${source}.${i}`;

/** The deferred selector param choosing the active palette. */
export const PALETTE_SOURCE_PATH = `${NS.palette}.source`;

/** True for any path the "globals" pseudo-instance routes to the palettes manifest. */
export const isPalettePath = (path: string): boolean => path.startsWith(`${NS.palette}.`);

// ---- layer rig ----

export type LayerKnob = "x" | "y" | "scale" | "rotate" | "opacity";

/** A layer node's rig param: `<node>.layer.<knob>`. */
export const layerRigPath = (node: string, knob: LayerKnob): string => `${node}.${NS.layer}.${knob}`;

// ---- post-effect chains ----

/** The root chain's manifest-path head; node chains use `<node>.fx`. */
export const ROOT_FX_PREFIX = NS.fx;

/** A layer node's chain head: `<node>.fx`. */
export const nodeFxPrefix = (node: string): string => `${node}.${NS.fx}`;

/** A chain step param under a chain head: `<prefix>.<id>.<sub>`. */
export const fxStepPath = (prefix: string, id: string, sub: string): string => `${prefix}.${id}.${sub}`;

/** True for a root-chain (`fx.`) manifest path — used to keep chain knobs out of per-scene state. */
export const isFxPath = (path: string): boolean => path.startsWith(`${NS.fx}.`);

/** True for ANY chain-step path — the root chain (`fx.`) OR a node chain (`<node>.fx.`). */
export const hasFxSegment = (path: string): boolean => new RegExp(`(^|\\.)${NS.fx}\\.`).test(path);

// ---- mod: binding targets ----

const MOD = "mod:";

/** True for a MIDI binding that toggles a param's modulator. */
export const isModBinding = (path: string): boolean => path.startsWith(MOD);

/** Wrap a param path as a modulator-toggle binding target. */
export const modBindingPath = (paramPath: string): string => `${MOD}${paramPath}`;

/** The param path a `mod:` binding targets. */
export const modTarget = (path: string): string => path.slice(MOD.length);

// ---- fixture: input refs ----

const FIXTURE = "fixture:";

/** The trace name a `fixture:` create_instance input ref points at. */
export const fixtureName = (arg: string): string => arg.slice(FIXTURE.length);

// ---- reserved names ----

/** Node ids that would collide with a manifest namespace or an instance alias. */
export const RESERVED_NODE_NAMES: ReadonlySet<string> = new Set([
  NS.fx,
  NS.input,
  NS.palette,
  "live",
  "globals",
  "actions",
  "root",
]);
