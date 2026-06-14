import type { ChainStepInfo, SourceRefSchema } from "@loom/sidecar/protocol";
import type { ParamDesc } from "../engine-link";

/** A step in a full-list set_chain payload: `id` kept so a surviving step keeps its knobs. */
export interface BareStep {
  id?: string;
  effect: string;
  /** Extra input-slot bindings (multi-input chain steps); carried across edits. */
  inputs?: Record<string, SourceRefSchema>;
}

/**
 * The bare step list to send for a structural edit. Every structural edit is a
 * full-list set_chain; keeping ids lets the engine carry knob/mix values forward
 * (params/mix omitted). Input-slot bindings ARE carried explicitly (they aren't
 * knobs the engine reapplies — they're structure), so a reorder/insert/remove
 * never drops a step's overlay source. All ops are pure.
 */
export function chainSteps(chain: ChainStepInfo[]): BareStep[] {
  return chain.map((s) => ({
    id: s.id,
    effect: s.effect,
    ...(s.inputs != null && Object.keys(s.inputs).length > 0 ? { inputs: { ...s.inputs } } : {}),
  }));
}

/** Insert a new (id-less) step at `index`. */
export function insertStep(steps: BareStep[], effect: string, index: number): BareStep[] {
  const next = steps.slice();
  next.splice(index, 0, { effect });
  return next;
}

/**
 * Set one input-slot binding on the step with `id` (multi-input chain steps).
 * A null `ref` clears the slot. Pure — returns a new list the caller sends as a
 * full-list set_chain.
 */
export function setStepInput(
  steps: BareStep[],
  id: string,
  slot: string,
  ref: SourceRefSchema | null,
): BareStep[] {
  return steps.map((s) => {
    if (s.id !== id) return s;
    const inputs = { ...(s.inputs ?? {}) };
    if (ref == null) delete inputs[slot];
    else inputs[slot] = ref;
    const hasAny = Object.keys(inputs).length > 0;
    const { inputs: _drop, ...rest } = s;
    return hasAny ? { ...rest, inputs } : rest;
  });
}

/** Drop the step with the given id. */
export function removeStep(steps: BareStep[], id: string): BareStep[] {
  return steps.filter((s) => s.id !== id);
}

/** Move the step at `from` to `to` (no-op clone when equal). */
export function reorderStep(steps: BareStep[], from: number, to: number): BareStep[] {
  const next = steps.slice();
  if (from === to) return next;
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

/**
 * A step's tunable knobs: everything under `<prefix><id>.` except mix and
 * enabled. mix renders as a dedicated row in the card body; enabled is the
 * single enable control hoisted into the step header.
 */
export function stepKnobs(
  manifest: Record<string, ParamDesc>,
  prefix: string,
  id: string,
): Array<[string, ParamDesc]> {
  const head = `${prefix}${id}.`;
  return Object.entries(manifest).filter(
    ([path]) => path.startsWith(head) && path !== `${head}mix` && path !== `${head}enabled`,
  );
}

const COLLAPSE_KEY = "loom.fxcollapsed";

/**
 * The set of collapsed FX-step keys, read from localStorage. A step is keyed by
 * its `<prefix><id>` so the root chain and each layer node keep independent
 * collapse state. Bad/absent storage yields an empty set (all expanded).
 */
export function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY);
    if (raw == null) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr.filter((x): x is string => typeof x === "string")) : new Set();
  } catch {
    return new Set();
  }
}

/** Persist the collapsed-step set; storage failures are swallowed (no-op). */
export function saveCollapsed(set: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set]));
  } catch {
    // collapse state just won't persist across reloads
  }
}

/** Pure toggle: returns a NEW set with `key` flipped in/out of the collapsed set. */
export function toggleCollapsed(set: Set<string>, key: string): Set<string> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}
