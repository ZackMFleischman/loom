import {
  buildInstance,
  ChainHost,
  FixturePlayer,
  ModulatorHost,
  nodeFxPrefix,
  type AudioBusLike,
  type ChainStepInput,
  type EffectRegistry,
  type FixtureData,
  type FrameCtx,
  type InputRegistry,
  type Instance,
  type PaletteRegistry,
  type SceneDef,
  type SourceResolver,
  type TexNode,
  type TimeBus,
  texNode,
} from "@loom/runtime";
import { texture, vec4 } from "three/tsl";
import { RenderTarget } from "three/webgpu";
import type { InstanceStatus } from "@loom/sidecar/protocol";
import { logDiag } from "./diagnostics";

/** Offscreen resolution for non-live instances (tiles, candidate screenshots). */
export const PREVIEW_W = 640;
export const PREVIEW_H = 360;

export interface Entry {
  readonly id: string;
  sceneName: string;
  instance: Instance;
  /** The def this instance was built from — identity says whether HMR changed it. */
  def: SceneDef;
  /** Where this instance renders when it isn't the live output. */
  readonly target: RenderTarget;
  /** Last HMR rebuild for this instance was rejected (✗ chip). */
  lastUpdateRejected: boolean;
  /** The build error from the last rejected rebuild (for diagnostics), else null. */
  lastRebuildError: string | null;
  /** Run-time param modulators — per instance, surviving rebuilds (FR-3/FR-4). */
  readonly modulators: ModulatorHost;
  /** Post-effect chain — per instance, folded into every build (M6). */
  readonly chain: ChainHost;
  /** Per-node FX chains (Layers): node id → host, folded at each ctx.layer() wrap. */
  readonly nodeChains: Map<string, ChainHost>;
  /** Deterministic input trace this instance consumes instead of the live rack (Fixtures). */
  readonly fixture: { name: string; data: FixtureData; player: FixturePlayer } | null;
  /** Successful builds of this entry (1 on create) — validators assert "no rebuild" against this. */
  builds: number;
  /** Pinned role: "panic" = the designated SAFE target for scene-panic (protected from destroy). */
  pinned?: "panic";
}

/** Optional creation-time seed (Projects): chains/values fold into build #1. */
export interface InstanceInit {
  /** Root chain steps (overrides the scene's default chain). */
  chain?: ChainStepInput[];
  /** Per-node chain steps keyed by layer-node id. */
  nodeChains?: Record<string, ChainStepInput[]>;
  /** Per-instance tuned values, applied OVER the per-scene tuned defaults. */
  values?: Record<string, number | boolean | string>;
  /** Replay a recorded input trace instead of the live rack (Fixtures). */
  fixture?: { name: string; data: FixtureData; baseFrame: number };
}

export function entryStatus(e: Entry): InstanceStatus {
  if (e.instance.error != null) return "frozen";
  if (e.lastUpdateRejected) return "rejected";
  return "ok";
}

/**
 * The instance registry: who exists, with what scene, in what state.
 * Build failures throw out of create() (callers contain them); rebuild()
 * keeps NFR-5 trySwap semantics per instance — a failed rebuild never
 * touches the running one.
 */
export class SessionStore {
  readonly entries = new Map<string, Entry>();
  private counter = 0;

  constructor(
    private readonly buses: { audio: AudioBusLike; time: TimeBus; inputs?: InputRegistry; palettes?: PaletteRegistry },
    /** The chainable-effect library (M6) — a getter so it tracks `./effects` HMR. */
    private readonly effects: () => EffectRegistry,
    /** Tuned per-scene values (NFR-5: params reapplied from tuned state). */
    private readonly tunedValues?: (scene: string) => Record<string, number | boolean | string> | undefined,
    /** Per-scene slider range overrides, reapplied before values on every build. */
    private readonly tunedRanges?: (scene: string) => Record<string, [number, number]> | undefined,
    /** Per-scene color decompositions, reapplied before values so channels exist (R7.4). */
    private readonly tunedColorSpaces?: (scene: string) => Record<string, "hsv" | "rgb"> | undefined,
  ) {}

