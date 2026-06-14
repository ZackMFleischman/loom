import { z } from "zod";
import type { FrameCtx } from "./frame";
import type { AudioBusLike } from "./inputbus/audio";
import type { MidiBusLike } from "./inputbus/midi";
import { Manifest, type Param } from "./param";
import { rackKnobPath } from "./paths";
import { Signal } from "./signal";

/**
 * The input rack: every input the instrument reacts to is a NAMED, tunable
 * channel in one global registry (R6). Channels are code-defined in
 * content/inputs.ts via defineInputs (typed, in git, agent-growable); their
 * tunings live on a global Manifest served as pseudo-instance "globals".
 * Consumption is late-bound (ctx.input("kick") resolves per pull), so
 * retuning or redefining channels never rebuilds an instance.
 */

const NAME_RE = /^[a-z][a-zA-Z0-9]*$/;

const LevelOptsSchema = z.object({
  band: z.enum(["bass", "mid", "treble", "rms"]),
  gain: z.number().min(0).max(4).default(1),
  floor: z.number().min(0).max(1).default(0),
  lag: z.number().min(0).max(1).default(0.05),
});

const OnsetOptsSchema = z.object({
  band: z.enum(["bass", "mid", "treble"]),
  threshold: z.number().min(0).max(1).default(0.3),
  decay: z.number().min(0.01).max(2).default(0.15),
  gain: z.number().min(0).max(4).default(1),
  /** Code-level detector knobs (not rack params): */
  rise: z.number().default(0.08),
  refractoryMs: z.number().default(120),
});

const CcOptsSchema = z.object({
  cc: z.number().int().min(0).max(127),
  ch: z.number().int().min(0).max(15).optional(),
  gain: z.number().min(0).max(4).default(1),
});

export type LevelChannelOpts = z.input<typeof LevelOptsSchema>;
export type OnsetChannelOpts = z.input<typeof OnsetOptsSchema>;
export type CcChannelOpts = z.input<typeof CcOptsSchema>;

export type InputChannelDef =
  | { kind: "level"; name: string; opts: z.output<typeof LevelOptsSchema> }
  | { kind: "onset"; name: string; opts: z.output<typeof OnsetOptsSchema> }
  | { kind: "cc"; name: string; opts: z.output<typeof CcOptsSchema> };

export type InputChannelKind = InputChannelDef["kind"];

export interface InputsDef {
  channels: InputChannelDef[];
}

export interface InputsBuilder {
  /** Continuous band energy → gain/floor/lag. */
  level(name: string, opts: LevelChannelOpts): void;
  /** Onset detector → decaying envelope (the pulse.scene idiom, promoted). */
  onset(name: string, opts: OnsetChannelOpts): void;
  /** A MIDI CC as a channel (0..1 × gain). */
  cc(name: string, opts: CcChannelOpts): void;
}

export function defineInputs(define: (d: InputsBuilder) => void): InputsDef {
  const channels: InputChannelDef[] = [];
  const used = new Set<string>();
  const add = (c: InputChannelDef) => {
    if (!NAME_RE.test(c.name)) {
      throw new Error(`defineInputs: channel name "${c.name}" must be a lowerCamelCase identifier`);
    }
    if (used.has(c.name)) throw new Error(`defineInputs: duplicate channel name "${c.name}"`);
    used.add(c.name);
    channels.push(c);
  };
  define({
    level: (name, opts) => add({ kind: "level", name, opts: LevelOptsSchema.parse(opts) }),
    onset: (name, opts) => add({ kind: "onset", name, opts: OnsetOptsSchema.parse(opts) }),
    cc: (name, opts) => add({ kind: "cc", name, opts: CcOptsSchema.parse(opts) }),
  });
  return { channels };
}

// ---- registry ----

interface ChannelState {
  def: InputChannelDef;
  /** Latest computed value — what meters show and consumers read. */
  value: number;
  /** Band/rms source signal (level + onset kinds). */
  source: Signal<number> | null;
  /** Param handles, looked up once per define(). */
  enabled: Param<boolean>;
  knobs: Record<string, Param<number>>;
  // level state
  lagValue: number;
  // onset state
  prev: number;
  lastFireMs: number;
  armed: boolean;
  env: number;
}

/**
 * Owns the channels and the globals Manifest. The engine calls update() once
 * per frame (after AudioBus.update), so every channel advances and meters
 * work even with zero consumers — and stateful detectors never miss time.
 */
export class InputRegistry {
  manifest = new Manifest();

  private channels = new Map<string, ChannelState>();

  constructor(private readonly buses: { audio: AudioBusLike; midi?: MidiBusLike }) {}

