import {
  type AudioBusLike,
  buildInstance,
  Events,
  type FixtureData,
  FixtureDataSchema,
  FixturePlayer,
  type FrameCtx,
  ModulatorHost,
  type PaletteRegistry,
  Signal,
  TimeBus,
} from "@loom/runtime";
import type { FixtureShot } from "@loom/sidecar/protocol";
import { RenderTarget, type WebGPURenderer } from "three/webgpu";
import { PREVIEW_H, PREVIEW_W, type SessionStore } from "./session";
import { fixtureKey, repoStatePath, StateDir } from "./state";

/** Result of a completed record_fixture (the MCP tool's payload). */
export interface RecordResult {
  saved: string;
  path: string;
  frames: number;
  channels: string[];
  bpm: number;
}

/** A pending rack recording; the frame loop appends one row per frame. */
interface Recording {
  name: string;
  channels: string[];
  rows: number[][];
  remaining: number;
  resolve: (r: RecordResult) => void;
  reject: (e: Error) => void;
}

export interface FixtureServiceDeps {
  session: SessionStore;
  renderer: WebGPURenderer;
  /** Live input rack — read for the channel list and per-frame recording rows. */
  inputs: { values(): Record<string, number> };
  palettes: PaletteRegistry;
  /** Live tempo bus — the recorded trace is stamped with its BPM. */
  timeBus: TimeBus;
  /** Read a render target back to a data URL (shared with the live screenshot path). */
  readTargetToDataUrl: (
    renderer: WebGPURenderer,
    rt: RenderTarget,
    w: number,
    h: number,
    opts?: { mime?: string; quality?: number; outW?: number; outH?: number },
  ) => Promise<string>;
}

/**
 * Fixtures: deterministic input traces (architecture refactor Phase 3).
 *
 * Owns recording the live rack (`record` + the per-frame `recordFrame` hook the
 * loop drives) and the deterministic offline pass (`shots`): rebuild the entry's
 * scene against its trace on a virtual clock (frame 0, dt 1/60, own TimeBus at
 * the trace's BPM, silent audio), mirror its tuned values + chains + modulators,
 * step to each requested frame and read the pixels back. Same fixture + frames →
 * identical bytes, independent of wall time and the live loop.
 */
export class FixtureService {
  private recording: Recording | null = null;

  constructor(private readonly d: FixtureServiceDeps) {}

  /** Capture the live rack for N frames; resolves when the trace is written. */
  record(name: string, frames: number): Promise<RecordResult> {
    if (this.recording != null) throw new Error("a fixture recording is already in flight");
    const channels = Object.keys(this.d.inputs.values());
    if (channels.length === 0) throw new Error("the input rack has no channels to record");
    return new Promise<RecordResult>((resolve, reject) => {
      this.recording = { name, channels, rows: [], remaining: frames, resolve, reject };
    });
  }

