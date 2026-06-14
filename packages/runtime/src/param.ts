import { z } from "zod";
import { channelsToHex, COLOR_CHANNELS, hexToChannels, type ColorSpace } from "./colorspace";
import { Signal } from "./signal";

export type ParamType = "float" | "int" | "bool" | "color";

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Normalize a CSS hex color to lowercase "#rrggbb"; null if unparseable. */
export function normalizeHex(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = HEX_RE.exec(v.trim());
  if (!m) return null;
  let hex = m[1]!.toLowerCase();
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  return `#${hex}`;
}

const RangedSpec = z
  .object({
    default: z.number(),
    min: z.number(),
    max: z.number(),
    step: z.number().positive().optional(),
    /** Optional value names for int selectors (index = value - min); UI renders a toggle. */
    labels: z.array(z.string().min(1)).optional(),
    /**
     * Optional color previews for a palette-index slider: one ordered list of
     * "#rrggbb" stops per selectable option (option k = the gradient at value
     * floor(min)+k). When present, the Console renders a palette chooser — a
     * column of gradient swatches you pick visually — over the bare slider, so
     * you never select a palette by number to discover its colors (R7.3).
     */
    swatches: z.array(z.array(z.string().refine((s) => HEX_RE.test(s.trim()), 'swatch stops must be "#rrggbb"')).min(2)).optional(),
    /**
     * Drop this param from the default Console params box (it stays fully live —
     * persisted, MIDI-bindable, modulatable, set_param-able — and is revealed by
     * the panel's "advanced" toggle). For machinery a scene never asked for, like
     * the auto-declared per-instance input trim (`input.<name>.amount`).
     */
    hidden: z.boolean().optional(),
    description: z.string().optional(),
  })
  .refine((s) => s.min <= s.max, { message: "min must be <= max" })
  .refine((s) => s.default >= s.min && s.default <= s.max, {
    message: "default must be inside [min, max]",
  });

const BoolSpec = z.object({
  default: z.boolean(),
  description: z.string().optional(),
});

const ColorSpec = z.object({
  default: z
    .string()
    .refine((s) => normalizeHex(s) != null, { message: 'color default must be "#rrggbb"' }),
  description: z.string().optional(),
});

export type RangedParamSpec = z.infer<typeof RangedSpec>;
export type BoolParamSpec = z.infer<typeof BoolSpec>;
export type ColorParamSpec = z.infer<typeof ColorSpec>;

export class Param<T> {
  /**
   * Effective numeric bounds for float/int params (undefined for bool/color).
   * These start at the author-declared range but can be widened or narrowed
   * live (TouchDesigner-style) — clamp, MIDI mapping and cycle all read them.
   */
  private lo?: number;
  private hi?: number;
  /** The author-declared baseline, for reset and "is this overridden?" checks. */
  private readonly declaredLo?: number;
  private readonly declaredHi?: number;
  /**
   * Color decomposition (R7.4): "hex" is a plain pickable color; "hsv"/"rgb"
   * means the live value is recomposed each read from three channel params
   * (each an ordinary modulatable/MIDI-bindable float). Set via
   * Manifest.setColorSpace, which owns the channel params' lifecycle.
   */
  private colorSpaceVal: ColorSpace = "hex";
  private channelParams: Param<number>[] | null = null;

  constructor(
    readonly path: string,
    readonly type: ParamType,
    private readonly clampFn: (v: T) => T,
    private readonly meta: Record<string, unknown>,
    private v: T,
  ) {
    if ((type === "float" || type === "int") && typeof meta.min === "number" && typeof meta.max === "number") {
      this.lo = this.declaredLo = meta.min;
      this.hi = this.declaredHi = meta.max;
    }
  }

  get value(): T {
    // Decomposed color: the channels are the source of truth (a modulator or
    // MIDI may be driving them) — recompose on every read.
    if (this.channelParams && this.colorSpaceVal !== "hex") {
      return channelsToHex(this.colorSpaceVal, [
        this.channelParams[0]!.value,
        this.channelParams[1]!.value,
        this.channelParams[2]!.value,
      ]) as unknown as T;
    }
    return this.v;
  }

