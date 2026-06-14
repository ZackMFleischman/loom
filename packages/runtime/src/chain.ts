import { mix, vec4 } from "./tsl";
import type { BuildCtx } from "./buildctx";
import type { Events } from "./events";
import type { ChainInputSpec, ChainParamSpec, ModuleFactory } from "./module";
import type { Manifest, Param } from "./param";
import { fxStepPath, ROOT_FX_PREFIX } from "./paths";
import { Signal } from "./signal";
import { texNode, type TexNode } from "./texnode";

/**
 * Per-instance post-effect chains (M6). A chain is runtime data on the session
 * entry — never scene code — folded over the scene's output during the build:
 * `tex = effect(ctx, { input: tex, … })` per step. Because the fold runs inside
 * `buildInstance`, a throwing step makes the whole build throw, so NFR-5 rejects
 * the rebuild and the previous pixels keep running — never-go-black needs no new
 * mechanism. Step params live at `fx.<stepId>.<param>` (stable across reorder),
 * plus an automatic `fx.<stepId>.mix` wet/dry that bypasses without a rebuild.
 */

/** What a module's factory may return (formalized for M6; Geo/Cam joined in M7). */
export type ModuleOutput =
  | TexNode
  | Signal<unknown>
  | Events<unknown>
  | import("./geo").GeoNode
  | import("./geo").CamNode;

/** Opts every chainable effect accepts: an `input` TexNode plus signal knobs. */
export interface ChainEffectOpts {
  input: TexNode;
  [key: string]: unknown;
}

/** An effect usable as a chain step: `(ctx, { input, …knobs }) => TexNode`. */
export type ChainableEffect = ModuleFactory<BuildCtx, ChainEffectOpts, TexNode>;

/** A code effect registered for chain use (declares `meta.chainParams`). */
export interface PrimitiveEffectEntry {
  name: string;
  kind: "primitive";
  description?: string;
  chainParams: ChainParamSpec[];
  /**
   * Extra typed input slots beyond the piped `input` (multi-input chain steps).
   * Empty/absent = the classic single-input effect. Composites can't (yet)
   * declare slots, so they stay single-input.
   */
  chainInputs?: ChainInputSpec[];
  factory: ChainableEffect;
}

/** One inner step of a saved (composite) chain — references a primitive effect. */
export interface CompositeInnerStep {
  /** Stable id within the composite (e.g. "feedback-1"). */
  id: string;
  effect: string;
  params: Record<string, number | boolean>;
  mix?: number | undefined;
}

/** A composite effect: a saved chain, stored as data, selectable like any effect. */
export interface CompositeEffectEntry {
  name: string;
  kind: "composite";
  description?: string;
  steps: CompositeInnerStep[];
}

export type EffectEntry = PrimitiveEffectEntry | CompositeEffectEntry;

/** The library of chainable effects (code + saved chains). Hot-swappable. */
export interface EffectRegistry {
  get(name: string): EffectEntry | undefined;
  names(): string[];
}

/**
 * Where a chain step's extra input slot reads its TexNode from (multi-input
 * chain steps). Exactly one key is set:
 *  - `{ instance }` — another live tile's output, sampled as a texture.
 *  - `{ step }` — an EARLIER step's folded output (turns the linear chain into a
 *    small DAG; a cycle/ordering guard rejects forward/self references).
 *  - `{ asset }` — **DEFERRED, not yet wired.** Needs the M10 asset explorer to
 *    resolve a path to an image/video source. The schema carries it now so it's
 *    forward-compatible, but the fold throws `asset source not yet supported`
 *    until M10 lands. `flyby` (wants asset urls) stays out of the picker too.
 */
export type SourceRef =
  | { instance: string }
  | { step: string }
  | { asset: string };

/** Resolve a SourceRef to a TexNode at fold time (instance sources, etc.). */
export interface SourceResolver {
  /**
   * Turn a live instance's current output into a TexNode (a texture sample of
   * its render target). Returns null when the instance doesn't exist / can't be
   * sampled — the fold then throws so NFR-5 keeps the previous chain + pixels.
   */
  instance(id: string, ctx: BuildCtx): TexNode | null;
}

