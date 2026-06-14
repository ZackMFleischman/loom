import { Color, float, mix, uniform, vec4 } from "./tsl";
import type { Node } from "./tsl";
import type { Updater } from "./buildctx";
import { Manifest, normalizeHex, type Param } from "./param";
import { PALETTE_SOURCE_PATH, paletteStopPath } from "./paths";

/**
 * Global color palettes (R7): two named palettes, five ordered color stops
 * each, living on a globals-side Manifest (palette.primary.0 …) served
 * through the same "globals" pseudo-instance path as the input rack.
 * Roles on indices (0 bg · 1 edge · 2/3 core · 4 accent) are documented
 * convention, not kernel vocabulary (R7.1).
 */

export type PaletteSource = "primary" | "secondary";
export const PALETTE_STOPS = 5;
export const PALETTE_SOURCES = ["primary", "secondary", "own"] as const;

const DEFAULTS: Record<PaletteSource, string[]> = {
  primary: ["#0b1026", "#1a4a5f", "#2ec4b6", "#9b5de5", "#f15bb5"], // night teal→magenta
  secondary: ["#1a0b16", "#641220", "#c9184a", "#ff758f", "#ffd166"], // ember
};

export class PaletteRegistry {
  readonly manifest = new Manifest();
  private readonly stopParams: Record<PaletteSource, Param<string>[]> = {
    primary: [],
    secondary: [],
  };

  constructor() {
    for (const source of ["primary", "secondary"] as const) {
      for (let i = 0; i < PALETTE_STOPS; i++) {
        this.stopParams[source].push(
          this.manifest.color(paletteStopPath(source, i), {
            default: DEFAULTS[source][i]!,
            description: `${source} palette stop ${i}`,
          }),
        );
      }
    }
  }

  /** Current stop values, in order. */
  stops(source: PaletteSource): string[] {
    return this.stopParams[source].map((p) => p.value);
  }
}

/** Fill an RGBA byte ramp (width = data.length/4) with a piecewise-linear gradient. */
export function fillRamp(data: Uint8Array, stops: string[]): void {
  const rgb = stops.map((s) => {
    const hex = normalizeHex(s) ?? "#000000";
    return [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
    ];
  });
  const segs = rgb.length - 1;
  const width = data.length / 4;
  for (let x = 0; x < width; x++) {
    const t = (x / (width - 1)) * segs;
    const i = Math.min(Math.floor(t), segs - 1);
    const fr = t - i;
    for (let c = 0; c < 3; c++) {
      data[x * 4 + c] = Math.round(rgb[i]![c]! + (rgb[i + 1]![c]! - rgb[i]![c]!) * fr);
    }
    data[x * 4 + 3] = 255;
  }
}

/** Neutral fallback when no registry is wired and the scene has no own stops (bare unit-test builds). */
const GRAY: string[] = ["#000000", "#404040", "#808080", "#bfbfbf", "#ffffff"];

/**
 * The scene-side palette surface (ctx.palette). Collects color uniforms and
 * at most one 256×1 ramp texture during build; finalize() (called by
 * buildInstance after build()) declares the palette.source param — deferred
 * so its default can honor own() — and registers ONE per-frame updater that
 * resolves the active stops and re-tints/re-uploads only on change.
 * Switching source or retuning a globals stop never rebuilds (R7.2).
 */
export class PaletteCtxImpl {
  private readonly colorUniforms = new Map<number, ReturnType<typeof uniform>>();
  private ownStops: string[] | null = null;
  private used = false;

  constructor(
    private readonly manifest: Manifest,
    private readonly updaters: Array<Updater>,
    private readonly registry?: PaletteRegistry,
  ) {}

  /** Stop i of the active palette as a color uniform (vec3 in TSL expressions). */
  color(i: number): Node<"vec3"> {
    if (!Number.isInteger(i) || i < 0 || i >= PALETTE_STOPS) {
      throw new Error(`ctx.palette.color(${i}): stop index must be an int in 0..${PALETTE_STOPS - 1}`);
    }
    this.used = true;
    let u = this.colorUniforms.get(i);
    if (!u) {
      u = uniform(new Color("#000000"));
      this.colorUniforms.set(i, u);
    }
    // uniform(Color) is a vec3 uniform; the loose ReturnType collapses overloads.
    return u as unknown as Node<"vec3">;
  }

  /**
   * Gradient across the 5 stops; t in 0..1 (a TSL node or constant). Returns vec4.
   *
   * Built in-shader from the stop UNIFORMS via sequential mix() — NOT a ramp
   * texture. A texture() sample built inside a TSL Fn() function-scope isn't
   * collected into the material's sampler bindings (three's node backend), so it
   * silently renders black; uniforms cross the Fn boundary fine. So this works
   * everywhere a raymarch/escape-time shader needs it. The stops interpolate in
   * linear space (three converts the sRGB hex on the way into the uniform),
   * matching how ctx.palette.color(i) already composites.
   */
  ramp(t: Node<"float"> | number): Node<"vec4"> {
    // color(i) registers each stop uniform so finalize()'s updater fills it.
    const stops = Array.from({ length: PALETTE_STOPS }, (_, i) => this.color(i));
    const tn = typeof t === "number" ? float(t) : t;
    const s = tn.clamp(0, 1).mul(PALETTE_STOPS - 1);
    let c: Node<"vec3"> = stops[0]!;
    for (let i = 1; i < PALETTE_STOPS; i++) {
      c = mix(c, stops[i]!, s.sub(i - 1).clamp(0, 1));
    }
    return vec4(c, 1) as unknown as Node<"vec4">;
  }

  /** Scene-default stops — exactly 5 "#rrggbb" strings; the "own" source. Once per build. */
  own(stops: string[]): void {
    if (this.ownStops) throw new Error("ctx.palette.own() may only be called once per build");
    if (stops.length !== PALETTE_STOPS) {
      throw new Error(`ctx.palette.own() needs exactly ${PALETTE_STOPS} stops (got ${stops.length})`);
    }
    this.ownStops = stops.map((s) => {
      const hex = normalizeHex(s);
      if (hex == null) throw new Error(`ctx.palette.own(): bad stop ${JSON.stringify(s)} — expected "#rrggbb"`);
      return hex;
    });
    this.used = true;
  }

  /** Declare palette.source + the resolver updater. Called once, after build(). */
  finalize(): void {
    if (!this.used) return;
    const source = this.manifest.int(PALETTE_SOURCE_PATH, {
      default: this.ownStops ? 2 : 0,
      min: 0,
      max: 2,
      step: 1,
      labels: [...PALETTE_SOURCES],
      description: "active palette: primary / secondary / own (scene defaults)",
    });
    let lastKey = "";
    const upd: Updater = () => {
      const name = PALETTE_SOURCES[source.value] ?? "primary";
      const stops =
        name === "own"
          ? (this.ownStops ?? this.registry?.stops("primary") ?? GRAY)
          : (this.registry?.stops(name) ?? this.ownStops ?? GRAY);
      const key = stops.join(",");
      if (key === lastKey) return;
      lastKey = key;
      for (const [i, u] of this.colorUniforms) (u.value as Color).set(stops[i]!);
    };
    upd.label = "palette";
    this.updaters.push(upd);
  }
}