  set(next: T): void {
    // Editing a decomposed color (the picker) writes back through its channels
    // so the channel sliders, modulators and bindings stay in sync.
    if (this.channelParams && this.colorSpaceVal !== "hex") {
      const hex = this.clampFn(next) as unknown as string;
      const ch = hexToChannels(hex, this.colorSpaceVal);
      for (let i = 0; i < 3; i++) this.channelParams[i]!.set(ch[i]!);
      this.v = hex as unknown as T;
      return;
    }
    this.v = this.clamp(next);
  }

  /** Current color decomposition ("hex" when not decomposed). */
  get colorSpace(): ColorSpace {
    return this.colorSpaceVal;
  }

  /** Bind this color to three channel params (Manifest.setColorSpace owns this). */
  attachChannels(space: "hsv" | "rgb", channels: Param<number>[]): void {
    this.colorSpaceVal = space;
    this.channelParams = channels;
  }

  /** Collapse back to a plain pickable color. */
  detachChannels(): void {
    this.colorSpaceVal = "hex";
    this.channelParams = null;
  }

  /** Clamp to the live effective range (numeric) or the type's clamp (bool/color). */
  private clamp(next: T): T {
    if (this.lo === undefined) return this.clampFn(next);
    let n = Math.min(this.hi!, Math.max(this.lo, next as unknown as number));
    if (this.type === "int") n = Math.round(n);
    return n as unknown as T;
  }

  /** Live view of the param; reflects later set() calls. */
  signal(): Signal<T> {
    const s = new Signal(() => this.v);
    s.label = this.path; // so uniformOf attributes cost to this param path
    return s;
  }

  /**
   * Set from a normalized 0..1 value (MIDI CC, faders): floats/ints map onto
   * the live [min, max], bools flip at 0.5. The regular clamp still applies.
   */
  setNormalized(v01: number): void {
    const v = Math.min(1, Math.max(0, v01));
    if (this.type === "bool") {
      this.set((v >= 0.5) as unknown as T);
      return;
    }
    if (this.lo === undefined) return; // color: a 0..1 CC has no honest mapping — ignore
    this.set((this.lo + v * (this.hi! - this.lo)) as unknown as T);
  }

  /**
   * One button press (cycle-mode bindings): ints advance and wrap max→min,
   * bools flip, floats/colors hold — a float has no honest "next" value.
   * Advances by exactly 1 regardless of the spec's declared `step` field
   * (that field is a slider UI hint, not a cycle increment). Wraps across the
   * live effective range.
   */
  cycle(): void {
    if (this.type === "bool") {
      this.set(!(this.v as boolean) as unknown as T);
      return;
    }
    if (this.type !== "int") return;
    const next = (this.v as number) + 1;
    this.set((next > this.hi! ? this.lo! : next) as unknown as T);
  }

  /** Effective numeric range [min, max], or null for bool/color params. */
  range(): [number, number] | null {
    return this.lo === undefined ? null : [this.lo, this.hi!];
  }

  /**
   * A range is editable when it's numeric AND not a labelled selector (an int
   * with `labels` renders as a toggle, so widening its bounds is meaningless).
   */
  get rangeable(): boolean {
    return this.lo !== undefined && this.meta.labels === undefined;
  }

  /** True once the effective range diverges from the author-declared baseline. */
  get rangeOverridden(): boolean {
    return this.lo !== undefined && (this.lo !== this.declaredLo || this.hi !== this.declaredHi);
  }

