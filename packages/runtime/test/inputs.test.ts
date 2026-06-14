import { describe, expect, it } from "vitest";
import { BuildCtx } from "../src/buildctx";
import { Events } from "../src/events";
import type { AudioBusLike, BandName } from "../src/inputbus/audio";
import { OnsetDetector, type OnsetOpts } from "../src/inputbus/analysis";
import { TimeBus } from "../src/inputbus/time";
import { Signal } from "../src/signal";
import { defineInputs, InputRegistry } from "../src/inputs";
import { F, frames } from "./helpers";

/** Settable fake audio bus: tests drive band energies / rms by hand. */
class FakeAudio implements AudioBusLike {
  energies: Record<BandName, number> = { bass: 0, mid: 0, treble: 0 };
  level = 0;
  readonly rms = new Signal(() => this.level);
  band(name: BandName): Signal<number> {
    return new Signal(() => this.energies[name]);
  }
  onset(opts: OnsetOpts & { band?: BandName } = {}): Events<number> {
    const d = new OnsetDetector(opts);
    const band = opts.band ?? "bass";
    return new Events((f) => {
      const e = this.energies[band];
      return d.step(e, f.now * 1000) ? [e] : [];
    });
  }
}

class FakeMidi {
  values = new Map<string, number>();
  ccValue(cc: number, ch?: number): number {
    if (ch !== undefined) return this.values.get(`${ch}:${cc}`) ?? 0;
    return this.values.get(`any:${cc}`) ?? 0;
  }
  set(cc: number, ch: number, v: number): void {
    this.values.set(`${ch}:${cc}`, v);
    this.values.set(`any:${cc}`, v);
  }
}

const DEFS = defineInputs((d) => {
  d.onset("kick", { band: "bass", threshold: 0.22, decay: 0.22 });
  d.level("bass", { band: "bass", lag: 0 });
  d.cc("knob1", { cc: 21 });
});

function makeRegistry() {
  const audio = new FakeAudio();
  const midi = new FakeMidi();
  const reg = new InputRegistry({ audio, midi });
  reg.define(DEFS);
  return { audio, midi, reg };
}

describe("defineInputs", () => {
  it("collects channel definitions in order", () => {
    expect(DEFS.channels.map((c) => `${c.kind}:${c.name}`)).toEqual([
      "onset:kick",
      "level:bass",
      "cc:knob1",
    ]);
  });

  it("rejects duplicate channel names", () => {
    expect(() =>
      defineInputs((d) => {
        d.onset("kick", { band: "bass" });
        d.level("kick", { band: "bass" });
      }),
    ).toThrow(/duplicate/i);
  });

  it("rejects non-identifier names", () => {
    expect(() => defineInputs((d) => d.level("Bad Name!", { band: "bass" }))).toThrow();
  });
});

describe("InputRegistry — globals manifest", () => {
  it("registers tuning params per channel under inputs.<name>.*", () => {
    const { reg } = makeRegistry();
    const paths = reg.manifest.paths();
    expect(paths).toContain("inputs.kick.threshold");
    expect(paths).toContain("inputs.kick.decay");
    expect(paths).toContain("inputs.kick.gain");
    expect(paths).toContain("inputs.kick.enabled");
    expect(paths).toContain("inputs.bass.gain");
    expect(paths).toContain("inputs.bass.floor");
    expect(paths).toContain("inputs.bass.lag");
    expect(paths).toContain("inputs.knob1.gain");
  });

  it("seeds param defaults from the channel definition", () => {
    const { reg } = makeRegistry();
    expect(reg.manifest.get("inputs.kick.threshold")?.value).toBe(0.22);
    expect(reg.manifest.get("inputs.kick.decay")?.value).toBe(0.22);
    expect(reg.manifest.get("inputs.kick.enabled")?.value).toBe(true);
  });
});

describe("InputRegistry — level channels", () => {
  it("tracks band energy through gain and floor (lag 0 passes through)", () => {
    const { audio, reg } = makeRegistry();
    audio.energies.bass = 0.5;
    reg.update(F(0));
    expect(reg.value("bass")).toBeCloseTo(0.5);
    reg.manifest.get("inputs.bass.gain")!.set(2);
    reg.manifest.get("inputs.bass.floor")!.set(0.1);
    reg.update(F(1));
    expect(reg.value("bass")).toBeCloseTo((0.5 - 0.1) * 2);
  });

  it("clamps below-floor energy to 0", () => {
    const { audio, reg } = makeRegistry();
    reg.manifest.get("inputs.bass.floor")!.set(0.4);
    audio.energies.bass = 0.2;
    reg.update(F(0));
    expect(reg.value("bass")).toBe(0);
  });

  it("smooths with lag > 0", () => {
    const { audio, reg } = makeRegistry();
    reg.manifest.get("inputs.bass.lag")!.set(0.2);
    audio.energies.bass = 1;
    let v = 0;
    for (const f of frames(3)) {
      reg.update(f);
      v = reg.value("bass");
    }
    expect(v).toBeGreaterThan(0.05);
    expect(v).toBeLessThan(0.5); // still rising toward 1
  });
});

