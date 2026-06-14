import { describe, expect, it } from "vitest";
import { fillRamp, PALETTE_STOPS, PaletteRegistry } from "../src/palette";
import { Manifest } from "../src/param";
import { PaletteCtxImpl } from "../src/palette";
import { F } from "./helpers";
import type { Color, DataTexture } from "three/webgpu";

describe("PaletteRegistry", () => {
  it("declares 5 color stops per palette on its manifest", () => {
    const reg = new PaletteRegistry();
    for (const source of ["primary", "secondary"] as const) {
      for (let i = 0; i < PALETTE_STOPS; i++) {
        const p = reg.manifest.get(`palette.${source}.${i}`);
        expect(p?.type).toBe("color");
      }
    }
    expect(reg.manifest.paths()).toHaveLength(PALETTE_STOPS * 2);
  });

  it("stops() reflects live set_param writes", () => {
    const reg = new PaletteRegistry();
    reg.manifest.get("palette.primary.2")!.set("#00ff00");
    expect(reg.stops("primary")[2]).toBe("#00ff00");
    expect(reg.stops("secondary")).toHaveLength(PALETTE_STOPS);
  });
});

describe("fillRamp", () => {
  it("interpolates piecewise-linearly across the stops", () => {
    const data = new Uint8Array(256 * 4);
    fillRamp(data, ["#000000", "#000000", "#ffffff", "#ffffff", "#ffffff"]);
    expect(data[0]).toBe(0); // left edge = stop 0
    expect(data[255 * 4]).toBe(255); // right edge = stop 4
    expect(data[3]).toBe(255); // alpha opaque
    // x=128 sits at t=2.008 of 4 → just past stop 2 → white
    expect(data[128 * 4]).toBeGreaterThan(250);
    // x=32 sits at t≈0.5 between two black stops → black
    expect(data[32 * 4]).toBe(0);
  });
});

type ColorUniform = { value: Color };

function makeCtx(reg = new PaletteRegistry()) {
  const manifest = new Manifest();
  const updaters: Array<(f: ReturnType<typeof F>) => void> = [];
  const pal = new PaletteCtxImpl(manifest, updaters, reg);
  return { manifest, updaters, pal, reg };
}

describe("PaletteCtxImpl", () => {
  it("declares palette.source on finalize, defaulting to primary (0) without own()", () => {
    const { manifest, pal } = makeCtx();
    pal.color(0);
    pal.finalize();
    const src = manifest.get("palette.source");
    expect(src?.type).toBe("int");
    expect(src?.value).toBe(0);
  });

  it("defaults palette.source to own (2) when the scene declared own stops", () => {
    const { manifest, pal } = makeCtx();
    pal.own(["#000000", "#111111", "#222222", "#333333", "#444444"]);
    pal.color(1);
    pal.finalize();
    expect(manifest.get("palette.source")?.value).toBe(2);
  });

  it("declares nothing when palette was never used", () => {
    const { manifest, pal } = makeCtx();
    pal.finalize();
    expect(manifest.get("palette.source")).toBeUndefined();
  });

  it("color(i) tracks the active source per frame, switching without rebuild", () => {
    const { manifest, updaters, pal, reg } = makeCtx();
    const u = pal.color(2) as unknown as ColorUniform;
    pal.finalize();
    const tick = (n: number) => updaters.forEach((up) => up(F(n)));
    tick(0);
    expect(`#${u.value.getHexString()}`).toBe(reg.stops("primary")[2]);
    manifest.get("palette.source")!.set(1); // flip to secondary — plain param write
    tick(1);
    expect(`#${u.value.getHexString()}`).toBe(reg.stops("secondary")[2]);
  });

  it("a globals stop edit retints consumers on the next pull", () => {
    const { updaters, pal, reg } = makeCtx();
    const u = pal.color(0) as unknown as ColorUniform;
    pal.finalize();
    updaters.forEach((up) => up(F(0)));
    reg.manifest.get("palette.primary.0")!.set("#ff0000");
    updaters.forEach((up) => up(F(1)));
    expect(u.value.getHexString()).toBe("ff0000");
  });

  it("own falls back to primary when no own stops were declared", () => {
    const { manifest, updaters, pal, reg } = makeCtx();
    const u = pal.color(4) as unknown as ColorUniform;
    pal.finalize();
    manifest.get("palette.source")!.set(2);
    updaters.forEach((up) => up(F(0)));
    expect(`#${u.value.getHexString()}`).toBe(reg.stops("primary")[4]);
  });

  it("ramp() re-uploads its texture only when the resolved stops change", () => {
    const { manifest, updaters, pal } = makeCtx();
    pal.ramp(0.5);
    pal.finalize();
    const tex = pal.rampTexture() as DataTexture;
    updaters.forEach((up) => up(F(0)));
    const after1 = tex.version;
    updaters.forEach((up) => up(F(1)));
    expect(tex.version).toBe(after1); // unchanged stops → no re-upload
    manifest.get("palette.source")!.set(1);
    updaters.forEach((up) => up(F(2)));
    expect(tex.version).toBeGreaterThan(after1);
  });

  it("own() validates: 5 stops, hex format, once per build", () => {
    const { pal } = makeCtx();
    expect(() => pal.own(["#000000"])).toThrow(/5/);
    const good = ["#000000", "#111111", "#222222", "#333333", "#444444"];
    pal.own(good);
    expect(() => pal.own(good)).toThrow(/once/);
  });

  it("color(i) validates the stop index", () => {
    const { pal } = makeCtx();
    expect(() => pal.color(5)).toThrow();
    expect(() => pal.color(-1)).toThrow();
  });
});
