import { normalizeHex } from "./param";

/**
 * Pure color-space math for decomposing a "#rrggbb" param into three
 * modulatable 0..1 channels and recomposing it (R7.4). HSV and RGB are the
 * two spaces a color can expand into; each channel becomes an ordinary float
 * param so the existing modulator + MIDI machinery drives it for free.
 * No three.js here — Param must stay renderer-agnostic.
 */

export type ColorSpace = "hex" | "hsv" | "rgb";

/** Channel letters per space, in param order. */
export const COLOR_CHANNELS: Record<"hsv" | "rgb", readonly [string, string, string]> = {
  hsv: ["h", "s", "v"],
  rgb: ["r", "g", "b"],
};

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const byte = (v: number) =>
  Math.round(clamp01(v) * 255)
    .toString(16)
    .padStart(2, "0");

/** "#rrggbb" → [r, g, b] in 0..1 (black on a bad hex — callers normalize first). */
export function hexToRgb01(hex: string): [number, number, number] {
  const h = normalizeHex(hex) ?? "#000000";
  return [
    parseInt(h.slice(1, 3), 16) / 255,
    parseInt(h.slice(3, 5), 16) / 255,
    parseInt(h.slice(5, 7), 16) / 255,
  ];
}

/** [r, g, b] in 0..1 → "#rrggbb". */
export function rgb01ToHex([r, g, b]: [number, number, number]): string {
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}

/** [r, g, b] 0..1 → [h, s, v] 0..1 (hue normalized to 0..1, wrapping). */
export function rgbToHsv([r, g, b]: [number, number, number]): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 1e-9) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  const s = max <= 1e-9 ? 0 : d / max;
  return [h, s, max];
}

/** [h, s, v] 0..1 → [r, g, b] 0..1. */
export function hsvToRgb([h, s, v]: [number, number, number]): [number, number, number] {
  const hh = (((h % 1) + 1) % 1) * 6;
  const c = v * s;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = v - c;
  let rgb: [number, number, number];
  if (hh < 1) rgb = [c, x, 0];
  else if (hh < 2) rgb = [x, c, 0];
  else if (hh < 3) rgb = [0, c, x];
  else if (hh < 4) rgb = [0, x, c];
  else if (hh < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return [rgb[0] + m, rgb[1] + m, rgb[2] + m];
}

/** Decompose "#rrggbb" into its three 0..1 channels for the given space. */
export function hexToChannels(hex: string, space: "hsv" | "rgb"): [number, number, number] {
  const rgb = hexToRgb01(hex);
  return space === "rgb" ? rgb : rgbToHsv(rgb);
}

/** Recompose "#rrggbb" from three 0..1 channels in the given space. */
export function channelsToHex(space: "hsv" | "rgb", ch: [number, number, number]): string {
  const c: [number, number, number] = [clamp01(ch[0]), clamp01(ch[1]), clamp01(ch[2])];
  return rgb01ToHex(space === "rgb" ? c : hsvToRgb(c));
}
