import type { BuildCtx, ColorNode, FrameCtx, Pass, SignalLike, TexNode } from "@loom/runtime";
import { dot, float, floor, fract, mix, screenSize, sin, texture, uniform, uv, vec2 } from "three/tsl";
import {
  ClampToEdgeWrapping,
  HalfFloatType,
  MeshBasicNodeMaterial,
  NoBlending,
  QuadMesh,
  RenderTarget,
  RepeatWrapping,
  Vector2,
  type Node,
  type WebGPURenderer,
} from "three/webgpu";

/**
 * Shared module plumbing. Not a module file itself (lives outside the
 * {control,sources,effects,geo} folders, so discovery never sweeps it).
 */

/**
 * The aspect of whatever surface is being rendered — canvas, preview target,
 * or an upstream effect's buffer — resolved on the GPU per draw. Use this
 * instead of hardcoding 16/9 in TSL math: modules then track the destination
 * (1920×1080 output, 640×360 previews, anything later) automatically.
 * CPU-side layout math can't use it (it's a shader node) — those modules take
 * an explicit `aspect` opt instead.
 */
export const surfaceAspect = () => screenSize.x.div(screenSize.y);

/** Lattice hash 0..1 from a vec2 node — the seed for value noise. */
export const valueHash2 = (p: Node<"vec2">) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453));