  /** Load + validate a saved trace. */
  async load(name: string): Promise<FixtureData> {
    const res = await fetch(`/loom/state/${StateDir.fixtures}/${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error(`unknown fixture "${name}" — record one with record_fixture`);
    const parsed = FixtureDataSchema.safeParse(await res.json());
    if (!parsed.success) throw new Error(`fixture "${name}" is corrupt: ${parsed.error.message}`);
    return parsed.data;
  }

  /**
   * Frame-loop hook: append this frame's rack values to a pending recording,
   * finishing (and persisting) the trace once the requested frame count lands.
   */
  recordFrame(): void {
    const r = this.recording;
    if (r == null) return;
    const vals = this.d.inputs.values();
    r.rows.push(r.channels.map((c) => vals[c] ?? 0));
    if (--r.remaining <= 0) {
      this.recording = null;
      void this.finishRecording(r);
    }
  }

  /**
   * Deterministic offline pass: rebuild the entry's scene against its trace on
   * a virtual clock (frame 0, dt 1/60, own TimeBus at the trace's BPM, silent
   * audio), mirror its tuned values + chains + modulators, step to each
   * requested frame and read the pixels back. Same fixture + frames →
   * identical bytes, independent of wall time and the live loop.
   */
  async shots(entryId: string, frameList: number[]): Promise<FixtureShot[]> {
    const { renderer, palettes } = this.d;
    const e = this.d.session.require(entryId);
    if (e.fixture == null) throw new Error(`"${entryId}" replays no fixture`);
    const data = e.fixture.data;
    const player = new FixturePlayer(data, 0);
    const vTime = new TimeBus(data.bpm);
    const silentAudio: AudioBusLike = {
      rms: new Signal(() => 0),
      band: () => new Signal(() => 0),
      onset: () => new Events(() => []),
    };
    // Mirror the entry's current chain knobs into the chain data, then fold the
    // same chains into the throwaway build.
    e.chain.captureValues(e.instance.manifest);
    for (const h of e.nodeChains.values()) h.captureValues(e.instance.manifest);
    const throwaway = buildInstance(
      e.def,
      { audio: silentAudio, time: vTime, inputs: player, palettes },
      (ctx, tex) => e.chain.fold(ctx, tex),
      { foldNode: (ctx, node, tex) => e.nodeChains.get(node)?.fold(ctx, tex) ?? tex },
    );
    const mods = new ModulatorHost({ bpm: () => vTime.bpm, audio: silentAudio });
    try {
      // Mirror live values (incl. chain knobs) and modulator specs.
      for (const [path, v] of Object.entries(e.instance.manifest.values())) {
        try {
          throwaway.manifest.get(path)?.set(v);
        } catch {
          // value doesn't fit (shouldn't happen — same def) — keep default
        }
      }
      for (const m of e.modulators.list()) {
        if (m.error != null) continue;
        try {
          mods.attach(throwaway.manifest, m.path, m.spec);
        } catch {
          // spec no longer fits — skip for the offline pass
        }
      }
      const want = [...new Set(frameList)].sort((a, b) => a - b);
      const rts = new Map(want.map((i) => [i, new RenderTarget(PREVIEW_W, PREVIEW_H)]));
      const scratch = new RenderTarget(PREVIEW_W, PREVIEW_H);
      try {
        const DT = 1 / 60;
        const liveTarget = renderer.getRenderTarget();
        for (let i = 0; i <= want[want.length - 1]!; i++) {
          const f: FrameCtx = { frame: i, now: i * DT, dt: DT };
          vTime.tick(f);
          mods.tick(throwaway.manifest, f);
          // Bind the destination BEFORE the passes run: destination-sized
          // stateful passes (render3d, transform, layer rigs) read the current
          // target to size their buffers — leaving the live loop's last target
          // bound made that size (and the pixels) nondeterministic.
          const dest = rts.get(i) ?? scratch;
          renderer.setRenderTarget(dest);
          throwaway.renderFrame(renderer, f, dest);
          if (throwaway.error != null) {
            throw new Error(`offline render froze at frame ${i}: ${String(throwaway.error)}`);
          }
        }
        renderer.setRenderTarget(liveTarget);
        const shots: FixtureShot[] = [];
        for (const i of want) {
          const url = await this.d.readTargetToDataUrl(renderer, rts.get(i)!, PREVIEW_W, PREVIEW_H, {
            mime: "image/png",
          });
          shots.push({
            frame: i,
            mime: "image/png" as const,
            base64: url.slice(url.indexOf(",") + 1),
            width: PREVIEW_W,
            height: PREVIEW_H,
          });
        }
        return shots;
      } finally {
        for (const rt of rts.values()) rt.dispose();
        scratch.dispose();
      }
    } finally {
      throwaway.dispose();
    }
  }

  private async finishRecording(r: Recording): Promise<void> {
    const data: FixtureData = { name: r.name, bpm: this.d.timeBus.bpm, channels: r.channels, frames: r.rows };
    try {
      const res = await fetch(`/loom/state/${StateDir.fixtures}/${encodeURIComponent(r.name)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error(`fixture save failed (${res.status})`);
      r.resolve({
        saved: r.name,
        path: repoStatePath(fixtureKey(r.name)),
        frames: r.rows.length,
        channels: r.channels,
        bpm: data.bpm,
      });
    } catch (err) {
      r.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }
}