/** A folded chain step on an instance. */
export interface ChainStep {
  id: string;
  effect: string;
  /**
   * Tuned values keyed by manifest sub-path under `fx.<id>`: a primitive's
   * `"amount"`/`"mix"`, or a composite's `"feedback.amount"`. The source of
   * truth for chain knobs across rebuilds/reorders (disk persistence is M9).
   */
  params: Record<string, number | boolean>;
  /**
   * Extra input-slot bindings (multi-input chain steps): slot name → SourceRef.
   * Additive/optional — a classic single-input step has none. The fold resolves
   * each ref to a TexNode and feeds it to the matching factory opt.
   */
  inputs?: Record<string, SourceRef>;
}

/** Wire/scene input for a step — `id` optional (assigned when absent). */
export interface ChainStepInput {
  id?: string | undefined;
  effect: string;
  params?: Record<string, number | boolean> | undefined;
  mix?: number | undefined;
  /** Extra input-slot bindings (multi-input chain steps); omitted = carry forward. */
  inputs?: Record<string, SourceRef> | undefined;
}

/** Public view of a step for `get_session`. */
export interface ChainStepInfo {
  id: string;
  effect: string;
  kind: "primitive" | "composite";
  mix: number;
  /** The step's on/off toggle (`fx.<id>.enabled`) — off fades to bypass. */
  enabled: boolean;
  /** Bound extra input slots (multi-input chain steps); empty for single-input. */
  inputs?: Record<string, SourceRef>;
}

const MAX_DEPTH = 2; // composites are one level deep (primitives only) — guards cycles.
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Param names every step declares itself — effects may not re-declare them. */
const RESERVED_STEP_PARAMS: ReadonlySet<string> = new Set(["mix", "enabled", "fade"]);

/**
 * The effective wet/dry for one step: the mix knob scaled by an enable
 * envelope that ramps linearly toward enabled∈{0,1} over `fade` seconds
 * (fade 0 = hard cut). Stateful — the instance's uniform updater pulls it
 * every frame. The envelope starts AT the current enabled state so a build
 * never fades in from bypass.
 */
export function chainWetSignal(
  mix: Signal<number>,
  enabled: Signal<boolean>,
  fade: Signal<number>,
): Signal<number> {
  let env: number | null = null;
  return new Signal((f) => {
    const want = enabled.get(f) ? 1 : 0;
    const fadeS = Number(fade.get(f));
    if (env == null || fadeS <= 0) env = want;
    else if (env !== want) {
      const step = f.dt / fadeS;
      env = env < want ? Math.min(want, env + step) : Math.max(want, env - step);
    }
    return Number(mix.get(f)) * env;
  });
}

/**
 * Owns one instance's chain: the live steps, the scene-declared default (for
 * "restore default"), and the fold that turns them into the final TexNode.
 * Mirrors ModulatorHost — instance-scoped runtime state that survives rebuilds.
 */
export class ChainHost {
  steps: ChainStep[] = [];
  private defaults: ChainStep[] = [];
  private counter = 0;

  constructor(
    private readonly registry: () => EffectRegistry,
    /**
     * Manifest path head for this chain's params: the root chain keeps the
     * M6 `fx` prefix; a layer node's chain uses `<node>.fx` (Layers).
     */
    readonly prefix: string = ROOT_FX_PREFIX,
    /**
     * Resolves `{instance}` SourceRefs to TexNodes (multi-input chain steps).
     * Optional — a host without one rejects any `{instance}` source (and the
     * unsupported `{asset}` source) at fold time, so NFR-5 keeps prior pixels.
     */
    private readonly resolver?: SourceResolver,
  ) {}

  /** Seed from a scene's declared default chain (at instance create). */
  seed(init: ChainStepInput[] | undefined): void {
    this.steps = this.plan(init ?? []);
    this.defaults = this.steps.map(cloneStep);
  }

  /** Has any steps? */
  get empty(): boolean {
    return this.steps.length === 0;
  }

