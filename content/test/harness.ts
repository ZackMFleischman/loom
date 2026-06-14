import {
  BuildCtx,
  Events,
  InputRegistry,
  PaletteRegistry,
  Signal,
  texNode,
  TimeBus,
  type AudioBusLike,
  type BandName,
  type FrameCtx,
  type ModuleFactory,
  type Pass,
  type SignalLike,
  type TexNode,
} from "@loom/runtime";
import { vec4 } from "three/tsl";
import rack from "../inputs";

/**
 * The stdlib test harness: the REAL BuildCtx with mock/real buses, so modules
 * build exactly as they do in the engine — headless, no GPU. ProbeCtx records
 * every uniform a module registers; after ticking the updaters, those values
 * ARE the module's CPU-side signal outputs, which makes NaN detection total.
 */

/** Deterministic audio: settable band levels + explicitly queued onsets. */
export class FakeAudioBus implements AudioBusLike {
  rmsLevel = 0.35;
  levels: Record<BandName, number> = { bass: 0.4, mid: 0.3, treble: 0.2 };
  readonly rms = new Signal(() => this.rmsLevel);
  private onsetQueue: number[] = [];

  band(name: BandName): Signal<number> {
    return new Signal(() => this.levels[name]);
  }

  onset(): Events<number> {
    return new Events(() => this.onsetQueue.splice(0));
  }

  /** Queue an onset for the next poll (kick the fake drum). */
  pulse(v = 1): void {
    this.onsetQueue.push(v);
  }
}

/** Real BuildCtx that remembers every uniform it bridges (the NaN probes). */
export class ProbeCtx extends BuildCtx {
  readonly probes: Array<{ value: number }> = [];

  override uniformOf(value: SignalLike | Signal<number>): ReturnType<BuildCtx["uniformOf"]> {
    const u = super.uniformOf(value);
    this.probes.push(u as unknown as { value: number });
    return u;
  }
}

export interface Harness {
  ctx: ProbeCtx;
  audio: FakeAudioBus;
  time: TimeBus;
  inputs: InputRegistry;
}

/** A fresh build context wired like the engine: real rack, real palettes. */
export function makeCtx(): Harness {
  const audio = new FakeAudioBus();
  const time = new TimeBus(120);
  const inputs = new InputRegistry({ audio });
  inputs.define(rack);
  const palettes = new PaletteRegistry();
  const ctx = new ProbeCtx(audio, time, inputs, palettes);
  return { ctx, audio, time, inputs };
}

/**
 * Advance the world: tick time + rack, run every registered uniform updater —
 * exactly what Instance.renderFrame does minus the GPU. Throws propagate.
 * Returns the last FrameCtx so callers can pull module-returned Signals.
 */
export function tickFrames(h: Harness, count: number, startFrame = 0): FrameCtx {
  let f: FrameCtx = { frame: startFrame, now: startFrame / 60, dt: 1 / 60 };
  for (let i = 0; i < count; i++) {
    f = { frame: startFrame + i, now: (startFrame + i) / 60, dt: 1 / 60 };
    h.time.tick(f);
    h.inputs.update(f);
    if (i % 7 === 3) h.audio.pulse(); // onsets fire sporadically mid-sweep
    for (const update of h.ctx.updaters) update(f);
  }
  return f;
}

/** Paths of probes currently holding a non-finite value (NaN/±Infinity). */
export function nonFiniteProbes(ctx: ProbeCtx): number[] {
  const bad: number[] = [];
  ctx.probes.forEach((p, i) => {
    if (!Number.isFinite(p.value)) bad.push(i);
  });
  return bad;
}

/** A black constant input — the degenerate TexNode every effect must accept. */
export function blackInput(): TexNode {
  return texNode(vec4(0, 0, 0, 1));
}

/** An input carrying a marker pass, for [...input.passes, ownPass] ordering checks. */
export function markerInput(): { input: TexNode; marker: Pass } {
  const marker: Pass = { render() {}, dispose() {} };
  return { input: texNode(vec4(0, 0, 0, 1), [marker]), marker };
}

/** True iff the effect preserved its input's passes as an in-order prefix. */
export function preservesInputPasses(out: TexNode, inputPasses: readonly Pass[]): boolean {
  if (out.passes.length < inputPasses.length) return false;
  return inputPasses.every((p, i) => out.passes[i] === p);
}

// ---- module discovery -------------------------------------------------------

export type ModuleFolder = "control" | "sources" | "effects" | "geo";

export interface DiscoveredModule {
  name: string;
  /** Owning pack name, or null for local content/. */
  pack: string | null;
  /** Bare (un-namespaced) module name — the key into the owning CASES registry. */
  bareName: string;
  file: string;
  folder: ModuleFolder;
  /** Module factories are heterogeneous; tests narrow per kind. */
  factory: ModuleFactory<unknown, never, unknown>;
}

const moduleFiles = import.meta.glob("../modules/{control,sources,effects,geo}/*.ts", {
  eager: true,
}) as Record<string, Record<string, unknown>>;

// Pack modules (packs/<name>/modules/…) merge into the SAME completeness sweep:
// a pack's quality is enforced identically to local content (the static glob
// matches any installed pack; absent until `pnpm pack:add`).
const packModuleFiles = import.meta.glob("../../packs/*/modules/{control,sources,effects,geo}/*.ts", {
  eager: true,
}) as Record<string, Record<string, unknown>>;

const moduleSources = import.meta.glob("../modules/{control,sources,effects,geo}/*.ts", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;
const packModuleSources = import.meta.glob(
  "../../packs/*/modules/{control,sources,effects,geo}/*.ts",
  { eager: true, query: "?raw", import: "default" },
) as Record<string, string>;

const sceneSources = import.meta.glob("../scenes/*.scene.ts", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;
const packSceneSources = import.meta.glob("../../packs/*/scenes/*.scene.ts", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

function isFactory(v: unknown): v is ModuleFactory<unknown, never, unknown> {
  return (
    typeof v === "function" &&
    typeof (v as { meta?: { name?: unknown } }).meta?.name === "string"
  );
}

/** "packs/<name>/…" → "<name>", else null. */
function packOf(file: string): string | null {
  return /\/packs\/([^/]+)\//.exec(file)?.[1] ?? null;
}

/**
 * Every defineModule export under content/modules AND any installed pack — new
 * files are swept automatically. Pack modules carry their pack + a namespaced
 * `name` ("<pack>/<module>"); local modules keep the bare name.
 */
export function discoverModules(): DiscoveredModule[] {
  const out: DiscoveredModule[] = [];
  const collect = (files: Record<string, Record<string, unknown>>) => {
    for (const [file, mod] of Object.entries(files)) {
      const folder = /\/modules\/(control|sources|effects|geo)\//.exec(file)?.[1] as
        | ModuleFolder
        | undefined;
      if (!folder) continue;
      const pack = packOf(file);
      for (const v of Object.values(mod)) {
        if (!isFactory(v)) continue;
        const bareName = v.meta.name;
        out.push({
          name: pack ? `${pack}/${bareName}` : bareName,
          pack,
          bareName,
          file,
          folder,
          factory: v,
        });
      }
    }
  };
  collect(moduleFiles);
  collect(packModuleFiles);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Raw sources for the golden-pattern scans (modules and scenes, local + pack). */
export function rawModuleSources(): Record<string, string> {
  return { ...moduleSources, ...packModuleSources };
}
export function rawSceneSources(): Record<string, string> {
  return { ...sceneSources, ...packSceneSources };
}
