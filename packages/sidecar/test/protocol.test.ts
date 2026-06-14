import { describe, expect, it } from "vitest";
import {
  ArmAgentCommitArgs,
  BatchArgs,
  ClearModulationArgs,
  CommitArgs,
  CreateInstanceArgs,
  DiagEvent,
  GetDiagnosticsArgs,
  GetDiagnosticsResult,
  GetSidecarDiagnosticsResult,
  InstanceArgs,
  MidiTargetArgs,
  PerfSnapshot,
  ModulateParamArgs,
  RequestMsg,
  ResponseMsg,
  SaveChainArgs,
  ScreenshotConsoleArgs,
  ScreenshotConsoleResult,
  SetChainArgs,
  SetParamArgs,
  SetParamsArgs,
  TransportArgs,
} from "../src/protocol";

describe("RequestMsg", () => {
  it("parses every request type", () => {
    const types = [
      "get_session", "get_manifest", "set_param", "set_params", "set_param_range", "modulate_param", "clear_modulation",
      "screenshot", "screenshot_console", "create_instance", "destroy_instance", "stage", "unstage", "commit",
      "set_chain", "save_chain", "preview_effect",
      "panic", "resume", "set_transport", "arm_agent_commit",
      "midi_learn", "midi_unbind", "get_diagnostics", "batch",
    ];
    for (const type of types) {
      const msg = RequestMsg.parse({ id: "r1", kind: "req", type, args: {} });
      expect(msg.type).toBe(type);
    }
  });

  it("defaults args to an empty object", () => {
    const msg = RequestMsg.parse({ id: "r1", kind: "req", type: "get_session" });
    expect(msg.args).toEqual({});
  });

  it("rejects unknown types and missing ids", () => {
    expect(() => RequestMsg.parse({ id: "r1", kind: "req", type: "format_disk" })).toThrow();
    expect(() => RequestMsg.parse({ kind: "req", type: "get_session" })).toThrow();
    expect(() => RequestMsg.parse({ id: "", kind: "req", type: "get_session" })).toThrow();
  });
});

describe("ResponseMsg", () => {
  it("parses ok and error variants", () => {
    const ok = ResponseMsg.parse({ id: "r1", kind: "res", ok: true, result: { x: 1 } });
    expect(ok.ok).toBe(true);
    const err = ResponseMsg.parse({ id: "r1", kind: "res", ok: false, error: "nope" });
    expect(err.ok).toBe(false);
    if (!err.ok) expect(err.error).toBe("nope");
  });

  it("requires an error string on the failure variant", () => {
    expect(() => ResponseMsg.parse({ id: "r1", kind: "res", ok: false })).toThrow();
  });
});

describe("SetParamArgs", () => {
  it("defaults instance to live and accepts number, bool, or string (color) values", () => {
    const a = SetParamArgs.parse({ path: "trail", value: 0.5 });
    expect(a.instance).toBe("live");
    expect(SetParamArgs.parse({ path: "on", value: true }).value).toBe(true);
    expect(SetParamArgs.parse({ path: "palette.primary.0", value: "#ff0000" }).value).toBe("#ff0000");
  });

  it("rejects a missing or empty path", () => {
    expect(() => SetParamArgs.parse({ value: 1 })).toThrow();
    expect(() => SetParamArgs.parse({ path: "", value: 1 })).toThrow();
  });

  it("rejects non-scalar values", () => {
    expect(() => SetParamArgs.parse({ path: "p", value: { v: 1 } })).toThrow();
    expect(() => SetParamArgs.parse({ path: "p", value: [1, 2] })).toThrow();
  });
});

describe("SetParamsArgs", () => {
  it("defaults instance to live and takes a path→value map", () => {
    const a = SetParamsArgs.parse({ values: { trail: 0.8, flag: true, "palette.primary.0": "#ff0000" } });
    expect(a.instance).toBe("live");
    expect(a.values.trail).toBe(0.8);
    expect(a.values.flag).toBe(true);
    expect(a.values["palette.primary.0"]).toBe("#ff0000");
  });

  it("rejects an empty values map and non-scalar values", () => {
    expect(() => SetParamsArgs.parse({ values: {} })).toThrow();
    expect(() => SetParamsArgs.parse({ values: { p: { v: 1 } } })).toThrow();
    expect(() => SetParamsArgs.parse({})).toThrow();
  });
});

describe("BatchArgs", () => {
  it("defaults mode to serial and stopOnError to false, and fills per-call args", () => {
    const a = BatchArgs.parse({
      calls: [{ tool: "set_params", args: { values: { trail: 0.5 } } }, { tool: "get_session" }],
    });
    expect(a.mode).toBe("serial");
    expect(a.stopOnError).toBe(false);
    expect(a.calls[1]!.args).toEqual({}); // args default to {}
  });

  it("rejects an empty call list, unknown tools, and a parallel mode (serial-only)", () => {
    expect(() => BatchArgs.parse({ calls: [] })).toThrow();
    expect(() => BatchArgs.parse({ calls: [{ tool: "format_disk" }] })).toThrow();
    expect(() => BatchArgs.parse({ mode: "parallel", calls: [{ tool: "get_session" }] })).toThrow();
  });
});

