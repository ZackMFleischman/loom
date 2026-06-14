import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GROUP_ORDER, hintFor, KEYBINDINGS } from "../../src/ui/console/keybindings";
import { HotkeyCheatsheet } from "../../src/ui/console/HotkeyCheatsheet";
import { activeScope, isTypingTarget, resolveBinding, type KeymapContext } from "../../src/ui/console/keymap";

// A no-op context with overridable fields (the registry's `run`/`when` read it).
function ctx(over: Partial<KeymapContext> = {}): KeymapContext {
  const noop = () => {};
  return {
    req: noop,
    toggleRack: noop,
    togglePreview: noop,
    togglePerf: noop,
    toggleAdvanced: noop,
    closeTopPopover: () => true,
    leaveOverlays: noop,
    capture: noop,
    toggleCheatsheet: noop,
    cheatsheetOpen: false,
    selectStep: noop,
    soloSelected: noop,
    stageSelected: noop,
    destroySelected: noop,
    selected: null,
    panicked: false,
    staged: null,
    midiLearning: false,
    ...over,
  };
}

function ev(key: string, mods: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return { key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...mods } as KeyboardEvent;
}

describe("isTypingTarget (FR-3)", () => {
  it("swallows keys in input / textarea / select / contenteditable", () => {
    expect(isTypingTarget(document.createElement("input"))).toBe(true);
    expect(isTypingTarget(document.createElement("textarea"))).toBe(true);
    expect(isTypingTarget(document.createElement("select"))).toBe(true);
    const ce = document.createElement("div");
    ce.setAttribute("contenteditable", "true");
    Object.defineProperty(ce, "isContentEditable", { value: true });
    expect(isTypingTarget(ce)).toBe(true);
  });
  it("passes through on a plain div and null", () => {
    expect(isTypingTarget(document.createElement("div"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe("activeScope (FR-2 priority)", () => {
  it("is global by default", () => {
    expect(activeScope(document)).toBe("global");
  });
  it("is popover when a MUI modal/popover is mounted", () => {
    const pop = document.createElement("div");
    pop.className = "MuiPopover-root";
    document.body.appendChild(pop);
    expect(activeScope(document)).toBe("popover");
    pop.remove();
  });
});

describe("resolveBinding (scope + guards)", () => {
  it("fires a global binding (i → rack) in global scope", () => {
    const b = resolveBinding(KEYBINDINGS, ev("i"), ctx(), "global");
    expect(b?.id).toBe("rack");
  });

  it("does NOT fire a global binding while a popover is active", () => {
    const b = resolveBinding(KEYBINDINGS, ev("i"), ctx(), "popover");
    expect(b).toBeNull();
  });

  it("routes Escape to the popover binding when a popover is open", () => {
    const b = resolveBinding(KEYBINDINGS, ev("Escape"), ctx(), "popover");
    expect(b?.id).toBe("esc-popover");
  });

  it("routes Escape to the global binding otherwise", () => {
    const b = resolveBinding(KEYBINDINGS, ev("Escape"), ctx(), "global");
    expect(b?.id).toBe("esc-global");
  });

  it("suspends command-issuing hotkeys while MIDI-learn is armed", () => {
    expect(resolveBinding(KEYBINDINGS, ev("s"), ctx({ midiLearning: true }), "global")).toBeNull();
    // Non-command keys still work while learning.
    expect(resolveBinding(KEYBINDINGS, ev("i"), ctx({ midiLearning: true }), "global")?.id).toBe("rack");
  });

  it("blocks COMMIT (Enter) when nothing is staged or while panicked", () => {
    expect(resolveBinding(KEYBINDINGS, ev("Enter"), ctx({ staged: null }), "global")).toBeNull();
    expect(resolveBinding(KEYBINDINGS, ev("Enter"), ctx({ staged: "a", panicked: true }), "global")).toBeNull();
    expect(resolveBinding(KEYBINDINGS, ev("Enter"), ctx({ staged: "a" }), "global")?.id).toBe("commit");
  });

  it("blocks live-step while panicked", () => {
    expect(resolveBinding(KEYBINDINGS, ev("["), ctx({ panicked: true }), "global")).toBeNull();
    expect(resolveBinding(KEYBINDINGS, ev("]"), ctx(), "global")?.id).toBe("live-next");
  });

  it("never fires on a Ctrl/Meta combo (NFR-4 — don't shadow OS keys)", () => {
    expect(resolveBinding(KEYBINDINGS, ev("i", { ctrlKey: true }), ctx(), "global")).toBeNull();
    expect(resolveBinding(KEYBINDINGS, ev("i", { metaKey: true }), ctx(), "global")).toBeNull();
  });

  it("separates s (stage) from Shift+S (capture)", () => {
    expect(resolveBinding(KEYBINDINGS, ev("s"), ctx(), "global")?.id).toBe("stage");
    expect(resolveBinding(KEYBINDINGS, ev("S", { shiftKey: true }), ctx(), "global")?.id).toBe("capture");
  });

  it("PANIC fires on `.` and toggles RESUME by state", () => {
    let cmd = "";
    const c = ctx({ panicked: false, req: (t) => (cmd = t) });
    resolveBinding(KEYBINDINGS, ev("."), c, "global")?.run(c);
    expect(cmd).toBe("panic");
    const c2 = ctx({ panicked: true, req: (t) => (cmd = t) });
    resolveBinding(KEYBINDINGS, ev("."), c2, "global")?.run(c2);
    expect(cmd).toBe("resume");
  });
});

describe("cheatsheet drift guard (FR-5)", () => {
  it("every binding has a non-empty label, hint, and a known group", () => {
    for (const b of KEYBINDINGS) {
      expect(b.label, b.id).toBeTruthy();
      expect(b.hint, b.id).toBeTruthy();
      expect(GROUP_ORDER, b.id).toContain(b.group);
    }
  });

  it("renders one row per distinct binding label (cannot drift)", () => {
    const { container } = render(<HotkeyCheatsheet onClose={() => {}} />);
    // Distinct labels = the rows the sheet shows (duplicate-label bindings, like
    // the two Escape entries, collapse to one row by design).
    const distinctLabels = new Set(KEYBINDINGS.map((b) => b.label));
    expect(container.querySelectorAll(".hk-row").length).toBe(distinctLabels.size);
  });

  it("hintFor sources the same hint the registry holds (FR-8)", () => {
    expect(hintFor("preview")).toBe("(p)");
    expect(hintFor("rack")).toBe("(i)");
    expect(hintFor("nonexistent")).toBe("");
  });
});
