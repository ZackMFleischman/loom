import { describe, expect, it } from "vitest";
import {
  channelsToHex,
  hexToChannels,
  hexToRgb01,
  hsvToRgb,
  rgb01ToHex,
  rgbToHsv,
} from "../src/colorspace";

describe("colorspace", () => {
  it("round-trips hex ↔ rgb01", () => {
    for (const hex of ["#000000", "#ffffff", "#2ec4b6", "#f15bb5", "#123456"]) {
      expect(rgb01ToHex(hexToRgb01(hex))).toBe(hex);
    }
  });

  it("round-trips rgb ↔ hsv on primaries", () => {
    const cases: [number, number, number][] = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [1, 1, 0],
      [0, 1, 1],
      [1, 0, 1],
      [0, 0, 0],
      [1, 1, 1],
      [0.3, 0.6, 0.2],
    ];
    for (const rgb of cases) {
      const back = hsvToRgb(rgbToHsv(rgb));
      for (let i = 0; i < 3; i++) expect(back[i]).toBeCloseTo(rgb[i]!, 5);
    }
  });

  it("decomposes and recomposes a hex through both spaces", () => {
    for (const hex of ["#2ec4b6", "#641220", "#ffd166", "#0b1026"]) {
      for (const space of ["hsv", "rgb"] as const) {
        const ch = hexToChannels(hex, space);
        expect(ch.every((c) => c >= 0 && c <= 1)).toBe(true);
        expect(channelsToHex(space, ch)).toBe(hex);
      }
    }
  });

  it("pure red is hue 0, full saturation and value (hsv channels)", () => {
    const [h, s, v] = hexToChannels("#ff0000", "hsv");
    expect(h).toBeCloseTo(0, 5);
    expect(s).toBeCloseTo(1, 5);
    expect(v).toBeCloseTo(1, 5);
  });

  it("clamps out-of-range channels when recomposing", () => {
    expect(channelsToHex("rgb", [2, -1, 0.5])).toBe("#ff0080");
  });
});