  /**
   * Validate and normalize a desired chain into concrete steps, carrying knob
   * values forward by surviving step id (so reorder/insert preserve positions).
   * Throws on an unknown effect — the caller rejects the whole edit, chain
   * unchanged. Does NOT mutate `this.steps`; the caller commits on a good build.
   */
  plan(input: ChainStepInput[]): ChainStep[] {
    const reg = this.registry();
    const prev = new Map(this.steps.map((s) => [s.id, s]));
    const used = new Set<string>();
    const out: ChainStep[] = [];
    // Ids of steps planned SO FAR — a `{step}` source may only tap one of these
    // (an earlier step), so a forward/self reference is rejected up front
    // (ordering guard; the linear chain becomes a DAG with no cycles).
    const earlier = new Set<string>();
    for (const raw of input) {
      const entry = reg.get(raw.effect);
      if (!entry) {
        const have = reg.names().join(", ") || "(none)";
        throw new Error(`unknown effect "${raw.effect}" — available: ${have}`);
      }
      let id = raw.id ?? this.freshId(raw.effect, used);
      while (used.has(id)) id = this.freshId(raw.effect, used); // de-dupe explicit collisions
      used.add(id);
      const carried = prev.get(id);
      const params: Record<string, number | boolean> = {
        ...(carried?.params ?? {}),
        ...(raw.params ?? {}),
      };
      if (raw.mix != null) params.mix = clamp(raw.mix, 0, 1);
      if (params.mix == null) params.mix = 1;
      // Carry input bindings forward by surviving id, with this edit's overrides.
      const merged: Record<string, SourceRef> = {
        ...(carried?.inputs ?? {}),
        ...(raw.inputs ?? {}),
      };
      const inputs = this.validateInputs(entry, id, merged, earlier);
      const step: ChainStep = { id, effect: raw.effect, params };
      if (Object.keys(inputs).length > 0) step.inputs = inputs;
      out.push(step);
      earlier.add(id);
    }
    return out;
  }

  /**
   * Validate a step's extra input bindings against the effect's declared slots,
   * normalize each SourceRef, and enforce the ordering guard for `{step}` refs.
   * Throws on any problem so the whole edit is rejected (chain unchanged).
   */
  private validateInputs(
    entry: EffectEntry,
    stepId: string,
    bindings: Record<string, SourceRef>,
    earlier: ReadonlySet<string>,
  ): Record<string, SourceRef> {
    const slots = entry.kind === "primitive" ? (entry.chainInputs ?? []) : [];
    const slotNames = new Set(slots.map((s) => s.name));
    const out: Record<string, SourceRef> = {};
    for (const [slot, ref] of Object.entries(bindings)) {
      if (!slotNames.has(slot)) {
        const have = [...slotNames].join(", ") || "(none)";
        throw new Error(
          `effect "${entry.name}" has no input slot "${slot}" — slots: ${have}`,
        );
      }
      out[slot] = this.normalizeRef(entry.name, slot, ref, stepId, earlier);
    }
    return out;
  }

  /** Normalize/validate one SourceRef (without resolving it to a TexNode yet). */
  private normalizeRef(
    effect: string,
    slot: string,
    ref: SourceRef,
    stepId: string,
    earlier: ReadonlySet<string>,
  ): SourceRef {
    if ("instance" in ref && typeof ref.instance === "string" && ref.instance.length > 0) {
      return { instance: ref.instance };
    }
    if ("step" in ref && typeof ref.step === "string" && ref.step.length > 0) {
      if (ref.step === stepId) {
        throw new Error(`"${effect}".${slot}: a step cannot tap itself ("${stepId}")`);
      }
      if (!earlier.has(ref.step)) {
        const have = [...earlier].join(", ") || "(none yet)";
        throw new Error(
          `"${effect}".${slot}: step "${ref.step}" is not an EARLIER step — earlier: ${have}`,
        );
      }
      return { step: ref.step };
    }
    if ("asset" in ref) {
      // Forward-compatible, intentionally NOT wired (needs the M10 asset
      // explorer). Reject the EDIT so we never half-build an asset source.
      throw new Error(
        `"${effect}".${slot}: asset source is not yet supported (needs the M10 asset explorer)`,
      );
    }
    throw new Error(
      `"${effect}".${slot}: invalid source — expected { instance } | { step } (asset is M10)`,
    );
  }

  /** Reset to the scene's declared default chain. */
  toDefault(): ChainStep[] {
    return this.defaults.map(cloneStep);
  }

  private freshId(effect: string, used: Set<string>): string {
    let id: string;
    do {
      id = `${effect}-${++this.counter}`;
    } while (used.has(id));
    return id;
  }

  /** Fold the chain over a base TexNode, declaring `fx.<id>.*` params on `ctx`. */
  fold(ctx: BuildCtx, base: TexNode): TexNode {
    let tex = base;
    // Earlier steps' folded outputs, keyed by step id — a `{step}` SourceRef
    // resolves against this (only earlier steps are present, by plan ordering).
    const stepOutputs = new Map<string, TexNode>();
    for (const step of this.steps) {
      const extra = this.resolveInputs(ctx, step, stepOutputs);
      tex = this.foldStep(ctx, tex, step.id, step.effect, step.params, 1, extra);
      stepOutputs.set(step.id, tex);
    }
    return tex;
  }

