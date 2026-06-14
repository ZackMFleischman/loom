import type { FrameCtx, StageDirective } from "@loom/runtime";
import { describe, expect, it, vi } from "vitest";
import { RenderService, type RenderServiceDeps } from "../src/render-service";

const FRAME: FrameCtx = { frame: 1, now: 1 / 60, dt: 1 / 60 };

/**
 * Build a RenderService whose collaborators each append a label to `log` when
 * called — so a single tick() produces the observed step order.
 */
function harness(directive: StageDirective = { mode: "single", live: "boot" }) {
  const log: string[] = [];
  const tag =
    (label: string) =>
    <T>(ret?: T) =>
    () => {
      log.push(label);
      return ret;
    };
  const deps = {
    renderer: {} as RenderServiceDeps["renderer"],
    canvas: {
      width: 1920,
      height: 1080,
      toDataURL: () => {
        log.push("screenshot");
        return "data:image/png;base64,QUJD";
      },
    },
    clock: {
      tick: () => {
        log.push("clock");
        return FRAME;
      },
    },
    timeBus: { tick: tag("timeBus")() },
    audio: { update: tag("audio")() },
    inputs: { update: tag("inputs")() },
    debugOnsets: {
      poll: () => {
        log.push("onsets");
        return [0]; // one onset → onsetCount advances by 1
      },
    },
    fixtures: { recordFrame: tag("fixtures")() },
    stage: {
      tick: () => {
        log.push("stage");
        return directive;
      },
    },
    projects: { maybeCull: tag("cull")() },
    session: { tickModulators: vi.fn(() => log.push("modulators")) },
    globalsModulators: { tick: tag("globalsMods")() },
    palettes: { manifest: {} },
    compositor: { render: tag("render")() },
    fps: { tick: tag("fps")(), current: 60 },
    debug: { update: tag("debug")() },
    captureLiveMirror: () => log.push("mirror"),
    tickPreview: () => log.push("preview-overlay"),
    workerInterval: () => () => {},
  } as unknown as RenderServiceDeps;
  return { svc: new RenderService(deps), deps, log };
}

describe("RenderService.tick ordering", () => {
  it("runs cull → render → mirror → screenshot → preview in that order", async () => {
    const { svc, log } = harness();
    const shot = svc.captureCanvas(); // a pending screenshot for this frame
    svc.queuePreview({ run: () => log.push("preview"), done: () => log.push("preview-done") });
    svc.tick(0);
    await shot;
    // The load-bearing relative order (the never-go-black contract):
    const order = log.filter((l) => ["cull", "render", "mirror", "screenshot", "preview"].includes(l));
    expect(order).toEqual(["cull", "render", "mirror", "screenshot", "preview"]);
    // And the full sequence, start to finish.
    expect(log).toEqual([
      "clock",
      "timeBus",
      "audio",
      "inputs",
      "onsets",
      "fixtures",
      "stage",
      "cull",
      "modulators",
      "globalsMods",
      "render",
      "mirror",
      "fps",
      "preview-overlay",
      "screenshot",
      "preview",
      "preview-done",
      "debug",
    ]);
  });

  it("exposes the latest frame, mix, and accumulated onset count", () => {
    const { svc } = harness({ mode: "crossfade", live: "a", staged: "b", mix: 0.4 });
    svc.tick(0);
    expect(svc.latestFrame).toEqual(FRAME);
    expect(svc.currentMix).toBe(0.4);
    expect(svc.onsetCount).toBe(1);
    svc.tick(0); // a second frame accumulates another onset
    expect(svc.onsetCount).toBe(2);
  });
});

describe("RenderService PANIC hold", () => {
  it("skips modulators and rejects pending screenshots while held", async () => {
    const { svc, deps, log } = harness({ mode: "hold" });
    const shot = svc.captureCanvas();
    svc.tick(0);
    await expect(shot).rejects.toThrow(/held \(PANIC\)/);
    expect(deps.session.tickModulators).not.toHaveBeenCalled(); // frozen under hold
    expect(log).not.toContain("globalsMods"); // palette mods frozen too
    expect(log).not.toContain("screenshot"); // canvas never read while held
    expect(log).toContain("render"); // but the compositor still ticks (never go black)
  });

  it("rejects a new screenshot request taken right after a held frame", async () => {
    const { svc } = harness({ mode: "hold" });
    svc.tick(0); // marks heldLastFrame
    await expect(svc.captureCanvas()).rejects.toThrow(/resume before taking a live screenshot/);
  });
});

describe("RenderService scene-panic", () => {
  it("pauses only the suspended live instance's modulators", () => {
    const { svc, deps } = harness({ mode: "panic-scene", panic: "panic", live: "boot" });
    svc.tick(0);
    expect(deps.session.tickModulators).toHaveBeenCalledWith(FRAME, "boot");
  });
});