describe("InputRegistry — onset channels", () => {
  it("jumps to gain on an onset and decays exponentially", () => {
    const { audio, reg } = makeRegistry();
    audio.energies.bass = 0;
    reg.update(F(0));
    audio.energies.bass = 0.8; // sharp rise over threshold
    reg.update(F(1));
    expect(reg.value("kick")).toBeCloseTo(1);
    audio.energies.bass = 0.05;
    reg.update(F(2));
    const decayed = reg.value("kick");
    expect(decayed).toBeLessThan(1);
    expect(decayed).toBeGreaterThan(0.8); // ~exp(-dt/0.22)
  });

  it("a retuned threshold silences detection without redefinition", () => {
    const { audio, reg } = makeRegistry();
    reg.manifest.get("inputs.kick.threshold")!.set(0.95);
    audio.energies.bass = 0;
    reg.update(F(0));
    audio.energies.bass = 0.8;
    reg.update(F(1));
    expect(reg.value("kick")).toBe(0);
    // restoring the threshold recovers detection
    reg.manifest.get("inputs.kick.threshold")!.set(0.22);
    audio.energies.bass = 0.05;
    reg.update(F(2));
    audio.energies.bass = 0.8;
    reg.update(F(3));
    expect(reg.value("kick")).toBeCloseTo(1);
  });

  it("disabled channels read 0", () => {
    const { audio, reg } = makeRegistry();
    reg.manifest.get("inputs.kick.enabled")!.set(false);
    audio.energies.bass = 0;
    reg.update(F(0));
    audio.energies.bass = 0.8;
    reg.update(F(1));
    expect(reg.value("kick")).toBe(0);
  });
});

describe("InputRegistry — cc channels", () => {
  it("reads the latest CC value through gain", () => {
    const { midi, reg } = makeRegistry();
    midi.set(21, 0, 0.5);
    reg.update(F(0));
    expect(reg.value("knob1")).toBeCloseTo(0.5);
    reg.manifest.get("inputs.knob1.gain")!.set(2);
    reg.update(F(1));
    expect(reg.value("knob1")).toBeCloseTo(1);
  });
});

describe("InputRegistry — late binding & meters", () => {
  it("values() reports every channel with no consumers attached", () => {
    const { reg } = makeRegistry();
    reg.update(F(0));
    expect(Object.keys(reg.values()).sort()).toEqual(["bass", "kick", "knob1"]);
  });

  it("signal(name) resolves through the registry at pull time", () => {
    const { audio, reg } = makeRegistry();
    const s = reg.signal("bass");
    audio.energies.bass = 0.3;
    reg.update(F(0));
    expect(s.get(F(0))).toBeCloseTo(0.3);
    audio.energies.bass = 0.7;
    reg.update(F(1));
    expect(s.get(F(1))).toBeCloseTo(0.7);
  });

  it("unknown channels read 0 instead of throwing", () => {
    const { reg } = makeRegistry();
    expect(reg.signal("nope").get(F(0))).toBe(0);
    expect(reg.value("nope")).toBe(0);
  });
});

describe("InputRegistry — redefinition (hot reload)", () => {
  it("adds new channels, drops removed ones, and keeps tuned values", () => {
    const { reg } = makeRegistry();
    reg.manifest.get("inputs.kick.threshold")!.set(0.7);
    reg.define(
      defineInputs((d) => {
        d.onset("kick", { band: "bass", threshold: 0.22, decay: 0.22 });
        d.onset("kickTight", { band: "bass", threshold: 0.5, decay: 0.1 });
      }),
    );
    // tuned value carried over, not reset to the code default
    expect(reg.manifest.get("inputs.kick.threshold")?.value).toBe(0.7);
    // new channel present, removed one gone
    expect(reg.manifest.get("inputs.kickTight.threshold")?.value).toBe(0.5);
    expect(reg.manifest.get("inputs.bass.gain")).toBeUndefined();
    reg.update(F(0));
    expect(Object.keys(reg.values()).sort()).toEqual(["kick", "kickTight"]);
  });
});

describe("BuildCtx.input — late-bound consumption with a per-instance trim", () => {
  function makeCtx() {
    const { audio, reg } = makeRegistry();
    const ctx = new BuildCtx(audio, new TimeBus(120), reg);
    return { audio, reg, ctx };
  }

  it("auto-declares input.<name>.amount once and multiplies by it", () => {
    const { audio, reg, ctx } = makeCtx();
    const a = ctx.input("bass");
    const b = ctx.input("bass"); // second consumption must not double-declare
    expect(ctx.manifest.paths().filter((p) => p === "input.bass.amount")).toHaveLength(1);
    const trim = ctx.manifest.get("input.bass.amount")!;
    expect(trim.value).toBe(1);
    // Auto-added, so it's hidden from the default params box (still fully live).
    expect((trim.toJSON() as { hidden?: boolean }).hidden).toBe(true);
    audio.energies.bass = 0.4;
    reg.update(F(0));
    expect(a.get(F(0))).toBeCloseTo(0.4);
    trim.set(0.5);
    reg.update(F(1));
    expect(b.get(F(1))).toBeCloseTo(0.2);
  });

  it("reads 0 when no registry is wired (sandbox builds stay alive)", () => {
    const audio = new FakeAudio();
    const ctx = new BuildCtx(audio, new TimeBus(120));
    expect(ctx.input("kick").get(F(0))).toBe(0);
  });
});