  /**
   * Resolve a step's extra input bindings to TexNodes for the factory. Throws
   * if any ref can't resolve (missing instance, dangling step, asset/M10) — the
   * fold throws, the build is rejected, NFR-5 keeps the previous chain + pixels.
   */
  private resolveInputs(
    ctx: BuildCtx,
    step: ChainStep,
    stepOutputs: ReadonlyMap<string, TexNode>,
  ): Record<string, TexNode> {
    const out: Record<string, TexNode> = {};
    for (const [slot, ref] of Object.entries(step.inputs ?? {})) {
      out[slot] = this.resolveRef(ctx, step.effect, slot, ref, stepOutputs);
    }
    return out;
  }

  private resolveRef(
    ctx: BuildCtx,
    effect: string,
    slot: string,
    ref: SourceRef,
    stepOutputs: ReadonlyMap<string, TexNode>,
  ): TexNode {
    if ("instance" in ref) {
      const tex = this.resolver?.instance(ref.instance, ctx) ?? null;
      if (!tex) {
        throw new Error(
          `"${effect}".${slot}: cannot resolve instance source "${ref.instance}"`,
        );
      }
      return tex;
    }
    if ("step" in ref) {
      const tex = stepOutputs.get(ref.step);
      if (!tex) {
        throw new Error(`"${effect}".${slot}: dangling step source "${ref.step}"`);
      }
      return tex;
    }
    // asset → not wired (M10); plan() already rejects it, but be defensive.
    throw new Error(
      `"${effect}".${slot}: asset source is not yet supported (needs the M10 asset explorer)`,
    );
  }

  private foldStep(
    ctx: BuildCtx,
    input: TexNode,
    idPrefix: string,
    effectName: string,
    params: Record<string, number | boolean>,
    depth: number,
    extraInputs: Record<string, TexNode> = {},
  ): TexNode {
    const entry = this.registry().get(effectName);
    if (!entry) throw new Error(`unknown effect "${effectName}" in chain`);
    const prefix = `${this.prefix}.${idPrefix}`;
    const mixParam = ctx.float(`${prefix}.mix`, {
      default: 1,
      min: 0,
      max: 1,
      step: 0.01,
      description: `${effectName} wet/dry — 0 bypassed · 1 full`,
    });
    const enabledParam = ctx.bool(`${prefix}.enabled`, {
      default: true,
      description: `${effectName} on/off — disabling fades to bypass over .fade seconds`,
    });
    const fadeParam = ctx.float(`${prefix}.fade`, {
      default: 0,
      min: 0,
      max: 8,
      step: 0.05,
      description: "enable/disable transition time (seconds)",
    });

    let out: TexNode;
    if (entry.kind === "primitive") {
      const opts: ChainEffectOpts = { input };
      for (const cp of entry.chainParams) {
        if (RESERVED_STEP_PARAMS.has(cp.name)) {
          throw new Error(`effect "${effectName}" declares reserved chain param "${cp.name}"`);
        }
        opts[cp.name] = declareChainParam(ctx, `${prefix}.${cp.name}`, cp).signal();
      }
      // Multi-input chain steps: every declared extra slot must be bound (an
      // unbound slot would build the effect with an undefined input → throw).
      for (const cs of entry.chainInputs ?? []) {
        const tex = extraInputs[cs.name];
        if (!tex) {
          throw new Error(
            `effect "${effectName}" needs input slot "${cs.name}" bound — set inputs.${cs.name}`,
          );
        }
        opts[cs.name] = tex;
      }
      out = entry.factory(ctx, opts);
    } else {
      if (depth >= MAX_DEPTH) throw new Error(`composite "${effectName}" nests too deep`);
      let inner = input;
      for (const istep of entry.steps) {
        inner = this.foldStep(
          ctx,
          inner,
          `${idPrefix}.${istep.id}`,
          istep.effect,
          innerParams(params, istep),
          depth + 1,
        );
      }
      out = inner;
    }

    // Wet/dry blend: mix=0 passes the input straight through (the effect's
    // passes still run, so stateful history stays warm and no rebuild is needed).
    // The root chain feeds the canvas, so alpha locks to 1 (M6). A node chain
    // wraps a layer that composites over the rest of the scene: most stdlib
    // effects emit alpha 1, so carrying the INPUT's alpha through keeps the
    // node's silhouette — FX recolor the node instead of going full-frame opaque.
    const wet = ctx.uniformOf(
      chainWetSignal(mixParam.signal(), enabledParam.signal(), fadeParam.signal()),
    );
    const alpha = this.prefix === ROOT_FX_PREFIX ? 1 : input.color.a;
    return texNode(vec4(mix(input.color.rgb, out.color.rgb, wet), alpha), out.passes);
  }

