import {
  type BindingStore,
  type InputRegistry,
  isModBinding,
  isPalettePath,
  type MidiBus,
  type ModulatorHost,
  modTarget,
  type PaletteRegistry,
  type Param,
} from "@loom/runtime";
import type { SessionStore } from "./session";

/** The persistence hooks MIDI writes flush through (a slice of main's `persist`). */
export interface MidiPersist {
  globals(): void;
  palettes(): void;
  scene(name: string): void;
  bindings(): void;
}

export interface MidiRouterDeps {
  midi: MidiBus;
  session: SessionStore;
  inputs: InputRegistry;
  palettes: PaletteRegistry;
  /** Modulators for decomposed global palette color channels (R7.4). */
  globalsModulators: ModulatorHost;
  bindings: BindingStore;
  persist: MidiPersist;
}

/** The "actions" pseudo-scene: a binding here steps LIVE rather than writing a param. */
const ACTIONS = "actions";

/**
 * MIDI → param routing (extracted from main.ts, architecture refactor Phase 3).
 *
 * Owns the `writeParam` / `setModEnabled` / `onCc` wiring: a CC completes a
 * pending learn, then drives its bindings — absolute writes ride the same
 * Manifest path as set_param; button modes (set/cycle) fire per press; the
 * "actions" pseudo-scene steps LIVE through the tiles. The `globals` scene
 * routes to the input-rack manifest or the palette manifest by path shape.
 */
export class MidiRouter {
  /**
   * "actions" pseudo-scene handler (live.next/live.prev). Late-bound: CCs can
   * arrive during boot awaits, before the EngineApi that services steps exists.
   */
  onAction: (path: string) => void = () => {};

  constructor(private readonly d: MidiRouterDeps) {}

  /** Subscribe to the CC stream. Call once, after deps are wired. */
  start(): void {
    this.d.midi.onCc((e) => {
      const { learned } = this.d.bindings.handleCc(e, {
        write: (scene, path, v01) => this.writeParam(scene, path, (p) => p.setNormalized(v01)),
        setValue: (scene, path, value) => {
          if (scene === ACTIONS) return this.onAction(path);
          if (value === undefined) return; // a set binding without a target is inert
          if (isModBinding(path)) return this.setModEnabled(scene, modTarget(path), value >= 0.5);
          this.writeParam(scene, path, (p) => p.set(value));
        },
        cycle: (scene, path) => {
          if (scene === ACTIONS) return this.onAction(path);
          if (isModBinding(path)) return this.setModEnabled(scene, modTarget(path), "toggle");
          this.writeParam(scene, path, (p) => p.cycle());
        },
      });
      if (learned) this.d.persist.bindings();
    });
  }

  /** Apply a mutation to a param on every instance of `scene` (or globals), then persist. */
  writeParam(scene: string, path: string, apply: (p: Param<unknown>) => void): void {
    if (scene === "globals") {
      const isPalette = isPalettePath(path);
      const param = (isPalette ? this.d.palettes.manifest : this.d.inputs.manifest).get(path);
      if (!param) return;
      apply(param);
      if (isPalette) this.d.persist.palettes();
      else this.d.persist.globals();
      return;
    }
    let touched = false;
    for (const entry of this.d.session.entries.values()) {
      if (entry.sceneName !== scene) continue;
      const param = entry.instance.manifest.get(path);
      if (param) {
        apply(param);
        touched = true;
      }
    }
    if (touched) this.d.persist.scene(scene);
  }

  /**
   * "mod:<paramPath>" bindings pause/resume that param's modulator on every
   * instance of the scene (toggleEnabled is a safe no-op when none is attached).
   */
  setModEnabled(scene: string, paramPath: string, to: "toggle" | boolean): void {
    if (scene === "globals") {
      if (to === "toggle") this.d.globalsModulators.toggleEnabled(paramPath);
      else if (this.d.globalsModulators.get(paramPath) != null) this.d.globalsModulators.setEnabled(paramPath, to);
      this.d.persist.palettes();
      return;
    }
    for (const entry of this.d.session.entries.values()) {
      if (entry.sceneName !== scene) continue;
      if (to === "toggle") entry.modulators.toggleEnabled(paramPath);
      else if (entry.modulators.get(paramPath) != null) entry.modulators.setEnabled(paramPath, to);
    }
  }
}