describe("InstanceArgs", () => {
  it("defaults instance to live", () => {
    expect(InstanceArgs.parse({}).instance).toBe("live");
    expect(InstanceArgs.parse({ instance: "other" }).instance).toBe("other");
  });
});

describe("M3 args", () => {
  it("create_instance requires a scene; id is optional", () => {
    expect(CreateInstanceArgs.parse({ scene: "pulse" })).toEqual({ scene: "pulse" });
    expect(CreateInstanceArgs.parse({ scene: "pulse", id: "x" }).id).toBe("x");
    expect(() => CreateInstanceArgs.parse({})).toThrow();
    expect(() => CreateInstanceArgs.parse({ scene: "" })).toThrow();
  });

  it("commit defaults to a 60-frame fade and bounds the duration", () => {
    expect(CommitArgs.parse({}).durationFrames).toBe(60);
    expect(CommitArgs.parse({ durationFrames: 0 }).durationFrames).toBe(0);
    expect(() => CommitArgs.parse({ durationFrames: -1 })).toThrow();
    expect(() => CommitArgs.parse({ durationFrames: 10_000 })).toThrow();
    expect(() => CommitArgs.parse({ durationFrames: 1.5 })).toThrow();
  });

  it("arm_agent_commit requires an explicit boolean", () => {
    expect(ArmAgentCommitArgs.parse({ armed: true }).armed).toBe(true);
    expect(() => ArmAgentCommitArgs.parse({})).toThrow();
  });

  it("set_transport takes bpm and/or tap", () => {
    expect(TransportArgs.parse({ bpm: 128 }).bpm).toBe(128);
    expect(TransportArgs.parse({ tap: true }).tap).toBe(true);
    expect(() => TransportArgs.parse({ bpm: 0 })).toThrow();
  });
});

describe("M5 args", () => {
  it("midi targets default instance to live and require a path", () => {
    const t = MidiTargetArgs.parse({ path: "punch" });
    expect(t.instance).toBe("live");
    expect(MidiTargetArgs.parse({ instance: "globals", path: "inputs.kick.threshold" }).instance).toBe("globals");
    expect(() => MidiTargetArgs.parse({})).toThrow();
    expect(() => MidiTargetArgs.parse({ path: "" })).toThrow();
  });
});

describe("modulator args", () => {
  it("ModulateParamArgs defaults instance to live and passes the spec through", () => {
    const a = ModulateParamArgs.parse({
      path: "trail",
      modulator: { type: "sine", periodSeconds: 2 },
    });
    expect(a.instance).toBe("live");
    expect(a.modulator.type).toBe("sine");
    expect(() => ModulateParamArgs.parse({ path: "trail" })).toThrow();
    expect(() => ModulateParamArgs.parse({ modulator: { type: "sine" } })).toThrow();
  });

  it("ClearModulationArgs requires a path", () => {
    expect(ClearModulationArgs.parse({ path: "trail" }).instance).toBe("live");
    expect(() => ClearModulationArgs.parse({})).toThrow();
  });
});

describe("chain args (M6)", () => {
  it("SetChainArgs accepts a full step list and defaults instance to live", () => {
    const a = SetChainArgs.parse({
      steps: [{ effect: "glitch" }, { id: "levels-2", effect: "levels", params: { gain: 1.2 }, mix: 0.5 }],
    });
    expect(a.instance).toBe("live");
    expect(a.steps![0]!.effect).toBe("glitch");
    expect(a.steps![1]!.mix).toBe(0.5);
  });

  it("SetChainArgs accepts restoreDefault without steps, but needs one or the other", () => {
    expect(SetChainArgs.parse({ restoreDefault: true }).restoreDefault).toBe(true);
    expect(() => SetChainArgs.parse({})).toThrow();
    expect(() => SetChainArgs.parse({ steps: [{}] })).toThrow(); // a step needs an effect
    expect(() => SetChainArgs.parse({ steps: [{ effect: "glitch", mix: 2 }] })).toThrow(); // mix 0..1
  });

  it("SaveChainArgs requires a lowerCamelCase name", () => {
    expect(SaveChainArgs.parse({ name: "vhsStack" }).instance).toBe("live");
    expect(() => SaveChainArgs.parse({})).toThrow();
    expect(() => SaveChainArgs.parse({ name: "VHS Stack" })).toThrow();
  });
});

