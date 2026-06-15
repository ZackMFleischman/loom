import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioBus } from "../src/inputbus/audio";

// Captured fakes — the runtime test env is `node`, so stub the browser audio
// globals AudioBus touches.
let lastSource: FakeSource | null = null;
let lastAudioEl: FakeAudioEl | null = null;

class FakeSource {
  connections: unknown[] = [];
  connect(target: unknown) {
    this.connections.push(target);
  }
  disconnect() {
    this.connections = [];
  }
}
class FakeAnalyser {
  fftSize = 0;
  smoothingTimeConstant = 0;
  frequencyBinCount = 1024;
  connect = vi.fn();
  disconnect = vi.fn();
  getByteFrequencyData = vi.fn();
}
class FakeAudioContext {
  sampleRate = 48000;
  currentTime = 0;
  destination = { id: "destination" } as unknown as AudioNode;
  state = "running";
  createAnalyser() {
    return new FakeAnalyser();
  }
  createMediaStreamSource() {
    lastSource = new FakeSource();
    return lastSource;
  }
  resume() {
    return Promise.resolve();
  }
}
class FakeAudioEl {
  srcObject: unknown = null;
  volume = 1;
  muted = false;
  play = vi.fn(() => Promise.resolve());
  pause = vi.fn();
  constructor() {
    lastAudioEl = this;
  }
}
const fakeStream = { getTracks: () => [{ stop: vi.fn() }] };

beforeEach(() => {
  lastSource = null;
  lastAudioEl = null;
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("Audio", FakeAudioEl);
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: vi.fn(() => Promise.resolve(fakeStream)),
      enumerateDevices: vi.fn(() => Promise.resolve([])),
    },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AudioBus monitor", () => {
  it("defaults to off", () => {
    const bus = new AudioBus();
    expect(bus.monitorEnabled).toBe(false);
    expect(bus.monitorLevel).toBeCloseTo(0.8);
  });

  it("mic source connects ONLY to the analyser, never toward the destination", async () => {
    const bus = new AudioBus();
    bus.setMonitor({ enabled: true, level: 0.5 });
    await bus.startMic();
    // Regression guard (the monitor bug): routing the getUserMedia source toward
    // the AudioContext destination corrupts the captured stream in Chrome and
    // zeroes the analyser. The monitor must be fully decoupled — the source
    // feeds the analyser and NOTHING else.
    expect(lastSource).not.toBeNull();
    expect(lastSource!.connections).toHaveLength(1);
  });

  it("monitoring plays the mic stream through a separate audio element", async () => {
    const bus = new AudioBus();
    await bus.startMic();
    bus.setMonitor({ enabled: true, level: 0.5 });
    expect(lastAudioEl).not.toBeNull();
    expect(lastAudioEl!.srcObject).toBe(fakeStream);
    expect(lastAudioEl!.muted).toBe(false);
    expect(lastAudioEl!.volume).toBeCloseTo(0.5);
  });

  it("disabled mutes the element but the analyser source stays connected", async () => {
    const bus = new AudioBus();
    await bus.startMic();
    bus.setMonitor({ enabled: true, level: 0.7 });
    bus.setMonitor({ enabled: false });
    expect(lastAudioEl!.muted).toBe(true);
    expect(lastAudioEl!.volume).toBeCloseTo(0.7); // level remembered while muted
    expect(lastSource!.connections).toHaveLength(1); // analyser link untouched
  });

  it("clamps level to 0..1", () => {
    const bus = new AudioBus();
    bus.setMonitor({ enabled: true, level: 5 });
    expect(bus.monitorLevel).toBe(1);
    bus.setMonitor({ level: -2 });
    expect(bus.monitorLevel).toBe(0);
  });

  it("survives stop() — monitor state persists", async () => {
    const bus = new AudioBus();
    await bus.startMic();
    bus.setMonitor({ enabled: true, level: 0.6 });
    bus.stop();
    expect(bus.monitorEnabled).toBe(true);
    expect(bus.monitorLevel).toBeCloseTo(0.6);
  });
});
