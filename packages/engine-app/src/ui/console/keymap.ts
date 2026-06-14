import { useEffect, useRef } from "react";

/**
 * The Console keymap registry (feature: keyboard-shortcuts, Phase 1).
 *
 * ONE delegated `window` keydown listener (NFR-2 — not N listeners), a
 * data-driven registry of bindings, a centralized typing guard (FR-3), and
 * priority scope resolution (FR-2). The registry is the single source of truth
 * for BOTH behavior and the `?` cheatsheet (FR-1/FR-5) — so the help overlay can
 * never drift from what the keys actually do.
 *
 * Every binding issues the SAME engine command / UI action a button already does
 * (NFR-1): no new render-path code, no swap/HMR/render change. The registry only
 * routes a keystroke to an existing handler.
 */

/** Where a binding is allowed to fire, in priority order (FR-2). */
export type Scope = "popover" | "panel" | "global";

/** The groups the cheatsheet lays out in columns (FR-5). */
export type Group = "Transport" | "Stage" | "Tiles" | "Panels" | "Safety" | "Help";

/**
 * The live context a binding's `run`/`when` reads. Built fresh each render from
 * ConsoleApp's state + the engine link, so bindings stay pure data: they receive
 * everything they need rather than closing over component internals.
 */
export interface KeymapContext {
  /** Fire-and-forget engine request (the same `link.req` the buttons call). */
  req: (type: string, args?: Record<string, unknown>) => void;
  /** UI-state toggles / setters (the same the header buttons call). */
  toggleRack: () => void;
  togglePreview: () => void;
  togglePerf: () => void;
  toggleAdvanced: () => void;
  /** Close the topmost popover/dialog, if any is open (Escape scope chain). */
  closeTopPopover: () => boolean;
  /** Leave preview + perf overlays (the old Escape behavior). */
  leaveOverlays: () => void;
  /** Self-capture the cockpit (console-screenshot's download path). */
  capture: () => void;
  /** Toggle the cheatsheet overlay. */
  toggleCheatsheet: () => void;
  cheatsheetOpen: boolean;

  /** Tile selection / solo / stage helpers (operate on the selected tile). */
  selectStep: (dir: 1 | -1) => void;
  soloSelected: () => void;
  stageSelected: () => void;
  destroySelected: () => void;
  selected: string | null;

  /** Engine state the `when` guards read. */
  panicked: boolean;
  staged: string | null;
  /** True while a MIDI-learn is armed — suspends command-issuing hotkeys. */
  midiLearning: boolean;
}

/** A single keymap binding (FR-1). */
export interface Binding {
  id: string;
  /** Layout-aware key match(es) — `KeyboardEvent.key` values (FR-4/Q4: `?`). */
  keys: string[];
  /** Required modifier (Shift only, for the dangerous/reserved combos). */
  shift?: boolean;
  scope: Scope;
  group: Group;
  label: string;
  /** Human-facing key hint for the cheatsheet + tooltips (FR-8). */
  hint: string;
  /** Predicate gating whether this binding is currently active (FR-7 etc.). */
  when?: (c: KeymapContext) => boolean;
  /** Does this binding issue an engine command? Suspended while MIDI-learn armed. */
  command?: boolean;
  /** Dangerous (COMMIT/destroy) — needs press-again confirmation (FR-7). */
  confirm?: boolean;
  /**
   * Don't `preventDefault` — let the platform/MUI also handle the key. Used by
   * the popover-scope Escape so MUI's own modal `onClose` still fires (the
   * registry just CLAIMS the key so the global Escape doesn't also leave preview).
   */
  passive?: boolean;
  run: (c: KeymapContext) => void;
}

/** A keystroke is swallowed when focus is in a text-entry field (FR-3). */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement
  ) {
    return true;
  }
  return target.isContentEditable;
}

/**
 * The active scope at this instant, by priority (FR-2): a mounted MUI
 * popover/dialog wins; else a focused param panel; else global. Read from the
 * live DOM so it needs no extra plumbing — MUI popovers/dialogs mount a
 * `.MuiModal-root` (Popover/Dialog/Menu) into a portal.
 */
