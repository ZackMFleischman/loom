import { Events } from "../events";
import type { FrameCtx } from "../frame";
import { Signal } from "../signal";
import { OnsetDetector, type OnsetOpts, bandEnergy } from "./analysis";

export type BandName = "bass" | "mid" | "treble";

const BANDS: Record<BandName, [number, number]> = {
  bass: [20, 150],
  mid: [150, 2000],
  treble: [2000, 8000],
};

export type AudioMode = "off" | "mic" | "test";

/** The audio surface scenes see via ctx.audio (kept separable for fixtures later). */
export interface AudioBusLike {
  rms: Signal<number>;
  band(name: BandName): Signal<number>;
  onset(opts?: OnsetOpts & { band?: BandName }): Events<number>;
}

/**
 * Live audio input: mic (getUserMedia, pickable device) or a built-in
 * synthetic kick/hat pattern ("test") that drives the exact same analyser
 * path — used for deterministic validation and zero-permission demos.
 */
export class AudioBus implements AudioBusLike {
  mode: AudioMode = "off";

  /** Input monitoring: route the mic source to the speakers (R: hear the input). */
  monitorEnabled = false;
  monitorLevel = 0.8;
  private monitorGain: GainNode | null = null;

  readonly rms = new Signal(() => this._rms);

  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private bins = new Uint8Array(0);
  private _rms = 0;
  private energies: Record<BandName, number> = { bass: 0, mid: 0, treble: 0 };
  private nowMs = 0;
  private micStream: MediaStream | null = null;
  private testTimer: ReturnType<typeof setInterval> | null = null;
  private sourceNodes: AudioNode[] = [];

  band(name: BandName): Signal<number> {
    return new Signal(() => this.energies[name]);
  }

  onset(opts: OnsetOpts & { band?: BandName } = {}): Events<number> {
    const detector = new OnsetDetector(opts);
    const band = opts.band ?? "bass";
    return new Events(() => {
      const e = this.energies[band];
      return detector.step(e, this.nowMs) ? [e] : [];
    });
  }

  /** Pump the FFT once per frame; engine calls this before instances render. */
  update(f: FrameCtx): void {
    this.nowMs = f.now * 1000;
    if (!this.analyser) return;
    this.analyser.getByteFrequencyData(this.bins);
    const ctx = this.audioCtx!;
    let sum = 0;
    for (let i = 0; i < this.bins.length; i++) sum += this.bins[i]!;
    this._rms = this.bins.length ? sum / (this.bins.length * 255) : 0;
    for (const name of Object.keys(BANDS) as BandName[]) {
      const [lo, hi] = BANDS[name];
      this.energies[name] = bandEnergy(this.bins, ctx.sampleRate, this.analyser.fftSize, lo, hi);
    }
  }

  async startMic(deviceId?: string): Promise<void> {
    this.stop();
    // LOOM analyses *music*, not voice. Chrome enables echo cancellation,
    // noise suppression and auto-gain by default, all of which pump levels and
    // punch holes in the spectrum — they wreck beat/onset detection. Disable
    // them so a clean signal (a real interface, or a virtual loopback device
    // carrying e.g. a SonoBus stream) reaches the analyser intact.
    const constraints: MediaStreamConstraints = {
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2,
      },
    };
    this.micStream = await navigator.mediaDevices.getUserMedia(constraints);
    const ctx = this.ensureContext();
    const src = ctx.createMediaStreamSource(this.micStream);
    src.connect(this.analyser!);
    if (this.monitorGain) src.connect(this.monitorGain);
    this.sourceNodes.push(src);
    this.mode = "mic";
  }

  /** Synthetic kick (every beat) + hats (offbeats) at the given BPM. */
  startTest(bpm = 120): void {
    this.stop();
    const ctx = this.ensureContext();
    // Keep the graph pumping without audible output.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    this.analyser!.connect(mute);
    mute.connect(ctx.destination);
    this.sourceNodes.push(mute);

    const beat = 60 / bpm;
    let next = ctx.currentTime + 0.1;
    const scheduleKick = (t: number) => {
      const osc = ctx.createOscillator();
      osc.frequency.setValueAtTime(140, t);
      osc.frequency.exponentialRampToValueAtTime(40, t + 0.12);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(1, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
      osc.connect(gain);
      gain.connect(this.analyser!);
      osc.start(t);
      osc.stop(t + 0.3);
    };
    const scheduleHat = (t: number) => {
      const len = Math.floor(ctx.sampleRate * 0.05);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 5000;
      const gain = ctx.createGain();
      gain.gain.value = 0.4;
      src.connect(hp);
      hp.connect(gain);
      gain.connect(this.analyser!);
      src.start(t);
    };
    this.testTimer = setInterval(() => {
      // After a main-thread stall, drop the missed beats instead of starting
      // them all in the past at once — a kick pile-up saturates the analyser
      // and reads as one giant (threshold-defying) onset.
      if (next < ctx.currentTime) next = ctx.currentTime + 0.02;
      while (next < ctx.currentTime + 0.25) {
        scheduleKick(next);
        scheduleHat(next + beat / 2);
        next += beat;
      }
    }, 60);
    this.mode = "test";
  }

  /** Autoplay-policy escape hatch: call from a user gesture. */
  resume(): void {
    void this.audioCtx?.resume();
  }

  /** Current effective monitor gain (0 when disabled). For tests/diagnostics. */
  get monitorGainValue(): number {
    return this.monitorGain?.gain.value ?? 0;
  }

  /**
   * Toggle/level the input monitor. Effective gain is `enabled ? level : 0`, so
   * the toggle and the level are independent — you can pre-set the level while
   * muted, and flipping the toggle re-applies the stored level. Human-only path
   * (Console); never an MCP tool. Mic mode only — the synthetic "test" graph is
   * deliberately muted and never feeds the monitor.
   */
  setMonitor(opts: { enabled?: boolean | undefined; level?: number | undefined }): void {
    if (opts.level !== undefined) {
      this.monitorLevel = Math.max(0, Math.min(1, opts.level));
    }
    if (opts.enabled !== undefined) this.monitorEnabled = opts.enabled;
    this.ensureContext();
    if (this.monitorGain) {
      this.monitorGain.gain.value = this.monitorEnabled ? this.monitorLevel : 0;
    }
  }

  async listInputDevices(): Promise<MediaDeviceInfo[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === "audioinput");
  }

  stop(): void {
    if (this.testTimer) {
      clearInterval(this.testTimer);
      this.testTimer = null;
    }
    for (const n of this.sourceNodes) {
      try {
        n.disconnect();
      } catch {}
    }
    this.sourceNodes = [];
    if (this.micStream) {
      for (const t of this.micStream.getTracks()) t.stop();
      this.micStream = null;
    }
    this.mode = "off";
    this._rms = 0;
    this.energies = { bass: 0, mid: 0, treble: 0 };
  }

  private ensureContext(): AudioContext {
    if (!this.audioCtx) {
      this.audioCtx = new AudioContext();
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.5;
      this.bins = new Uint8Array(this.analyser.frequencyBinCount);
      // Persistent monitor tap: lives for the context's life so it survives
      // source swaps. Starts at the current effective gain (0 when off).
      this.monitorGain = this.audioCtx.createGain();
      this.monitorGain.gain.value = this.monitorEnabled ? this.monitorLevel : 0;
      this.monitorGain.connect(this.audioCtx.destination);
    }
    void this.audioCtx.resume();
    return this.audioCtx;
  }
}
