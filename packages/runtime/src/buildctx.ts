import { uniform } from "three/tsl";
import { Color } from "three/webgpu";
import type { Node } from "three/webgpu";
import type { FrameCtx } from "./frame";
import type { AudioBusLike } from "./inputbus/audio";
import type { TimeBus } from "./inputbus/time";
import type { InputProvider } from "./fixture";
import { layerRig, NODE_NAME_RE, RESERVED_NODE_NAMES, type LayerHooks, type LayerNodeInfo } from "./layer";
import { PaletteCtxImpl, type PaletteRegistry } from "./palette";
import { inputTrimPath } from "./paths";
import { Manifest, type BoolParamSpec, type ColorParamSpec, type RangedParamSpec, type Param } from "./param";
import { Signal, type SignalLike } from "./signal";
import type { Pass, TexNode } from "./texnode";

/**
 * A per-frame uniform updater. It is just a function `(FrameCtx) => void`, so
 * existing `ctx.updaters.push((f) => …)` callers are unchanged — but it may
 * carry a `label` (usually a param path) that `Instance` uses to attribute
 * per-frame cost back to the signal that drove it.
 */
export interface Updater {
  (f: FrameCtx): void;
  label?: string;
}

/**
 * Handed to scene/module build functions. Collects the manifest and the
 * per-frame uniform updaters that bridge CPU Signals onto the GPU.
 * Modules never reach outside this.
 */
export class BuildCtx {
  readonly manifest = new Manifest();
  readonly updaters: Array<Updater> = [];
  /** Named nodes registered by ctx.layer() during this build, in wrap order. */
  readonly nodes: LayerNodeInfo[] = [];
  private paletteCtx: PaletteCtxImpl | null = null;
  /** Each node's rig pass — containment in a later wrap's input = parentage. */
  private readonly nodeMarkers = new Map<string, Pass>();

  constructor(
    readonly audio: AudioBusLike,
    readonly time: TimeBus,
    /** The live input rack — or a FixturePlayer replaying a recorded trace. */
    readonly inputs?: InputProvider,
    readonly palettes?: PaletteRegistry,
    private readonly layerHooks?: LayerHooks,
  ) {}

  /**
   * The global palettes (R7): color(i) stops, ramp(t) gradient, own(stops)
   * scene defaults. Using it auto-declares a palette.source param resolved
   * per frame by the uniform updaters — switching never rebuilds.
   */
  get palette(): PaletteCtxImpl {
    this.paletteCtx ??= new PaletteCtxImpl(this.manifest, this.updaters, this.palettes);
    return this.paletteCtx;
  }

  /** Declare deferred params (palette.source). buildInstance calls this after build(). */
  finalize(): void {
    this.paletteCtx?.finalize();
  }

  /**
   * Wrap any TexNode as a named, grabbable node (Layers): registers a stable
   * identity, folds the uniform-driven layer rig (`<name>.layer.x/y/scale/
   * rotate/opacity` params, identity by default — `set_param` never rebuilds),
   * and folds the node's FX chain when the session injected one. Names must be
   * unique per build; a duplicate throws (NFR-5 contains it).
   */
  layer(name: string, tex: TexNode): TexNode {
    if (!NODE_NAME_RE.test(name)) {
      throw new Error(`ctx.layer: invalid node name "${name}" (letters, digits, - and _; must start with a letter)`);
    }
    if (RESERVED_NODE_NAMES.has(name)) {
      throw new Error(`ctx.layer: "${name}" is a reserved name`);
    }
    if (this.nodeMarkers.has(name)) {
      throw new Error(`ctx.layer: duplicate node name "${name}" — node ids must be unique per scene`);
    }
    let out = layerRig(this, name, tex);
    const marker = out.passes[out.passes.length - 1]!;
    out = this.layerHooks?.foldNode?.(this, name, out) ?? out;
    // Wraps register bottom-up, so any not-yet-parented node whose rig pass is
    // inside this wrap's input gets this node as its immediate parent.
    for (const n of this.nodes) {
      const m = this.nodeMarkers.get(n.id);
      if (n.parent == null && m != null && tex.passes.includes(m)) n.parent = name;
    }
    this.nodes.push({ id: name, parent: null });
    this.nodeMarkers.set(name, marker);
    return out;
  }

  /**
   * Consume a named input-rack channel (R6.3). Late-bound: the name resolves
   * through the registry at pull time, so retuning/redefining a channel never
   * rebuilds this instance. Auto-declares a per-instance trim param
   * (`input.<name>.amount`) — trims, not overrides: the channel's detection
   * meaning stays owned by the globals rack. The trim is flagged `hidden` so it
   * stays out of the default params box (a scene never asked for it); it remains
   * fully live and is revealed by the Console panel's advanced toggle.
   */
  input(name: string): Signal<number> {
    const reg = this.inputs;
    if (!reg) return Signal.of(0); // no rack wired (bare unit-test builds)
    const path = inputTrimPath(name);
    const trim =
      (this.manifest.get(path) as Param<number> | undefined) ??
      this.manifest.float(path, {
        default: 1,
        min: 0,
        max: 2,
        // Hidden from the default params box: a scene didn't ask for this knob,
        // it's auto-added by consuming a channel. Still fully live (persisted,
        // MIDI-bindable, modulatable) and revealed by the panel's advanced toggle.
        hidden: true,
        description: `trim for input channel "${name}"`,
      });
    const chan = reg.signal(name);
    const trimSig = trim.signal();
    return new Signal((f) => chan.get(f) * trimSig.get(f)).named(`input.${name}`);
  }

  float(path: string, spec: RangedParamSpec) {
    return this.manifest.float(path, spec);
  }

  int(path: string, spec: RangedParamSpec) {
    return this.manifest.int(path, spec);
  }

  bool(path: string, spec: BoolParamSpec) {
    return this.manifest.bool(path, spec);
  }

  /**
   * Declare a color param and bridge it onto the GPU as a vec3 uniform that
   * re-reads every frame (R7.4). The human can pick it flat, or expand it into
   * H/S/V or R/G/B channels in the Console — each channel then modulates and
   * MIDI-binds like any float, and this uniform follows the recomposed color
   * with no rebuild.
   */
  color(path: string, spec: ColorParamSpec): Node<"vec3"> {
    const param = this.manifest.color(path, spec);
    const u = uniform(new Color(param.value));
    const upd: Updater = () => {
      (u.value as Color).set(param.value);
    };
    upd.label = path;
    this.updaters.push(upd);
    return u as unknown as Node<"vec3">;
  }

  /**
   * Bridge a number Signal (or constant) into a TSL uniform that updates
   * every frame. This is also what guarantees stateful signals get pulled.
   * An optional `label` (else the signal's own `.label`, e.g. a param path)
   * attributes this updater's per-frame cost in the profiler.
   */
  uniformOf(value: SignalLike | Signal<number>, label?: string) {
    if (typeof value === "number") return uniform(value);
    const u = uniform(0);
    const upd: Updater = (f) => {
      u.value = value.get(f);
    };
    const lbl = label ?? value.label;
    if (lbl !== undefined) upd.label = lbl;
    this.updaters.push(upd);
    return u;
  }
}