export function activeScope(doc: Document = document): Scope {
  // A Popover/Dialog/Menu mounts an open MUI modal/popover root.
  if (doc.querySelector(".MuiPopover-root, .MuiDialog-root, .MuiMenu-root")) return "popover";
  const active = doc.activeElement;
  if (active instanceof HTMLElement && active.closest("#panel")) return "panel";
  return "global";
}

/** A binding fires in scope `s` if its declared scope ≤ the active scope chain. */
function scopeAllows(binding: Binding, active: Scope): boolean {
  // popover scope only fires while a popover is open; panel fires in panel OR
  // popover (a panel binding still makes sense with a popover open? No — popover
  // is exclusive). global fires only when nothing more specific is active.
  if (binding.scope === "popover") return active === "popover";
  if (binding.scope === "panel") return active === "panel";
  return active === "global";
}

/** Does this event match this binding's key + modifier requirements? */
function matches(binding: Binding, e: KeyboardEvent): boolean {
  if (!binding.keys.includes(e.key)) return false;
  // Shift is significant only when the binding asks for it (or asks NOT to). `?`
  // already requires Shift on US layouts but we match by `key` so it's implicit.
  if (binding.shift === true && !e.shiftKey) return false;
  if (binding.shift === false && e.shiftKey) return false;
  // Never shadow browser/OS essentials (NFR-4): bail on Ctrl/Meta/Alt combos.
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  return true;
}

/**
 * Resolve the one binding (if any) that should fire for this event, given the
 * registry, the live context, and the active scope. Exported for unit tests.
 */
export function resolveBinding(
  bindings: readonly Binding[],
  e: KeyboardEvent,
  c: KeymapContext,
  active: Scope = activeScope(),
): Binding | null {
  for (const b of bindings) {
    if (!matches(b, e)) continue;
    if (!scopeAllows(b, active)) continue;
    if (b.when && !b.when(c)) continue;
    // Command-issuing hotkeys are suspended while a MIDI-learn is armed (edge
    // case): a stray `s`/`c` must not stage/commit mid-learn. Non-command keys
    // (Escape, the cheatsheet, view toggles) still work.
    if (b.command && c.midiLearning) continue;
    return b;
  }
  return null;
}

/**
 * Install the single delegated keydown listener (NFR-2). `ctxRef` holds the
 * freshest {@link KeymapContext} so the listener identity stays stable while the
 * bindings still see current state. `confirmRef` tracks the pending
 * dangerous-action confirmation (press-again-to-confirm, FR-7).
 */
export function useKeymap(bindings: readonly Binding[], getContext: () => KeymapContext): void {
  const ctxRef = useRef(getContext);
  ctxRef.current = getContext;
  // Pending confirm: the id of a dangerous binding awaiting a second press, and
  // a timer that clears it after the window lapses.
  const pending = useRef<{ id: string; timer: number } | null>(null);

  useEffect(() => {
    const CONFIRM_MS = 1500;
    const clearPending = () => {
      if (pending.current) {
        window.clearTimeout(pending.current.timer);
        pending.current = null;
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return; // FR-3 typing guard
      const c = ctxRef.current();
      const b = resolveBinding(bindings, e, c);
      if (!b) return;
      // Dangerous actions: a single stray keystroke must not fire (FR-7). The
      // first press arms a confirm; a second press of the SAME binding within
      // the window runs it. Shift+<key> also confirms immediately (a deliberate
      // two-finger press). PANIC is intentionally NOT confirm:true — speed > a
      // confirm step for the emergency hatch.
      if (b.confirm && !e.shiftKey) {
        if (pending.current?.id === b.id) {
          clearPending();
          e.preventDefault();
          b.run(c);
          return;
        }
        clearPending();
        const timer = window.setTimeout(() => {
          pending.current = null;
        }, CONFIRM_MS);
        pending.current = { id: b.id, timer };
        e.preventDefault();
        return;
      }
      clearPending();
      if (!b.passive) e.preventDefault();
      b.run(c);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      clearPending();
    };
  }, [bindings]);
}