/** Bilinear value noise in 0..1 (smoothstep-interpolated hash lattice). */
export const valueNoise2 = (p: Node<"vec2">) => {
  const i = floor(p);
  const f = fract(p);
  const u = f.mul(f).mul(f.mul(-2).add(3)); // smoothstep weights
  const a = valueHash2(i);
  const b = valueHash2(i.add(vec2(1, 0)));
  const c = valueHash2(i.add(vec2(0, 1)));
  const d = valueHash2(i.add(vec2(1, 1)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
};

/** Fractal value-noise sum in ~0..1 over `octaves` (compile-time). Shared by marble/marbleWarp. */
export const fbm2 = (p: Node<"vec2">, octaves: number) => {
  let sum: Node<"float"> = float(0);
  let amp = 0.5;
  let freq = 1;
  for (let i = 0; i < octaves; i++) {
    sum = sum.add(valueNoise2(p.mul(freq)).mul(amp));
    freq *= 2;
    amp *= 0.5;
  }
  return sum;
};

/** Parse "#rrggbb" (or "#rgb"-less strict 6-digit) to 0..1 rgb floats. */
export function parseHex(c: string, fallback = 0xffffff): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
  const n = m ? parseInt(m[1]!, 16) : fallback;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export interface BufferPassOpts {
  /** What gets written into the buffer (default: the input's color). */
  colorNode?: ColorNode;
  /** Return true to skip the buffer render entirely this frame (idle gates). */
  skip?: (f: FrameCtx) => boolean;
  /** Keep sibling render targets sized with the buffer (multi-pass effects). */
  onResize?: (w: number, h: number) => void;
  /** Extra GPU work after the buffer render, same frame (e.g. a blur H pass). */
  afterRender?: (renderer: WebGPURenderer, f: FrameCtx) => void;
  /** Extra cleanup alongside the buffer's own. */
  onDispose?: () => void;
}

/**
 * THE warping-effect skeleton: render the input TexNode into an owned
 * HalfFloat RenderTarget sized to the live destination, so the effect can
 * re-sample it at transformed UVs (`texture(rt.texture, warpedUv)`). An
 * input's color is a node graph, not a function of uv — this buffer is the
 * only honest way to move arbitrary upstream content. Raw RGBA write
 * (transparent + NoBlending) so layered content keeps its alpha.
 */
export function bufferPass(input: TexNode, opts: BufferPassOpts = {}): { rt: RenderTarget; pass: Pass } {
  const rt = new RenderTarget(1, 1, { type: HalfFloatType });
  const destSize = new Vector2();

  const srcMaterial = new MeshBasicNodeMaterial();
  srcMaterial.colorNode = opts.colorNode ?? input.color;
  srcMaterial.transparent = true;
  srcMaterial.blending = NoBlending;
  const srcQuad = new QuadMesh(srcMaterial);

  const pass: Pass = {
    render(renderer: WebGPURenderer, f: FrameCtx) {
      if (opts.skip?.(f)) return;
      const prev = renderer.getRenderTarget();
      // Track the destination's actual resolution so the buffer is 1:1.
      if (prev) destSize.set(prev.width, prev.height);
      else renderer.getDrawingBufferSize(destSize);
      if (rt.width !== destSize.x || rt.height !== destSize.y) {
        rt.setSize(destSize.x, destSize.y);
        opts.onResize?.(destSize.x, destSize.y);
      }
      renderer.setRenderTarget(rt);
      srcQuad.render(renderer);
      renderer.setRenderTarget(prev);
      opts.afterRender?.(renderer, f);
    },
    dispose() {
      rt.dispose();
      srcMaterial.dispose();
      opts.onDispose?.();
    },
  };

  return { rt, pass };
}

/** What a `simBuffer` step closure is handed to read the field and the clock. */
export interface SimStepApi {
  /** Tap the read buffer at a texel offset (dx,dy) — center is sample(0,0). Returns the stored vec4. */
  sample(dx: number, dy: number): ColorNode;
  /** Frame-clocked counter (whole frames) for deterministic motion — never TSL `time`. */
  phase: Node<"float">;
}

export interface SimBufferOpts {
  /** Fixed grid (kept small — these are HalfFloat state fields, not the output res). */
  width: number;
  height: number;
  /** Integration steps per frame (SignalLike, clamped 1..64) — evolution speed. */
  iterations?: SignalLike;
  /** Boundary: toroidal (`repeat`, default) or reflecting (`clamp`). */
  wrap?: "repeat" | "clamp";
  /** Rising past 0.5 re-seeds the whole field (a trigger). */
  reseed?: SignalLike;
  /** Initial / reseed state at each cell → vec4 (rendered as a full-screen quad). */
  seed: () => ColorNode;
  /** One integration step → the next state as vec4 (see SimStepApi). */
  step: (api: SimStepApi) => ColorNode;
}

export interface SimBufferHandle {
  /** Sample the freshly written state at a texel offset — build the output color / read neighbours from this. */
  sampleOut(dx: number, dy: number): ColorNode;
  /** The simulation pass — append to your source's `texNode(color, [handle.pass])`. */
  pass: Pass;
}

/**
 * THE state-field skeleton for cellular GPU simulations (reaction-diffusion,
 * wave equations, cellular automata, …): two ping-ponged HalfFloat targets,
 * integrated N iterations a frame, seeded on the first frame and on a `reseed`
 * rising-edge, with a frame-clocked `phase` for deterministic motion. Owns the
 * boilerplate `reactionDiffusion` first inlined; a sim module becomes just its
 * `seed` + `step` shader math plus an output color built from `sampleOut`.
 *
 * Stateful like `feedback`/`echo` — a code change (NFR-5) drops the field and
 * it re-seeds next frame. Frame-clocked + seedable, so it stays as
 * fixture-deterministic as any history-keeping effect.
 */
export function simBuffer(ctx: BuildCtx, opts: SimBufferOpts): SimBufferHandle {
  const { width, height } = opts;
  const wrap = opts.wrap === "clamp" ? ClampToEdgeWrapping : RepeatWrapping;
  const rtOpts = { type: HalfFloatType, depthBuffer: false } as const;
  const rtA = new RenderTarget(width, height, rtOpts);
  const rtB = new RenderTarget(width, height, rtOpts);
  for (const rt of [rtA, rtB]) {
    rt.texture.wrapS = wrap;
    rt.texture.wrapT = wrap;
  }
  let read = rtA;
  let write = rtB;

  const iterU = ctx.uniformOf(opts.iterations ?? 1);
  const reseedU = ctx.uniformOf(opts.reseed ?? 0);
  const phase = uniform(0); // frames; set per-frame in render (deterministic, never TSL time)
  const texel = vec2(1 / width, 1 / height);

  // Step material samples the read buffer (its .value swaps each iteration).
  const src = texture(rtA.texture);
  const sample = (dx: number, dy: number) => src.sample(uv().add(texel.mul(vec2(dx, dy)))) as ColorNode;
  const stepMaterial = new MeshBasicNodeMaterial();
  stepMaterial.colorNode = opts.step({ sample, phase: phase as unknown as Node<"float"> });
  stepMaterial.transparent = true;
  stepMaterial.blending = NoBlending;
  const stepQuad = new QuadMesh(stepMaterial);

  const seedMaterial = new MeshBasicNodeMaterial();
  seedMaterial.colorNode = opts.seed();
  seedMaterial.transparent = true;
  seedMaterial.blending = NoBlending;
  const seedQuad = new QuadMesh(seedMaterial);

  // Output sampler: .value tracks the latest written target each frame.
  const outTex = texture(rtA.texture);
  const sampleOut = (dx: number, dy: number) => outTex.sample(uv().add(texel.mul(vec2(dx, dy)))) as ColorNode;

  let seeded = false;
  let reseedWas = false;
  const pass: Pass = {
    render(renderer: WebGPURenderer, f: FrameCtx) {
      phase.value = f.frame;
      const prev = renderer.getRenderTarget();

      const reseedHigh = (reseedU.value as number) > 0.5;
      if (!seeded || (reseedHigh && !reseedWas)) {
        renderer.setRenderTarget(read);
        seedQuad.render(renderer);
        seeded = true;
      }
      reseedWas = reseedHigh;

      const iters = Math.max(1, Math.min(64, Math.round(iterU.value as number)));
      for (let i = 0; i < iters; i++) {
        src.value = read.texture;
        renderer.setRenderTarget(write);
        stepQuad.render(renderer);
        [read, write] = [write, read];
      }
      renderer.setRenderTarget(prev);
      outTex.value = read.texture; // freshly written this frame
    },
    dispose() {
      rtA.dispose();
      rtB.dispose();
      stepMaterial.dispose();
      seedMaterial.dispose();
    },
  };

  return { sampleOut, pass };
}
