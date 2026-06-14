import { describe, expect, it } from "vitest";
import { MidiBus, type MidiAccessLike, type MidiInputLike } from "../src/inputbus/midi";

function fakeAccess(): MidiAccessLike & {
  emit(id: string, data: number[]): void;
  plug(id: string, name: string): void;
  unplug(id: string): void;
} {
  const inputs = new Map<string, MidiInputLike>();
  const access: MidiAccessLike = { inputs, onstatechange: null };
  return Object.assign(access, {
    emit(id: string, data: number[]) {
      inputs.get(id)?.onmidimessage?.({ data: new Uint8Array(data) });
    },
    plug(id: string, name: string) {
      inputs.set(id, { name, onmidimessage: null });
      access.onstatechange?.();
    },
    unplug(id: string) {
      inputs.delete(id);
      access.onstatechange?.();
    },
  });
}

describe("MidiBus", () => {
  it("is inert without WebMIDI (no devices, ccValue 0, no throw)", async () => {
    const bus = new MidiBus();
    const ok = await bus.init(undefined);
    expect(ok).toBe(false);
    expect(bus.status).toBe("off");
    expect(bus.devices).toEqual([]);
    expect(bus.ccValue(21)).toBe(0);
  });

  it("reports status off when the permission request rejects", async () => {
    const bus = new MidiBus();
    const ok = await bus.init(() => Promise.reject(new Error("denied")));
    expect(ok).toBe(false);
    expect(bus.status).toBe("off");
  });

  it("reports status ready on success and init becomes idempotent", async () => {
    const access = fakeAccess();
    let requests = 0;
    const bus = new MidiBus();
    expect(bus.status).toBe("off");
    const ok = await bus.init(() => {
      requests++;
      return Promise.resolve(access);
    });
    expect(ok).toBe(true);
    expect(bus.status).toBe("ready");
    // a later retry (gesture/permission watcher) must not re-prompt
    const again = await bus.init(() => {
      requests++;
      return Promise.resolve(access);
    });
    expect(again).toBe(true);
    expect(requests).toBe(1);
  });

  it("can re-init successfully after a rejected attempt", async () => {
    const access = fakeAccess();
    access.plug("a", "Knobs");
    const bus = new MidiBus();
    await bus.init(() => Promise.reject(new Error("dismissed")));
    expect(bus.status).toBe("off");
    const ok = await bus.init(() => Promise.resolve(access));
    expect(ok).toBe(true);
    expect(bus.devices).toEqual(["Knobs"]);
  });

  it("normalizes CC messages from a device to 0..1", async () => {
    const access = fakeAccess();
    access.plug("a", "Fake Knobs");
    const bus = new MidiBus();
    await bus.init(() => Promise.resolve(access));
    expect(bus.devices).toEqual(["Fake Knobs"]);
    access.emit("a", [0xb0, 21, 127]); // CC 21 on channel 0
    expect(bus.ccValue(21, 0)).toBe(1);
    expect(bus.ccValue(21)).toBe(1); // any-channel read
    access.emit("a", [0xb2, 21, 0]); // same CC, channel 2
    expect(bus.ccValue(21, 2)).toBe(0);
    expect(bus.ccValue(21, 0)).toBe(1); // per-channel value untouched
    expect(bus.ccValue(21)).toBe(0); // any-channel reads the latest
  });

  it("ignores non-CC messages", async () => {
    const access = fakeAccess();
    access.plug("a", "Pads");
    const bus = new MidiBus();
    await bus.init(() => Promise.resolve(access));
    access.emit("a", [0x90, 60, 100]); // note on
    expect(bus.ccValue(60)).toBe(0);
  });

  it("hot-plugs: statechange refreshes devices and attaches handlers", async () => {
    const access = fakeAccess();
    const bus = new MidiBus();
    await bus.init(() => Promise.resolve(access));
    expect(bus.devices).toEqual([]);
    access.plug("late", "Late Controller");
    expect(bus.devices).toEqual(["Late Controller"]);
    access.emit("late", [0xb0, 7, 64]);
    expect(bus.ccValue(7, 0)).toBeCloseTo(64 / 127);
    access.unplug("late");
    expect(bus.devices).toEqual([]);
  });

  it("notifies CC listeners and supports unsubscribe", async () => {
    const access = fakeAccess();
    access.plug("a", "K");
    const bus = new MidiBus();
    await bus.init(() => Promise.resolve(access));
    const seen: Array<{ cc: number; ch: number; value: number }> = [];
    const off = bus.onCc((e) => seen.push(e));
    access.emit("a", [0xb0, 21, 127]);
    expect(seen).toEqual([{ cc: 21, ch: 0, value: 1 }]);
    off();
    access.emit("a", [0xb0, 21, 0]);
    expect(seen).toHaveLength(1);
  });

  it("logs recent raw messages, including non-CC traffic the bus filters", async () => {
    const access = fakeAccess();
    access.plug("a", "nanoKONTROL2");
    const bus = new MidiBus();
    await bus.init(() => Promise.resolve(access));
    access.emit("a", [0xb0, 21, 64]); // CC — handled
    access.emit("a", [0xe3, 0x00, 0x40]); // pitch bend ch 3 — filtered, still logged
    access.emit("a", [0x90, 60, 100]); // note on — filtered, still logged
    expect(bus.ccValue(60)).toBe(0);
    expect(bus.recent).toEqual([
      { kind: "cc", ch: 0, data: [0xb0, 21, 64] },
      { kind: "pitchbend", ch: 3, data: [0xe3, 0x00, 0x40] },
      { kind: "noteon", ch: 0, data: [0x90, 60, 100] },
    ]);
  });

  it("caps the recent log and ignores realtime keepalive spam", async () => {
    const access = fakeAccess();
    access.plug("a", "K");
    const bus = new MidiBus();
    await bus.init(() => Promise.resolve(access));
    access.emit("a", [0xf8]); // clock
    access.emit("a", [0xfe]); // active sensing
    expect(bus.recent).toEqual([]);
    for (let i = 0; i < 20; i++) access.emit("a", [0xb0, 21, i]);
    expect(bus.recent).toHaveLength(16);
    expect(bus.recent[15]!.data).toEqual([0xb0, 21, 19]); // newest last
    expect(bus.recent[0]!.data).toEqual([0xb0, 21, 4]); // oldest dropped
  });

  it("inject() feeds the same path as real messages (mocked hardware)", () => {
    const bus = new MidiBus(); // no init at all
    const seen: number[] = [];
    bus.onCc((e) => seen.push(e.value));
    bus.inject(21, 0, 0.5);
    expect(bus.ccValue(21, 0)).toBeCloseTo(0.5);
    expect(bus.ccValue(21)).toBeCloseTo(0.5);
    expect(seen).toEqual([0.5]);
  });
});
