import type { FrameCtx } from "./frame";
import {
  createModulator,
  ModulatorSpec,
  type ModulatorBus,
  type ModulatorEval,
  type ModulatorParamMeta,
} from "./modulator";
import type { ParamType } from "./param";

/** The slice of Param/Manifest a host needs (lets tests inject fakes). */
export interface ParamLike {
  set(v: unknown): void;
  toJSON(): Record<string, unknown>;
}
export interface ManifestLike {
  get(path: string): ParamLike | undefined;
}

export interface ModulatorInfo {
  path: string;
  spec: ModulatorSpec;
  /** Non-null = detached: evaluation threw, or the param vanished on rebuild. */
  error: string | null;
  /** False = paused: attached but not writing; the param is hand-drivable. */
  enabled: boolean;
}

interface Slot {
  spec: ModulatorSpec;
  evaluate: ModulatorEval;
  error: string | null;
  enabled: boolean;
}

/**
 * Per-instance modulator registry: attach/replace/clear, the per-frame
 * write pass, and HMR re-attachment. Lives in the engine's SessionStore
 * entry (per instance, not per scene — FR-3); the engine only schedules.
 */
export class ModulatorHost {
  private readonly slots = new Map<string, Slot>();

  constructor(private readonly bus: ModulatorBus) {}

  /** Attach or replace (one modulator per param, FR-1). Throws on a bad spec. */
  attach(manifest: ManifestLike, path: string, raw: unknown): ModulatorSpec {
    const param = manifest.get(path);
    if (!param) throw new Error(`unknown param "${path}"`);
    if ((param as { type?: string }).type === "color") {
      throw new Error(`"${path}" is a color param — modulators drive numeric/bool params only`);
    }
    const spec = ModulatorSpec.parse(raw);
    const evaluate = createModulator(spec, paramMeta(param), this.bus);
    this.slots.set(path, { spec, evaluate, error: null, enabled: true });
    return spec;
  }

  /** Detach. False when there was nothing to clear (callers treat as no-op success). */
  clear(path: string): boolean {
    return this.slots.delete(path);
  }

  get(path: string): ModulatorInfo | undefined {
    const s = this.slots.get(path);
    return s && { path, spec: s.spec, error: s.error, enabled: s.enabled };
  }

  /**
   * Pause/resume without detaching: a paused modulator keeps its spec but
   * stops writing — the param holds its last value and is hand-drivable.
   * Throws on a path with no modulator (callers learn the real state).
   */
  setEnabled(path: string, enabled: boolean): ModulatorInfo {
    const s = this.slots.get(path);
    if (!s) throw new Error(`no modulator on "${path}"`);
    s.enabled = enabled;
    return { path, spec: s.spec, error: s.error, enabled: s.enabled };
  }

  /** Flip a modulator's enabled state; null when the path has no modulator. */
  toggleEnabled(path: string): ModulatorInfo | null {
    const s = this.slots.get(path);
    return s ? this.setEnabled(path, !s.enabled) : null;
  }

  /** True when the param is owned by a live (non-errored, running) modulator (FR-7). */
  active(path: string): boolean {
    const s = this.slots.get(path);
    return s != null && s.error == null && s.enabled;
  }

  list(): ModulatorInfo[] {
    return [...this.slots.entries()].map(([path, s]) => ({
      path,
      spec: s.spec,
      error: s.error,
      enabled: s.enabled,
    }));
  }

  /**
   * FR-9: evaluate every active modulator and write through the manifest.
   * A throw detaches that modulator (error recorded, param holds its last
   * value) and never reaches the render loop.
   */
  tick(manifest: ManifestLike, f: FrameCtx): void {
    for (const [path, s] of this.slots) {
      if (s.error != null || !s.enabled) continue;
      try {
        const param = manifest.get(path);
        if (!param) throw new Error(`param "${path}" disappeared`);
        param.set(s.evaluate(f));
      } catch (err) {
        s.error = err instanceof Error ? err.message : String(err);
      }
    }
  }

  /**
   * FR-4: after an instance rebuild, re-attach each stored spec to the new
   * manifest (fresh evaluator; phase restarts). Orphans stay listed with
   * error set so get_session can report them; a later rebuild that brings
   * the param back recovers them.
   */
  reattach(manifest: ManifestLike): void {
    for (const [path, s] of this.slots) {
      const param = manifest.get(path);
      if (!param) {
        s.error = `param "${path}" vanished in rebuild`;
        continue;
      }
      try {
        s.evaluate = createModulator(s.spec, paramMeta(param), this.bus);
        s.error = null;
      } catch (err) {
        s.error = err instanceof Error ? err.message : String(err);
      }
    }
  }
}

function paramMeta(param: ParamLike): ModulatorParamMeta {
  const j = param.toJSON() as {
    type: ParamType;
    min?: number;
    max?: number;
    value?: number | boolean;
  };
  return { type: j.type, min: j.min, max: j.max, value: j.value };
}
