import { z } from "zod";
import type { CcEvent } from "./inputbus/midi";

/**
 * MIDI-learn bindings: a CC (optionally channel-pinned) drives a param path.
 * Bindings are keyed by SCENE name, not instance id — instances are ephemeral
 * (ids churn across rebuilds and sessions) while "this knob is pulse's punch"
 * is durable. "globals" is the pseudo-scene for the global manifest; "actions"
 * is the pseudo-scene for stage navigation (live.next / live.prev).
 */
export const BindingMode = z.enum(["absolute", "set", "cycle"]);
export type BindingMode = z.infer<typeof BindingMode>;

export const BindingSchema = z.object({
  cc: z.number().int().min(0).max(127),
  ch: z.number().int().min(0).max(15).nullable(),
  scene: z.string().min(1),
  path: z.string().min(1),
  /**
   * What a CC event does to the target: "absolute" follows the control
   * continuously (setNormalized); "set"/"cycle" fire on rising edges only —
   * button semantics. Pre-mode persisted entries parse as "absolute".
   */
  mode: BindingMode.default("absolute"),
  /** set-mode target (real param value). Missing on a set param-binding = inert; actions ignore it. */
  value: z.number().optional(),
});
export type Binding = z.infer<typeof BindingSchema>;

export interface LearnTarget {
  scene: string;
  path: string;
  mode?: BindingMode;
  value?: number;
}

/** Host callbacks: the store decides WHAT fires; the host owns the param math. */
export interface BindingOps {
  /** absolute — continuous normalized write (Param.setNormalized). */
  write(scene: string, path: string, value01: number): void;
  /** set — rising edge; value is the binding's target (undefined = inert on params). */
  setValue(scene: string, path: string, value: number | undefined): void;
  /** cycle — rising edge (Param.cycle / action dispatch). */
  cycle(scene: string, path: string): void;
}

type ArmedTarget = { scene: string; path: string; mode: BindingMode; value?: number };

export class BindingStore {
  bindings: Binding[] = [];
  learning: ArmedTarget | null = null;

  /** Last value01 per physical (ch,cc) — rising-edge detection for button modes. */
  private readonly last = new Map<string, number>();

  /** Arm learn for a target; arming the exact same target again cancels (toggle). */
  startLearn(target: LearnTarget): void {
    const t: ArmedTarget = {
      scene: target.scene,
      path: target.path,
      mode: target.mode ?? "absolute",
      ...(target.value !== undefined ? { value: target.value } : {}),
    };
    const l = this.learning;
    if (l && l.scene === t.scene && l.path === t.path && l.mode === t.mode && l.value === t.value) {
      this.learning = null;
      return;
    }
    this.learning = t;
  }

  cancelLearn(): void {
    this.learning = null;
  }

  /**
   * Route one CC event: complete a pending learn (button modes complete on a
   * rising edge only, so the release tail of the arming press is ignored),
   * then dispatch to every matching binding. Absolute bindings follow the
   * value continuously; set/cycle fire once per press.
   */
  handleCc(e: CcEvent, ops: BindingOps): { learned: Binding | null } {
    const key = `${e.ch}:${e.cc}`;
    const prev = this.last.get(key) ?? 0;
    this.last.set(key, e.value);
    const rising = prev < 0.5 && e.value >= 0.5;

    let learned: Binding | null = null;
    if (this.learning && (this.learning.mode === "absolute" || rising)) {
      const t = this.learning;
      this.learning = null;
      this.replaceFor(t);
      learned = {
        cc: e.cc,
        ch: e.ch,
        scene: t.scene,
        path: t.path,
        mode: t.mode,
        ...(t.value !== undefined ? { value: t.value } : {}),
      };
      this.bindings.push(learned);
    }

    for (const b of this.bindings) {
      if (b.cc !== e.cc || (b.ch !== null && b.ch !== e.ch)) continue;
      if (b.mode === "absolute") ops.write(b.scene, b.path, e.value);
      else if (rising) {
        if (b.mode === "set") ops.setValue(b.scene, b.path, b.value);
        else ops.cycle(b.scene, b.path);
      }
    }
    return { learned };
  }

  /**
   * Learn replacement: a set learn evicts only the same (scene, path, value)
   * radio option; absolute/cycle learns evict the path's non-set bindings —
   * so a knob (absolute) and a button radio group can coexist on one param.
   */
  private replaceFor(t: ArmedTarget): void {
    this.bindings = this.bindings.filter((b) => {
      if (b.scene !== t.scene || b.path !== t.path) return true;
      if (t.mode === "set") return !(b.mode === "set" && b.value === t.value);
      return b.mode === "set";
    });
  }

  /**
   * Remove bindings on a path. value → that radio option only; mode → that
   * mode's bindings; neither → everything on the path (the float widgets'
   * one-click unbind).
   */
  unbind(target: { scene: string; path: string; mode?: BindingMode; value?: number }): boolean {
    const before = this.bindings.length;
    this.bindings = this.bindings.filter((b) => {
      if (b.scene !== target.scene || b.path !== target.path) return true;
      if (target.value !== undefined) return !(b.mode === "set" && b.value === target.value);
      if (target.mode !== undefined) return b.mode !== target.mode;
      return false;
    });
    return this.bindings.length < before;
  }

  /** Replace contents from persisted JSON; malformed entries are dropped. */
  load(raw: unknown): void {
    this.bindings = [];
    if (!Array.isArray(raw)) return;
    for (const item of raw) {
      const r = BindingSchema.safeParse(item);
      if (r.success) this.bindings.push(r.data);
    }
  }

  toJSON(): Binding[] {
    return [...this.bindings];
  }
}
