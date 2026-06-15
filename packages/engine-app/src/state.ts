/**
 * The persistence schema — the single source of truth for every key under
 * content/state/. Engine-written tuned state round-trips through these keys via
 * the loom:state Vite middleware (GET/POST /loom/state/<key>); a typo in a raw
 * key string silently loses state, so every site builds keys from here.
 *
 * Load ORDER is load-bearing where noted: range overrides must be applied before
 * the values that depend on them (a value persisted outside its declared range
 * needs the widened bound in place first) — see the boot sequence in main.ts and
 * Manifest.applyRanges.
 */
export const StateKey = {
  /** Globals input-rack channel tunings (`inputs.<ch>.<knob>` values). */
  inputs: "inputs",
  /** Globals rack slider range overrides — load BEFORE `inputs`. */
  inputRanges: "input-ranges",
  /** Global palette stops (`palette.<source>.<i>`). */
  palettes: "palettes",
  /** Per-stop color-space decomposition (R7.4) — travels with the palette tunings. */
  paletteSpaces: "palette-spaces",
  /** Channel modulators on decomposed global palette colors (R7.4). */
  paletteMods: "palette-mods",
  /** MIDI-learn bindings keyed by scene. */
  bindings: "bindings",
  /** Auto-saved working set (instances + slot pointers) — restored on boot. */
  session: "session",
  /** Per-scene tuned param values. */
  sceneValues: (scene: string): string => `values/${scene}`,
  /** Per-scene slider range overrides — load BEFORE the matching `sceneValues`. */
  sceneRanges: (scene: string): string => `ranges/${scene}`,
  /** Per-scene color-space decomposition of `ctx.color` params (R7.4). */
  sceneColorSpaces: (scene: string): string => `color-spaces/${scene}`,
} as const;

/** State subdirectories addressed as `<dir>/<name>` keys (and listed via /loom/state-list/<dir>). */
export const StateDir = {
  projects: "projects",
  fixtures: "fixtures",
} as const;

/** The state key for a saved project (set list). */
export const projectKey = (name: string): string => `${StateDir.projects}/${name}`;
/** The state key for a recorded input-trace fixture. */
export const fixtureKey = (name: string): string => `${StateDir.fixtures}/${name}`;
/** The in-repo path a state key maps to (for tool result messages). */
export const repoStatePath = (key: string): string => `content/state/${key}.json`;

/**
 * Engine side of the loom:state Vite middleware: tuned state (globals
 * tunings, MIDI bindings, per-scene param values) round-trips through
 * content/state/*.json. `?state=off` disables both load and save —
 * validators use it so persisted tunings can never skew their assertions.
 */
export class StateClient {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    readonly enabled: boolean,
    private readonly debounceMs = 400,
  ) {}

  async load(name: string): Promise<unknown | null> {
    if (!this.enabled) return null;
    try {
      const res = await fetch(`/loom/state/${name}`);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null; // state is a convenience, never a boot blocker
    }
  }

  /** Debounced per name — slider drags coalesce into one write. */
  save(name: string, data: () => unknown): void {
    if (!this.enabled) return;
    const prev = this.timers.get(name);
    if (prev) clearTimeout(prev);
    this.timers.set(
      name,
      setTimeout(() => {
        this.timers.delete(name);
        void fetch(`/loom/state/${name}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(data()),
        }).catch(() => {});
      }, this.debounceMs),
    );
  }
}
