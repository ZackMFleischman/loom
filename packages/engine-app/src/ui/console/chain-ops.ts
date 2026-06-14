import type { ChainStepInfo } from "@loom/sidecar/protocol";
import type { ParamDesc } from "../engine-link";

/** A step in a full-list set_chain payload: `id` kept so a surviving step keeps its knobs. */
export interface BareStep {
  id?: string;
  effect: string;
}

/**
 * The bare step list to send for a structural edit. Every structural edit is a
 * full-list set_chain; keeping ids lets the engine carry knob/mix values forward
 * (params/mix omitted). All four ops are pure — the component wraps the result
 * in one set_chain.
 */
export function chainSteps(chain: ChainStepInfo[]): BareStep[] {
  return chain.map((s) => ({ id: s.id, effect: s.effect }));
}

/** Insert a new (id-less) step at `index`. */
export function insertStep(steps: BareStep[], effect: string, index: number): BareStep[] {
  const next = steps.slice();
  next.splice(index, 0, { effect });
  return next;
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
 * enabled, which render as dedicated rows at the top of the step card.
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
