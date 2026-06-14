import { defineInputs } from "@loom/runtime";

/**
 * The input rack: every named channel the instrument reacts to (R6.1).
 * Defaults live here, in code, in git; live tuning happens on the globals
 * manifest (`inputs.<name>.*` via the Console rack drawer or set_param on
 * instance "globals") and persists to content/state/inputs.json.
 *
 * Channel meaning is owned globally — scenes get a per-instance trim, not a
 * local override. Want a differently-detected kick? Add a new named channel
 * (e.g. `kickTight`), don't retune `kick` for one scene.
 */
export default defineInputs((d) => {
  // The promoted pulse.scene idiom: bass onsets → punchy decaying envelope.
  d.onset("kick", { band: "bass", threshold: 0.22, decay: 0.22 });
  // Offbeat hats / cymbal energy, faster envelope.
  d.onset("hats", { band: "treble", threshold: 0.25, decay: 0.08 });
  // Sustained low-end weight (lagged band energy).
  d.level("bass", { band: "bass", lag: 0.06, floor: 0 });
  // Overall loudness.
  d.level("energy", { band: "rms", lag: 0.1 });
  // First hardware knob most controllers expose (bind anything to it).
  d.cc("knob1", { cc: 21 });
});