  /**
   * Widen or narrow the live numeric range (TouchDesigner-style). Re-clamps the
   * current value into the new bounds. Inverted args are swapped; int bounds
   * snap to integers. Throws for bool/color (no range to set).
   */
  setRange(min: number, max: number): void {
    if (this.lo === undefined) {
      throw new Error(`param "${this.path}" (${this.type}) has no numeric range to set`);
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      throw new Error(`range bounds for "${this.path}" must be finite numbers`);
    }
    if (min > max) [min, max] = [max, min];
    if (this.type === "int") {
      min = Math.round(min);
      max = Math.round(max);
      if (min === max) max = min + 1; // an int range needs at least two values
    }
    if (min === max) {
      throw new Error(`range for "${this.path}" must have min < max (got ${min})`);
    }
    this.lo = min;
    this.hi = max;
    this.meta.min = min; // toJSON spreads meta, so the wire range tracks the edit
    this.meta.max = max;
    this.v = this.clamp(this.v);
  }

  /** Restore the author-declared range, re-clamping the current value. */
  resetRange(): void {
    if (this.declaredLo === undefined) return;
    this.setRange(this.declaredLo, this.declaredHi!);
  }

  toJSON(): Record<string, unknown> {
    // `value` reads through the getter so a decomposed color reports its live
    // recomposed hex (the channels may be modulating it).
    const out: Record<string, unknown> = { type: this.type, ...this.meta, value: this.value };
    // Only carried when widened/narrowed — keeps the default manifest shape (and
    // its tests) untouched, and doubles as the UI's "range is overridden" flag.
    if (this.rangeOverridden) out.defaultRange = [this.declaredLo, this.declaredHi];
    // The UI's expand/collapse state for a color param (channels render inline).
    if (this.type === "color") out.colorSpace = this.colorSpaceVal;
    return out;
  }
}

/** The flat set of an instance's Params. UI, MIDI, and agents bind to this. */
export class Manifest {
  private readonly params = new Map<string, Param<unknown>>();

  float(path: string, spec: z.input<typeof RangedSpec>): Param<number> {
    const s = RangedSpec.parse(spec);
    // Numeric clamping lives in Param (it reads the live, possibly-widened range);
    // identity is enough here.
    return this.add(path, new Param<number>(path, "float", (v) => v, specMeta(s), s.default));
  }

  int(path: string, spec: z.input<typeof RangedSpec>): Param<number> {
    const s = RangedSpec.parse(spec);
    return this.add(path, new Param<number>(path, "int", (v) => v, specMeta(s), s.default));
  }

  bool(path: string, spec: z.input<typeof BoolSpec>): Param<boolean> {
    const s = BoolSpec.parse(spec);
    return this.add(path, new Param<boolean>(path, "bool", (v) => v, specMeta(s), s.default));
  }

  color(path: string, spec: z.input<typeof ColorSpec>): Param<string> {
    const s = ColorSpec.parse(spec);
    const def = normalizeHex(s.default)!;
    const clamp = (v: string) => {
      const hex = normalizeHex(v);
      if (hex == null) {
        throw new Error(`color param "${path}" expects "#rrggbb" (got ${JSON.stringify(v)})`);
      }
      return hex;
    };
    return this.add(path, new Param<string>(path, "color", clamp, specMeta({ ...s, default: def }), def));
  }

  /**
   * Decompose a color param into three 0..1 channel params (space "hsv"/"rgb"),
   * or collapse it back to a plain pickable color ("hex") — R7.4. Channels are
   * materialized at `<path>.<h|s|v|r|g|b>`, seeded from the color's live value,
   * and from then on are ordinary float params: modulatable, MIDI-bindable,
   * range-editable. The color recomposes from them on every read. Returns the
   * channel paths added and removed so the caller can clean up modulators and
   * bindings on the ones that vanished.
   */
  setColorSpace(path: string, space: ColorSpace): { added: string[]; removed: string[] } {
    const base = this.params.get(path);
    if (!base) throw new Error(`unknown param "${path}"`);
    if (base.type !== "color") {
      throw new Error(`"${path}" is ${base.type} — only color params decompose into channels`);
    }
    const liveHex = base.value as string; // recomposed if currently decomposed
    const removed: string[] = [];
    if (base.colorSpace !== "hex") {
      for (const ch of COLOR_CHANNELS[base.colorSpace]) {
        const cp = `${path}.${ch}`;
        if (this.params.delete(cp)) removed.push(cp);
      }
      base.detachChannels();
    }
    base.set(liveHex); // park the live color on the plain param (hex mode source)
    const added: string[] = [];
    if (space !== "hex") {
      const vals = hexToChannels(liveHex, space);
      const channels: Param<number>[] = [];
      COLOR_CHANNELS[space].forEach((ch, i) => {
        const cp = `${path}.${ch}`;
        const p = new Param<number>(
          cp,
          "float",
          (v) => v,
          specMeta({
            default: vals[i],
            min: 0,
            max: 1,
            step: 1 / 255,
            description: `${ch} channel of ${path}`,
            channelOf: path,
            channel: ch,
          }),
          vals[i]!,
        );
        this.add(cp, p as unknown as Param<unknown>);
        channels.push(p);
        added.push(cp);
      });
      base.attachChannels(space, channels);
    }
    return { added, removed };
  }

