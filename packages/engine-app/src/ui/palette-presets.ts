/**
 * Named 5-stop palette presets for the global palettes (stop roles by
 * convention: 0 bg · 1 edge · 2/3 core · 4 accent). Built-ins ship curated;
 * "save as" writes the current stops to localStorage under a name (user
 * presets shadow built-ins on collision).
 */
export type PaletteStops = [string, string, string, string, string];

const KEY = "loom.palettepresets";

const BUILTINS: Record<string, PaletteStops> = {
  ember: ["#0b0503", "#4a1c0e", "#c2470f", "#f08c1b", "#ffd9a0"],
  neon: ["#05010d", "#2d0b5a", "#e3119d", "#28e0c9", "#f8f6ff"],
  ocean: ["#02060d", "#0a3550", "#1380a0", "#38c5b9", "#d8f7ff"],
  "violet bloom": ["#070310", "#2a1058", "#7a3cc8", "#c989f2", "#ffe9fe"],
  verdant: ["#020803", "#103a1c", "#2e8b46", "#7fd069", "#f2ffd8"],
  mono: ["#000000", "#333333", "#888888", "#cccccc", "#ffffff"],
};

function loadUser(): Record<string, PaletteStops> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, PaletteStops>;
  } catch {
    return {};
  }
}

export function listPresets(): string[] {
  return [...new Set([...Object.keys(BUILTINS), ...Object.keys(loadUser())])];
}

export function getPreset(name: string): PaletteStops | undefined {
  return loadUser()[name] ?? BUILTINS[name];
}

export function savePreset(name: string, stops: PaletteStops): void {
  const user = loadUser();
  user[name] = stops;
  try {
    localStorage.setItem(KEY, JSON.stringify(user));
  } catch {
    // storage unavailable — the save just won't survive a reload
  }
}

/** The preset these stops currently equal, if any (case-insensitive hex). */
export function matchPreset(stops: string[]): string | undefined {
  const norm = stops.map((s) => s.toLowerCase());
  return listPresets().find((name) =>
    getPreset(name)!.every((hex, i) => hex.toLowerCase() === norm[i]),
  );
}