  create(def: SceneDef, id?: string, init?: InstanceInit): Entry {
    const finalId = id ?? `${def.name}-${++this.counter}`;
    if (this.entries.has(finalId)) throw new Error(`instance "${finalId}" already exists`);
    const resolver = this.makeResolver(finalId);
    const chain = new ChainHost(this.effects, undefined, resolver);
    chain.seed(def.chain); // scene-declared default chain (M6)
    if (init?.chain) chain.steps = chain.plan(init.chain); // project-restored chain (defaults stay the scene's)
    const nodeChains = new Map<string, ChainHost>();
    for (const [node, steps] of Object.entries(init?.nodeChains ?? {})) {
      const host = new ChainHost(this.effects, nodeFxPrefix(node), resolver);
      host.seed([]);
      host.steps = host.plan(steps);
      nodeChains.set(node, host);
    }
    const fixture = init?.fixture
      ? {
          name: init.fixture.name,
          data: init.fixture.data,
          player: new FixturePlayer(init.fixture.data, init.fixture.baseFrame),
        }
      : null;
    const instance = buildInstance(
      def,
      fixture ? { ...this.buses, inputs: fixture.player } : this.buses,
      (ctx, tex) => chain.fold(ctx, tex),
      { foldNode: (ctx, node, tex) => nodeChains.get(node)?.fold(ctx, tex) ?? tex },
    );
    this.reapplyValues(instance, def.name, chain, nodeChains);
    // Per-instance values (Projects) override the per-scene tuned defaults.
    for (const [path, v] of Object.entries(init?.values ?? {})) {
      try {
        instance.manifest.get(path)?.set(v);
      } catch {
        // a persisted value that no longer fits — keep the default
      }
    }
    const entry: Entry = {
      id: finalId,
      sceneName: def.name,
      instance,
      def,
      target: new RenderTarget(PREVIEW_W, PREVIEW_H),
      lastUpdateRejected: false,
      lastRebuildError: null,
      modulators: new ModulatorHost({ bpm: () => this.buses.time.bpm, audio: this.buses.audio }),
      chain,
      nodeChains,
      fixture,
      builds: 1,
    };
    // The kernel built the instance knowing only the scene name; stamp the entry
    // id so a render-time freeze / loop-guard event carries the instance id.
    instance.instanceId = finalId;
    this.entries.set(finalId, entry);
    return entry;
  }

  /** NFR-5: rebuild from new code; on failure the old instance keeps running. */
  rebuild(id: string, def: SceneDef): boolean {
    const e = this.entries.get(id);
    if (!e) return false;
    this.captureChainValues(e); // preserve live chain knobs across the scene rebuild
    return this.swap(e, def);
  }

  /**
   * M6: replace a post-effect chain (full-list semantics — add/remove/reorder/
   * insert in one idempotent verb) and rebuild. A throwing step rejects the
   * rebuild and keeps the previous chain AND pixels (NFR-5). `"default"` restores
   * the scene's declared chain. Throws on an unknown effect (chain untouched).
   * `node` targets a named layer node's chain (Layers); default is the root.
   */
  setChain(id: string, input: ChainStepInput[] | "default", node?: string): boolean {
    const e = this.require(id);
    const host = node == null ? e.chain : this.requireNodeChain(e, node);
    const prev = host.steps;
    this.captureChainValues(e); // so carry-forward sees live knob values
    const candidate = input === "default" ? host.toDefault() : host.plan(input);
    host.steps = candidate;
    const ok = this.swap(e, e.def);
    if (!ok) {
      host.steps = prev; // a step failed to build — restore the old chain; old pixels still live
      const where = node == null ? `"${e.id}"` : `node "${node}" of "${e.id}"`;
      throw new Error(`chain edit rejected on ${where} — a step failed to build; previous chain kept`);
    }
    return ok;
  }

  /**
   * Build the SourceResolver a ChainHost on instance `ownerId` uses to turn a
   * `{instance}` SourceRef into a TexNode (multi-input chain steps). The owning
   * instance is excluded — an instance tapping ITSELF as a source is rejected
   * (that's a feedback case, not a multi-input overlay), as is a missing one.
   * Returning null makes the fold throw, so NFR-5 keeps the previous chain.
   */
  private makeResolver(ownerId: string): SourceResolver {
    return {
      instance: (id): TexNode | null => {
        if (id === ownerId) return null; // self-tap is rejected (would be feedback)
        const src = this.entries.get(id);
        if (!src) return null;
        // Sample the source instance's render target as a flat (opaque) texture.
        return texNode(vec4(texture(src.target.texture).rgb, 1));
      },
    };
  }

  /** A node's chain host, created lazily; the node must exist on the current build. */
  private requireNodeChain(e: Entry, node: string): ChainHost {
    let host = e.nodeChains.get(node);
    if (host) return host;
    if (!e.instance.nodes.some((n) => n.id === node)) {
      const have = e.instance.nodes.map((n) => n.id).join(", ") || "(none — wrap one with ctx.layer)";
      throw new Error(`unknown node "${node}" on "${e.id}" — nodes: ${have}`);
    }
    host = new ChainHost(this.effects, nodeFxPrefix(node), this.makeResolver(e.id));
    host.seed([]); // node chains have no scene-declared default (root only)
    e.nodeChains.set(node, host);
    return host;
  }