  /** Paths of currently-decomposed color params → their space (persisted shape). */
  colorSpaces(): Record<string, "hsv" | "rgb"> {
    const out: Record<string, "hsv" | "rgb"> = {};
    for (const [path, p] of this.params) {
      if (p.type === "color" && p.colorSpace !== "hex") out[path] = p.colorSpace;
    }
    return out;
  }

  /**
   * Re-apply persisted color decompositions (tuned state / Projects / HMR).
   * Apply BEFORE values() so the channel params exist to receive saved values.
   * Unknown or non-color paths are skipped.
   */
  applyColorSpaces(map: Record<string, unknown> | null | undefined): void {
    if (!map) return;
    for (const [path, space] of Object.entries(map)) {
      if (space !== "hsv" && space !== "rgb") continue;
      try {
        this.setColorSpace(path, space);
      } catch {
        // a persisted decomposition whose color no longer exists — skip it
      }
    }
  }

  get(path: string): Param<unknown> | undefined {
    return this.params.get(path);
  }

  paths(): string[] {
    return [...this.params.keys()];
  }

  /** Flat current values — the tuned-state shape persisted to state/. */
  values(): Record<string, number | boolean | string> {
    const out: Record<string, number | boolean | string> = {};
    for (const [path, p] of this.params) out[path] = p.value as number | boolean | string;
    return out;
  }

  /**
   * Per-path effective ranges that diverge from the declared spec — the
   * range-override shape persisted alongside values(). Empty until a slider's
   * bounds have been widened or narrowed.
   */
  rangeOverrides(): Record<string, [number, number]> {
    const out: Record<string, [number, number]> = {};
    for (const [path, p] of this.params) {
      if (!p.rangeOverridden) continue;
      const r = p.range();
      if (r) out[path] = r;
    }
    return out;
  }

  /**
   * Re-apply persisted range overrides (tuned state / Projects). Apply BEFORE
   * values() so a widened bound is in place to hold a value saved outside the
   * declared range. Unknown or malformed paths are skipped.
   */
  applyRanges(map: Record<string, unknown> | null | undefined): void {
    if (!map) return;
    for (const [path, r] of Object.entries(map)) {
      if (!Array.isArray(r) || r.length !== 2) continue;
      const [min, max] = r as [unknown, unknown];
      if (typeof min !== "number" || typeof max !== "number") continue;
      try {
        this.params.get(path)?.setRange(min, max);
      } catch {
        // a persisted override that no longer fits the param — keep the default
      }
    }
  }

  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [path, p] of this.params) out[path] = p.toJSON();
    return out;
  }

  private add<T>(path: string, param: Param<T>): Param<T> {
    if (this.params.has(path)) {
      throw new Error(`Manifest: duplicate param path "${path}"`);
    }
    this.params.set(path, param as Param<unknown>);
    return param;
  }
}

/** Spec fields for serialization, with undefined optionals dropped. */
function specMeta(spec: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(spec)) if (v !== undefined) out[k] = v;
  return out;
}
