import type { Binding, Group } from "./keymap";

/**
 * The Console keymap — every binding as data (FR-1/FR-4). This array is the
 * single source of truth: {@link useKeymap} drives behavior from it and
 * {@link HotkeyCheatsheet} renders one row per entry from it, so the `?` overlay
 * cannot drift (FR-5). Button tooltips also source their `(p)`/`(i)` hints here
 * (FR-8) via {@link hintFor}.
 *
 * Each `run` delegates to an EXISTING handler/engine command — no new behavior
 * (NFR-1). Keys are matched layout-aware by `KeyboardEvent.key` (FR-4/Q4).
 */
export const KEYBINDINGS: readonly Binding[] = [
  // ── Transport ─────────────────────────────────────────────────────────────
  {
    id: "tap",
    keys: ["t"],
    scope: "global",
    group: "Transport",
    label: "Tap tempo",
    hint: "t",
    command: true,
    run: (c) => c.req("set_transport", { tap: true }),
  },

  // ── Panels / views ──────────────────────────────────────────────────────────
  {
    id: "rack",
    keys: ["i"],
    scope: "global",
    group: "Panels",
    label: "Toggle input rack",
    hint: "i",
    run: (c) => c.toggleRack(),
  },
  {
    id: "preview",
    keys: ["p"],
    scope: "global",
    group: "Panels",
    label: "Toggle preview",
    hint: "p",
    run: (c) => c.togglePreview(),
  },
  {
    id: "advanced",
    keys: ["a"],
    scope: "global",
    group: "Panels",
    label: "Toggle advanced params",
    hint: "a",
    run: (c) => c.toggleAdvanced(),
  },
  {
    id: "perf",
    keys: ["d"],
    scope: "global",
    group: "Panels",
    label: "Toggle perf overlay",
    hint: "d",
    run: (c) => c.togglePerf(),
  },

  // ── Stage ─────────────────────────────────────────────────────────────────
  {
    id: "live-prev",
    keys: ["["],
    scope: "global",
    group: "Stage",
    label: "Step LIVE ◀ prev",
    hint: "[",
    command: true,
    when: (c) => !c.panicked,
    run: (c) => c.req("live_step", { dir: -1 }),
  },
  {
    id: "live-next",
    keys: ["]"],
    scope: "global",
    group: "Stage",
    label: "Step LIVE ▶ next",
    hint: "]",
    command: true,
    when: (c) => !c.panicked,
    run: (c) => c.req("live_step", { dir: 1 }),
  },
  {
    id: "stage",
    keys: ["s"],
    scope: "global",
    group: "Stage",
    label: "Stage / unstage selected",
    hint: "s",
    command: true,
    run: (c) => c.stageSelected(),
  },
  {
    id: "unstage",
    keys: ["u"],
    scope: "global",
    group: "Stage",
    label: "Unstage",
    hint: "u",
    command: true,
    when: (c) => c.staged != null,
    run: (c) => c.req("unstage"),
  },
  {
    id: "commit",
    keys: ["c", "Enter"],
    scope: "global",
    group: "Stage",
    label: "COMMIT staged → live",
    hint: "c / ↵",
    command: true,
    confirm: true,
    // Honor the COMMIT button's own gate: nothing staged, or panicked → no-op.
    when: (c) => c.staged != null && !c.panicked,
    run: (c) => c.req("commit", {}),
  },

  // ── Tiles ─────────────────────────────────────────────────────────────────
  {
    id: "select-prev",
    keys: ["j", "ArrowLeft"],
    scope: "global",
    group: "Tiles",
    label: "Select prev tile",
    hint: "j / ←",
    run: (c) => c.selectStep(-1),
  },
  {
    id: "select-next",
    keys: ["k", "ArrowRight"],
    scope: "global",
    group: "Tiles",
    label: "Select next tile",
    hint: "k / →",
    run: (c) => c.selectStep(1),
  },
  {
    id: "solo",
    keys: ["f"],
    scope: "global",
    group: "Tiles",
    label: "Solo selected tile",
    hint: "f",
    when: (c) => c.selected != null,
    run: (c) => c.soloSelected(),
  },
  {
    id: "destroy",
    keys: ["x", "Delete", "Backspace"],
    scope: "global",
    group: "Tiles",
    label: "Destroy selected tile",
    hint: "x / ⌦",
    command: true,
    confirm: true,
    when: (c) => c.selected != null,
    run: (c) => c.destroySelected(),
  },

  // ── Safety ──────────────────────────────────────────────────────────────────
  {
    id: "panic",
    // `.` is the primary (hard to mistype, distinct); Shift+P is the alt. PANIC
    // is deliberately NOT confirm-gated — speed > a confirm step for the
    // emergency hatch (FR-7). Pressing it again RESUMEs (the button's behavior).
    keys: [".", "P"],
    scope: "global",
    group: "Safety",
    label: "PANIC / RESUME",
    hint: ". / ⇧P",
    command: true,
    run: (c) => c.req(c.panicked ? "resume" : "panic", {}),
  },
  {
    id: "capture",
    keys: ["S"],
    shift: true,
    scope: "global",
    group: "Safety",
    label: "Self-capture screenshot",
    hint: "⇧S",
    run: (c) => c.capture(),
  },

  // ── Help ──────────────────────────────────────────────────────────────────
  {
    id: "cheatsheet",
    // Layout-aware: match `?` by key (FR-4/Q4), not `Shift+/` by code.
    keys: ["?"],
    scope: "global",
    group: "Help",
    label: "Show / hide this cheatsheet",
    hint: "?",
    run: (c) => c.toggleCheatsheet(),
  },

  // ── Escape (scope-aware) ──────────────────────────────────────────────────
  // Highest-priority Escape: close the topmost popover/dialog. Lives in popover
  // scope so it only competes when a popover is open; MUI's own onClose also
  // fires, this is the belt to that braces (the registry routes to onClose).
  {
    id: "esc-popover",
    keys: ["Escape"],
    scope: "popover",
    group: "Help",
    label: "Close popover / dialog",
    hint: "Esc",
    // Passive: MUI's modal closes itself on Escape; the registry only claims the
    // key (popover scope wins) so the global Escape doesn't ALSO leave preview.
    passive: true,
    run: (c) => {
      c.closeTopPopover();
    },
  },
  // Global Escape: close the cheatsheet first, else leave preview/perf overlays
  // (the original ConsoleApp Escape behavior).
  {
    id: "esc-global",
    keys: ["Escape"],
    scope: "global",
    group: "Help",
    label: "Close cheatsheet / leave preview",
    hint: "Esc",
    run: (c) => {
      if (c.cheatsheetOpen) c.toggleCheatsheet();
      else c.leaveOverlays();
    },
  },
] as const;

/** Cheatsheet display order for groups (FR-5/FR-6 column layout). */
export const GROUP_ORDER: readonly Group[] = ["Transport", "Stage", "Tiles", "Panels", "Safety", "Help"];

/**
 * The key hint for a binding id, for button tooltips (FR-8) — e.g. `hintFor("preview")`
 * → `"(p)"`. Returns "" for an unknown id so callers can always append safely.
 */
export function hintFor(id: string): string {
  const b = KEYBINDINGS.find((x) => x.id === id);
  return b ? `(${b.hint})` : "";
}
