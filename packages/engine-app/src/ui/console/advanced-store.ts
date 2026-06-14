import { useSyncExternalStore } from "react";

/**
 * The "show advanced params" toggle, lifted out of ParamPanel so the `a` hotkey
 * (keyboard-shortcuts FR-4) and the `#panel-advanced` button drive the SAME
 * state. A tiny external store (no context, no provider) backed by localStorage —
 * ParamPanel subscribes via {@link useAdvanced}; the keymap flips it via
 * {@link toggleAdvanced} / {@link setAdvanced}. Identical behavior to the old
 * local state, just shared.
 */
const KEY = "loom.params.advanced";
const listeners = new Set<() => void>();

let value = read();

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setAdvanced(next: boolean): void {
  if (next === value) return;
  value = next;
  try {
    localStorage.setItem(KEY, next ? "1" : "0");
  } catch {
    // advanced visibility just won't persist across reloads
  }
  for (const fn of listeners) fn();
}

export function toggleAdvanced(): void {
  setAdvanced(!value);
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** React subscription to the shared advanced-params flag. */
export function useAdvanced(): boolean {
  return useSyncExternalStore(subscribe, () => value);
}
