import { fillRamp, PALETTE_STOPS, type BuildCtx } from "@loom/runtime";
import { texture, uniform, vec2 } from "three/tsl";
import { Color, DataTexture, LinearFilter, SRGBColorSpace, type Node } from "three/webgpu";

/**
 * A scene-side palette CHOOSER that goes beyond the built-in `palette.source`
 * (which exposes only one active global at a time): it offers the two global
 * palettes — **primary** and **secondary**, read live so they retint when the
 * globals rack is retuned — followed by any number of scene presets, all on a
 * single swatched int param the Console draws as a visual chooser (R7.3).
 *
 * Returns the same `color(i)` / `ramp(t)` surface as `ctx.palette`, so a scene
 * colorizes through it identically — just with a richer choice list. Switching
 * the choice (or retuning a selected global) never rebuilds: one per-frame
 * updater re-tints the uniforms + ramp only when the active stops change.
 */

const GRAY = ["#000000", "#404040", "#808080", "#bfbfbf", "#ffffff"];

export interface PalettePreset {
  /** Label shown in the chooser. */
  name: string;
  /** Exactly five "#rrggbb" stops (roles: 0 bg · 1 edge · 2/3 core · 4 accent). */
  stops: string[];
}

export interface PalettePick {
  /** Stop `i` of the active palette as a vec3 (like `ctx.palette.color`). */
  color(i: number): Node<"vec3">;
  /** Gradient lookup across the five stops; t in 0..1 → vec4 (like `ctx.palette.ramp`). */
  ramp(t: Node<"float"> | number): Node<"vec4">;
}

type Option = { name: string; global: "primary" | "secondary" } | { name: string; stops: string[] };

/**
 * Declare a `<path>` int param (default `palette.pick`) listing
 * [Primary, Secondary, ...presets] and wire its live color uniforms + ramp.
 */
export function pickPalette(ctx: BuildCtx, presets: PalettePreset[], path = "palette.pick"): PalettePick {
  const options: Option[] = [
    { name: "Primary", global: "primary" },
    { name: "Secondary", global: "secondary" },
    ...presets.map((p) => ({ name: p.name, stops: p.stops })),
  ];
  const stopsOf = (o: Option): string[] =>
    "stops" in o ? o.stops : (ctx.palettes?.stops(o.global) ?? GRAY);

  const param = ctx.int(path, {
    default: presets.length ? 2 : 0, // first scene preset, else Primary
    min: 0,
    max: options.length - 1,
    step: 1,
    labels: options.map((o) => o.name),
    // Visual chooser: a gradient swatch per option (globals snapshot their stops).
    swatches: options.map((o) => stopsOf(o)),
    description: "active palette: global primary/secondary or a scene preset",
  });

  const colors = Array.from({ length: PALETTE_STOPS }, () => uniform(new Color("#000000")));
  const rampData = new Uint8Array(256 * 4);
  const rampTex = new DataTexture(rampData, 256, 1);
  rampTex.minFilter = LinearFilter;
  rampTex.magFilter = LinearFilter;
  rampTex.colorSpace = SRGBColorSpace; // stops are sRGB hex; sampling converts
  rampTex.needsUpdate = true;

  let lastKey = "";
  const upd = () => {
    const opt = options[param.value] ?? options[0]!;
    const stops = stopsOf(opt);
    const key = `${param.value}|${stops.join(",")}`; // re-tints if the choice or a live global changes
    if (key === lastKey) return;
    lastKey = key;
    for (let i = 0; i < PALETTE_STOPS; i++) (colors[i]!.value as Color).set(stops[i] ?? "#000000");
    fillRamp(rampData, stops);
    rampTex.needsUpdate = true;
  };
  upd.label = "palette";
  ctx.updaters.push(upd);

  return {
    color: (i: number) => colors[i] as unknown as Node<"vec3">,
    ramp: (t: Node<"float"> | number) => texture(rampTex, vec2(t, 0.5)) as unknown as Node<"vec4">,
  };
}