  /** Read live `<prefix>.<id>.*` values back into step data (before a rebuild). */
  captureValues(manifest: Manifest): void {
    for (const step of this.steps) {
      const head = `${this.prefix}.${step.id}.`;
      for (const path of manifest.paths()) {
        if (!path.startsWith(head)) continue;
        const p = manifest.get(path);
        if (p) step.params[path.slice(head.length)] = p.value as number | boolean;
      }
    }
  }

  /** Re-apply stored knob values over the code defaults (after a build). */
  applyValues(manifest: Manifest): void {
    for (const step of this.steps) {
      for (const [sub, v] of Object.entries(step.params)) {
        try {
          manifest.get(fxStepPath(this.prefix, step.id, sub))?.set(v as never);
        } catch {
          // a value that no longer fits its param (effect changed) — keep default
        }
      }
    }
  }

  /** Step summaries for `get_session`. */
  list(): ChainStepInfo[] {
    return this.steps.map((s) => {
      const entry = this.registry().get(s.effect);
      const info: ChainStepInfo = {
        id: s.id,
        effect: s.effect,
        kind: entry?.kind ?? "primitive",
        mix: typeof s.params.mix === "number" ? s.params.mix : 1,
        enabled: s.params.enabled !== false,
      };
      if (s.inputs && Object.keys(s.inputs).length > 0) info.inputs = { ...s.inputs };
      return info;
    });
  }

  /**
   * Serialize the current chain as a composite definition (for save-as).
   * Requires an all-primitive chain — saved chains are one level deep.
   */
  serialize(): { steps: CompositeInnerStep[] } {
    return {
      steps: this.steps.map((s) => {
        const entry = this.registry().get(s.effect);
        if (entry?.kind === "composite") {
          throw new Error(
            `cannot save "${s.effect}": saved chains may contain only primitive effects`,
          );
        }
        if (s.inputs && Object.keys(s.inputs).length > 0) {
          throw new Error(
            `cannot save "${s.effect}": multi-input chain steps (instance/step sources) aren't yet saveable as composites`,
          );
        }
        const { mix: m, ...rest } = s.params;
        return {
          id: s.id,
          effect: s.effect,
          params: rest,
          mix: typeof m === "number" ? m : 1,
        };
      }),
    };
  }
}

function cloneStep(s: ChainStep): ChainStep {
  const out: ChainStep = { id: s.id, effect: s.effect, params: { ...s.params } };
  if (s.inputs) out.inputs = { ...s.inputs };
  return out;
}

/** Merge a composite's stored inner defaults with any live `<innerId>.*` overrides. */
function innerParams(
  outer: Record<string, number | boolean>,
  istep: CompositeInnerStep,
): Record<string, number | boolean> {
  const merged: Record<string, number | boolean> = { ...istep.params };
  if (istep.mix != null) merged.mix = istep.mix;
  const head = `${istep.id}.`;
  for (const [k, v] of Object.entries(outer)) {
    if (k.startsWith(head)) merged[k.slice(head.length)] = v;
  }
  return merged;
}

function declareChainParam(ctx: BuildCtx, path: string, cp: ChainParamSpec): Param<unknown> {
  if (cp.type === "bool") {
    return ctx.bool(path, {
      default: Boolean(cp.default),
      ...(cp.description != null ? { description: cp.description } : {}),
    }) as Param<unknown>;
  }
  const min = cp.min ?? 0;
  const max = cp.max ?? 1;
  const spec = {
    default: clamp(Number(cp.default), min, max),
    min,
    max,
    ...(cp.step != null ? { step: cp.step } : {}),
    ...(cp.labels != null ? { labels: cp.labels } : {}),
    ...(cp.description != null ? { description: cp.description } : {}),
  };
  return (cp.type === "int" ? ctx.int(path, spec) : ctx.float(path, spec)) as Param<unknown>;
}