describe("screenshot_console schemas (console-screenshot)", () => {
  it("ScreenshotConsoleArgs takes an optional maxWidth (0 = native) and bounds it", () => {
    expect(ScreenshotConsoleArgs.parse({})).toEqual({}); // maxWidth optional → default capture
    expect(ScreenshotConsoleArgs.parse({ maxWidth: 0 }).maxWidth).toBe(0); // explicit native res
    expect(ScreenshotConsoleArgs.parse({ maxWidth: 1280 }).maxWidth).toBe(1280);
    expect(() => ScreenshotConsoleArgs.parse({ maxWidth: -1 })).toThrow();
    expect(() => ScreenshotConsoleArgs.parse({ maxWidth: 1.5 })).toThrow();
    expect(() => ScreenshotConsoleArgs.parse({ maxWidth: 99_999 })).toThrow();
  });

  it("ScreenshotConsoleResult carries the PNG, dims, and the answering consoleId", () => {
    const r = ScreenshotConsoleResult.parse({
      mime: "image/png",
      base64: "iVBORw0KGgo=",
      width: 1280,
      height: 720,
      consoleId: "c-abc123",
    });
    expect(r.mime).toBe("image/png");
    expect(r.consoleId).toBe("c-abc123");
    // Unlike a render screenshot, there's no engine frame/fps on a DOM capture.
    expect("frame" in r).toBe(false);
    expect(() => ScreenshotConsoleResult.parse({ mime: "image/png", base64: "x", width: 1, height: 1 })).toThrow(); // consoleId required
    expect(() => ScreenshotConsoleResult.parse({ mime: "image/jpeg", base64: "x", width: 1, height: 1, consoleId: "c" })).toThrow();
  });
});

describe("Diagnostics schemas (app-instrumentation)", () => {
  it("GetDiagnosticsArgs defaults scope to engine and accepts filters", () => {
    expect(GetDiagnosticsArgs.parse({}).scope).toBe("engine");
    const a = GetDiagnosticsArgs.parse({
      since: 100,
      kinds: ["scene.rejected", "instance.frozen"],
      instance: "aurora-2",
      level: "error",
      limit: 50,
    });
    expect(a).toMatchObject({ scope: "engine", since: 100, instance: "aurora-2", level: "error", limit: 50 });
    expect(GetDiagnosticsArgs.parse({ scope: "sidecar" }).scope).toBe("sidecar");
    expect(() => GetDiagnosticsArgs.parse({ scope: "bogus" })).toThrow();
    expect(() => GetDiagnosticsArgs.parse({ limit: 0 })).toThrow();
  });

  it("DiagEvent keeps kind an OPEN string (no enum gate — NFR-5)", () => {
    const e = DiagEvent.parse({
      seq: 7,
      frame: 5101,
      t: 1234.5,
      level: "error",
      kind: "scene.rejected",
      instance: "boot",
      msg: 'scene "aurora" rejected; keeping previous',
      data: { error: "boom" },
    });
    expect(e.kind).toBe("scene.rejected");
    // A brand-new kind parses without a protocol change.
    expect(DiagEvent.parse({ seq: 1, frame: 1, t: 1, level: "info", kind: "brand.new.kind", msg: "x" }).kind).toBe(
      "brand.new.kind",
    );
  });

  it("PerfSnapshot makes renderer counts optional (best-effort FR-7)", () => {
    const base = {
      fps: 60,
      clockSource: "raf" as const,
      frameBudgetMs: 16.67,
      frame: 100,
      instances: [{ id: "boot", frameMs: 4.2, slowSignals: [{ label: "trail", ms: 0.3 }] }],
      worstFrameMsRecent: 5.1,
    };
    expect(PerfSnapshot.parse(base).renderer).toBeUndefined();
    expect(
      PerfSnapshot.parse({ ...base, renderer: { geometries: 3, textures: 5, drawCalls: 12 } }).renderer,
    ).toEqual({ geometries: 3, textures: 5, drawCalls: 12 });
  });

  it("GetDiagnosticsResult and the sidecar latency result parse", () => {
    const engine = GetDiagnosticsResult.parse({
      scope: "engine",
      events: [{ seq: 0, frame: 1, t: 1, level: "info", kind: "scene.swapped", msg: "ok" }],
      dropped: 0,
      now: { frame: 2, fps: 60, seq: 1 },
      perf: {
        fps: 60,
        clockSource: "raf",
        frameBudgetMs: 16.67,
        frame: 2,
        instances: [],
        worstFrameMsRecent: 0,
      },
    });
    expect(engine.events[0]!.kind).toBe("scene.swapped");

    const sidecar = GetSidecarDiagnosticsResult.parse({
      scope: "sidecar",
      engineConnected: true,
      tools: [{ tool: "set_param", count: 3, ok: 2, error: 1, timeout: 0, p50: 10, p95: 30, max: 30, lastError: "x" }],
    });
    expect(sidecar.tools[0]!.tool).toBe("set_param");
  });
});