  private captureChainValues(e: Entry): void {
    e.chain.captureValues(e.instance.manifest);
    for (const host of e.nodeChains.values()) host.captureValues(e.instance.manifest);
  }

  /** Build a fresh instance (folding the entry's chains) and swap it in; NFR-5 on throw. */
  private swap(e: Entry, def: SceneDef): boolean {
    try {
      const next = buildInstance(
        def,
        e.fixture ? { ...this.buses, inputs: e.fixture.player } : this.buses,
        (ctx, tex) => e.chain.fold(ctx, tex),
        { foldNode: (ctx, node, tex) => e.nodeChains.get(node)?.fold(ctx, tex) ?? tex },
      );
      this.reapplyValues(next, def.name, e.chain, e.nodeChains);
      next.instanceId = e.id; // carry the id onto the rebuilt instance (freeze-id)
      e.instance.dispose();
      e.instance = next;
      e.sceneName = def.name;
      e.def = def;
      e.lastUpdateRejected = false;
      e.builds += 1;
      e.modulators.reattach(e.instance.manifest); // FR-4: survive, orphan, or recover
      e.lastRebuildError = null;
      return true;
    } catch (err) {
      e.lastUpdateRejected = true;
      const error = err instanceof Error ? err.message : String(err);
      e.lastRebuildError = error;
      logDiag({
        level: "error",
        kind: "instance.rejected",
        instance: e.id,
        msg: `rebuild of "${e.id}" (${def.name}) rejected; previous still running`,
        data: { scene: def.name, error },
      });
      return false;
    }
  }

  /**
   * Per-frame modulator write pass; the engine skips it entirely while held
   * (FR-10). `skipId` pauses one instance's modulators — the suspended live
   * instance during scene-panic, so its held state stays truly frozen.
   */
  tickModulators(f: FrameCtx, skipId?: string | null): void {
    for (const e of this.entries.values()) {
      if (e.id === skipId) continue;
      e.modulators.tick(e.instance.manifest, f);
    }
  }

  /** The fresh-manifest ritual shared by create() and swap(): per-scene tuned
   * values, then root + node chain knob values (NFR-5's "params reapplied"). */
  private reapplyValues(
    instance: Instance,
    sceneName: string,
    chain: ChainHost,
    nodeChains: Map<string, ChainHost>,
  ): void {
    // Ranges first: a widened bound must be in place before a value that depends
    // on it is reapplied (a value saved outside the declared range).
    const ranges = this.tunedRanges?.(sceneName);
    if (ranges) instance.manifest.applyRanges(ranges);
    // Color decompositions before values: the channel params must exist to take
    // their saved channel values (and for modulator reattach to find them).
    instance.manifest.applyColorSpaces(this.tunedColorSpaces?.(sceneName));
    this.applyTuned(instance, sceneName);
    chain.applyValues(instance.manifest);
    for (const host of nodeChains.values()) host.applyValues(instance.manifest);
  }

  /** Re-apply tuned values over code defaults; unknown paths are skipped. */
  private applyTuned(instance: Instance, scene: string): void {
    const vals = this.tunedValues?.(scene);
    if (!vals) return;
    for (const [path, v] of Object.entries(vals)) {
      try {
        instance.manifest.get(path)?.set(v);
      } catch {
        // bad persisted value (e.g. malformed color) — keep the code default
      }
    }
  }

  /** Re-key an entry — same instance/target/modulators, new id. No rebuild. */
  rename(id: string, to: string): Entry {
    const e = this.require(id);
    if (this.entries.has(to)) throw new Error(`instance "${to}" already exists`);
    const renamed: Entry = { ...e, id: to };
    renamed.instance.instanceId = to; // keep freeze-id events pointing at the new id
    this.entries.delete(id);
    this.entries.set(to, renamed);
    return renamed;
  }

  destroy(id: string): boolean {
    const e = this.entries.get(id);
    if (!e) return false;
    e.instance.dispose();
    e.target.dispose();
    this.entries.delete(id);
    return true;
  }

  get(id: string): Entry | undefined {
    return this.entries.get(id);
  }

  require(id: string): Entry {
    const e = this.entries.get(id);
    if (!e) {
      const have = [...this.entries.keys()].join(", ") || "(none)";
      throw new Error(`unknown instance "${id}" — running instances: ${have}`);
    }
    return e;
  }
}