  /**
   * (Re)define the rack from code. Tuned param values and detector/envelope
   * state carry over for channels that persist; a hot reload never resets
   * the rack's feel mid-set.
   */
  define(def: InputsDef): void {
    const oldManifest = this.manifest;
    const oldChannels = this.channels;
    const manifest = new Manifest();
    const channels = new Map<string, ChannelState>();
    for (const c of def.channels) {
      const st = this.createState(c, manifest);
      const prev = oldChannels.get(c.name);
      if (prev && prev.def.kind === c.kind) {
        st.value = prev.value;
        st.lagValue = prev.lagValue;
        st.prev = prev.prev;
        st.lastFireMs = prev.lastFireMs;
        st.armed = prev.armed;
        st.env = prev.env;
      }
      channels.set(c.name, st);
    }
    for (const path of manifest.paths()) {
      const prev = oldManifest.get(path);
      if (prev) manifest.get(path)!.set(prev.value as never);
    }
    this.manifest = manifest;
    this.channels = channels;
  }

  /** Advance every channel; engine calls this once per frame, pre-render. */
  update(f: FrameCtx): void {
    for (const st of this.channels.values()) this.updateChannel(st, f);
  }

  /** Latest value of a channel; unknown names read 0 (never throw mid-set). */
  value(name: string): number {
    return this.channels.get(name)?.value ?? 0;
  }

  /** All channel values — the rack meters / session snapshot payload. */
  values(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [name, st] of this.channels) out[name] = st.value;
    return out;
  }

  /** Late-bound consumer view: resolves through the registry at pull time. */
  signal(name: string): Signal<number> {
    return new Signal(() => this.value(name));
  }

  private createState(def: InputChannelDef, manifest: Manifest): ChannelState {
    const p = (knob: string) => rackKnobPath(def.name, knob);
    const knobs: Record<string, Param<number>> = {};
    let source: Signal<number> | null = null;
    if (def.kind === "level") {
      source = def.opts.band === "rms" ? this.buses.audio.rms : this.buses.audio.band(def.opts.band);
      knobs.gain = manifest.float(p("gain"), { default: def.opts.gain, min: 0, max: 4, description: "channel gain" });
      knobs.floor = manifest.float(p("floor"), { default: def.opts.floor, min: 0, max: 1, description: "energy below this reads 0" });
      knobs.lag = manifest.float(p("lag"), { default: def.opts.lag, min: 0, max: 1, description: "smoothing time constant (s)" });
    } else if (def.kind === "onset") {
      source = this.buses.audio.band(def.opts.band);
      knobs.threshold = manifest.float(p("threshold"), { default: def.opts.threshold, min: 0, max: 1, description: "detector energy threshold" });
      knobs.decay = manifest.float(p("decay"), { default: def.opts.decay, min: 0.01, max: 2, description: "envelope decay (s)" });
      knobs.gain = manifest.float(p("gain"), { default: def.opts.gain, min: 0, max: 4, description: "envelope peak" });
    } else {
      knobs.gain = manifest.float(p("gain"), { default: def.opts.gain, min: 0, max: 4, description: "channel gain" });
    }
    const enabled = manifest.bool(p("enabled"), { default: true, description: "channel on/off" });
    return {
      def,
      value: 0,
      source,
      enabled,
      knobs,
      lagValue: 0,
      prev: 0,
      lastFireMs: -Infinity,
      armed: true,
      env: 0,
    };
  }

  private updateChannel(st: ChannelState, f: FrameCtx): void {
    const enabled = st.enabled.value === true;
    switch (st.def.kind) {
      case "level": {
        const raw = st.source!.get(f);
        const x = Math.max(0, raw - st.knobs.floor!.value) * st.knobs.gain!.value;
        const tau = st.knobs.lag!.value;
        if (tau <= 0) st.lagValue = x;
        else st.lagValue += (x - st.lagValue) * (1 - Math.exp(-f.dt / tau));
        st.value = enabled ? st.lagValue : 0;
        return;
      }
      case "onset": {
        const energy = st.source!.get(f);
        const nowMs = f.now * 1000;
        const th = st.knobs.threshold!.value;
        let fired = false;
        if (
          enabled &&
          st.armed &&
          energy >= th &&
          energy - st.prev >= st.def.opts.rise &&
          nowMs - st.lastFireMs >= st.def.opts.refractoryMs
        ) {
          fired = true;
          st.lastFireMs = nowMs;
          st.armed = false;
        }
        if (energy < th) st.armed = true;
        st.prev = energy;
        if (fired) st.env = 1;
        else st.env *= Math.exp(-f.dt / Math.max(st.knobs.decay!.value, 1e-4));
        st.value = enabled ? st.env * st.knobs.gain!.value : 0;
        return;
      }
      case "cc": {
        const midi = this.buses.midi;
        if (!enabled || !midi) {
          st.value = 0;
          return;
        }
        st.value = midi.ccValue(st.def.opts.cc, st.def.opts.ch) * st.knobs.gain!.value;
        return;
      }
    }
  }
}
