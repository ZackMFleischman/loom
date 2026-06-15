import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioBus } from "../src/inputbus/audio";

// Minimal fake nodes — only what ensureContext()/setMonitor() touch.
class FakeGain {
  gain = { value: 1 };
  connect = vi.fn();
  disconnect = vi.fn();
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
  destination = {} as AudioNode;
  state = "running";
  createAnalyser() {
    return new FakeAnalyser();
  }
  createGain() {
    return new FakeGain();
  }
  resume() {
    return Promise.resolve();
  }
}

beforeEach(() => {
  vi.stubGlobal("AudioContext", FakeAudioContext);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AudioBus monitor", () => {
  it("defaults to off (gain 0) and exposes default state", () => {
    const bus = new AudioBus();
    expect(bus.monitorEnabled).toBe(false);
    expect(bus.monitorLevel).toBeCloseTo(0.8);
  });

  it("setMonitor enabled applies the level to the gain node", () => {
    const bus = new AudioBus();
    bus.setMonitor({ enabled: true, level: 0.5 });
    expect(bus.monitorEnabled).toBe(true);
    expect(bus.monitorLevel).toBeCloseTo(0.5);
    expect(bus.monitorGainValue).toBeCloseTo(0.5);
  });

  it("disabled forces gain to 0 but remembers the level", () => {
    const bus = new AudioBus();
    bus.setMonitor({ level: 0.7 });
    bus.setMonitor({ enabled: false });
    expect(bus.monitorLevel).toBeCloseTo(0.7);
    expect(bus.monitorGainValue).toBe(0);
    bus.setMonitor({ enabled: true });
    expect(bus.monitorGainValue).toBeCloseTo(0.7);
  });

  it("clamps level to 0..1", () => {
    const bus = new AudioBus();
    bus.setMonitor({ enabled: true, level: 5 });
    expect(bus.monitorLevel).toBe(1);
    bus.setMonitor({ level: -2 });
    expect(bus.monitorLevel).toBe(0);
  });

  it("survives a stop() — monitor state persists", () => {
    const bus = new AudioBus();
    bus.setMonitor({ enabled: true, level: 0.6 });
    bus.stop();
    expect(bus.monitorEnabled).toBe(true);
    expect(bus.monitorLevel).toBeCloseTo(0.6);
    expect(bus.monitorGainValue).toBeCloseTo(0.6);
  });
});
