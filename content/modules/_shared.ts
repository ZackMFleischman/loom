import type { BuildCtx, ColorNode, FrameCtx, Pass, SignalLike, TexNode } from "@loom/runtime";
import { dot, exp, float, floor, fract, int, ivec2, mix, screenSize, sin, texture, textureLoad, uniform, uv, vec2, vec3, vec4, vertexIndex } from "three/tsl";
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  ClampToEdgeWrapping,
  HalfFloatType,
  MeshBasicNodeMaterial,
  NearestFilter,
  NoBlending,
  OrthographicCamera,
  Points,
  PointsNodeMaterial,
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

/** What a `simBufferMulti` pass closure is handed to read every named field + the clock. */
export interface MultiStepApi {
  /**
   * Tap field `name`'s READ buffer at a texel offset (dx,dy) in THAT field's
   * own grid — center is `sample(name, 0, 0)`. Returns its stored vec4. Every
   * field's latest read state is visible to every pass (coupled solve).
   */
  sample(name: string, dx: number, dy: number): ColorNode;
  /**
   * Sample field `name`'s READ buffer at an ARBITRARY uv node — for
   * semi-Lagrangian advection (a continuous backtrace lookup, where the
   * integer-offset `sample` can't reach). Bilinear if the field's texture
   * filters linearly (HalfFloat does on both backends).
   */
  sampleUv(name: string, at: Node<"vec2">): ColorNode;
  /** This pass's destination grid texel size as a vec2 node (1/w, 1/h). */
  texel: Node<"vec2">;
  /** Frame-clocked counter (whole frames) for deterministic motion — never TSL `time`. */
  phase: Node<"float">;
}

/** One named coupled field in a `simBufferMulti`. */
export interface MultiField {
  /** Field name — referenced by `sample(name, …)` and `sampleOut(name, …)`. */
  name: string;
  /** This field's grid (each field may differ; pressure scratch can be coarser). */
  width: number;
  height: number;
  /** Boundary for THIS field: toroidal (`repeat`, default) or reflecting (`clamp`). */
  wrap?: "repeat" | "clamp";
  /** Initial / reseed state at each cell → vec4. */
  seed: () => ColorNode;
}

/** One ordered integration pass: writes `target`, may read any field via `sample`. */
export interface MultiPass {
  /** Name of the field this pass writes (must be a declared field). */
  target: string;
  /** Sub-iterations of THIS pass per integration step (SignalLike, clamped 1..64) — e.g. the Jacobi pressure loop. Default 1. */
  repeat?: SignalLike;
  /** The pass shader: read fields via `api.sample`, return the target's next vec4 state. */
  step: (api: MultiStepApi) => ColorNode;
}

export interface SimBufferMultiOpts {
  /** Named coupled fields (velocity, pressure, divergence, dye, …). */
  fields: MultiField[];
  /** Ordered integration passes run each step (advect → divergence → Jacobi×N → project → advect dye). */
  passes: MultiPass[];
  /** Integration steps per frame (SignalLike, clamped 1..16) — evolution speed. Default 1. */
  iterations?: SignalLike;
  /** Rising past 0.5 re-seeds every field (a trigger). */
  reseed?: SignalLike;
}

export interface SimBufferMultiHandle {
  /** Sample field `name`'s freshly written state at a texel offset — build the output color from this. */
  sampleOut(name: string, dx: number, dy: number): ColorNode;
  /** The simulation pass — append to your source's `texNode(color, [handle.pass])`. */
  pass: Pass;
}

/**
 * The MULTI-field generalization of `simBuffer`: N named, coupled, ping-ponged
 * HalfFloat fields integrated forward by an ORDERED list of passes each frame.
 * Where `simBuffer` runs one `step` closure over a single field, this runs a
 * pipeline of passes (each writing one named field, able to read EVERY field's
 * current state) — the shape Stam stable-fluids needs (advect velocity →
 * divergence → many Jacobi pressure iterations → project → advect dye), and any
 * other coupled solve. Each field keeps its own grid + ping-pong pair; each pass
 * can sub-iterate (`repeat`, e.g. the Jacobi loop) within one integration step.
 *
 * `simBuffer` is left untouched — its single-field consumers (reactionDiffusion,
 * waveField, automata, physarum's trail uses its own inline buffers) are
 * unaffected. Same statefulness model as `simBuffer`/`feedback`: frame-clocked
 * `phase` (never TSL `time`), seeded fields, and a code change (NFR-5) drops the
 * fields and re-seeds next frame — so fixture replays stay byte-identical.
 *
 * Pass ordering note: passes run SEQUENTIALLY within a step — each pass swaps
 * its target's ping-pong pair the instant it writes, so a later pass sees the
 * results of earlier ones (advect velocity, THEN take its divergence, THEN
 * project with the solved pressure — the natural stable-fluids pipeline). A
 * pass's own `repeat` sub-loop swaps between sub-iterations too, so successive
 * Jacobi relaxations read the freshly written pressure. Reads always come from
 * the current read target, never the half-written write target.
 */
export function simBufferMulti(ctx: BuildCtx, opts: SimBufferMultiOpts): SimBufferMultiHandle {
  const rtOpts = { type: HalfFloatType, depthBuffer: false } as const;

  // Per field: its ping-pong pair, a live read-sampler (its .value tracks the
  // read target), and an output sampler (tracks the freshly written target).
  type FieldState = {
    def: MultiField;
    read: RenderTarget;
    write: RenderTarget;
    readSrc: ReturnType<typeof texture>; // sampled by passes (read buffer)
    outSrc: ReturnType<typeof texture>; // sampled by the output (latest written)
    seedQuad: QuadMesh;
    seedMat: MeshBasicNodeMaterial;
  };
  const fields = new Map<string, FieldState>();
  for (const def of opts.fields) {
    const wrap = def.wrap === "clamp" ? ClampToEdgeWrapping : RepeatWrapping;
    const a = new RenderTarget(def.width, def.height, rtOpts);
    const b = new RenderTarget(def.width, def.height, rtOpts);
    for (const rt of [a, b]) {
      rt.texture.wrapS = wrap;
      rt.texture.wrapT = wrap;
    }
    const seedMat = new MeshBasicNodeMaterial();
    seedMat.colorNode = def.seed();
    seedMat.transparent = true;
    seedMat.blending = NoBlending;
    fields.set(def.name, {
      def,
      read: a,
      write: b,
      readSrc: texture(a.texture),
      outSrc: texture(a.texture),
      seedQuad: new QuadMesh(seedMat),
      seedMat,
    });
  }

  const phase = uniform(0); // frames; set per-frame in render (deterministic, never TSL time)

  // Integer-offset neighbour tap in the SOURCE field's own texel space.
  const sampleOffset = (name: string, dx: number, dy: number): ColorNode => {
    const fs = fields.get(name);
    if (!fs) throw new Error(`simBufferMulti: unknown field "${name}"`);
    const srcTexel = vec2(1 / fs.def.width, 1 / fs.def.height);
    return fs.readSrc.sample(uv().add(srcTexel.mul(vec2(dx, dy)))) as ColorNode;
  };
  // Continuous lookup at an arbitrary uv (semi-Lagrangian advection backtrace).
  const sampleUv = (name: string, at: Node<"vec2">): ColorNode => {
    const fs = fields.get(name);
    if (!fs) throw new Error(`simBufferMulti: unknown field "${name}"`);
    return fs.readSrc.sample(at) as ColorNode;
  };

  // Compile each pass into a material + quad + its swap target name.
  type PassState = { target: FieldState; quad: QuadMesh; mat: MeshBasicNodeMaterial; repeatU: ReturnType<BuildCtx["uniformOf"]> };
  const passes: PassState[] = opts.passes.map((p) => {
    const target = fields.get(p.target);
    if (!target) throw new Error(`simBufferMulti: pass targets unknown field "${p.target}"`);
    const destTexel = vec2(1 / target.def.width, 1 / target.def.height);
    const mat = new MeshBasicNodeMaterial();
    mat.colorNode = p.step({ sample: sampleOffset, sampleUv, texel: destTexel, phase: phase as unknown as Node<"float"> });
    mat.transparent = true;
    mat.blending = NoBlending;
    return { target, quad: new QuadMesh(mat), mat, repeatU: ctx.uniformOf(p.repeat ?? 1) };
  });

  const iterU = ctx.uniformOf(opts.iterations ?? 1);
  const reseedU = ctx.uniformOf(opts.reseed ?? 0);

  const sampleOut = (name: string, dx: number, dy: number): ColorNode => {
    const fs = fields.get(name);
    if (!fs) throw new Error(`simBufferMulti: unknown field "${name}"`);
    const texelN = vec2(1 / fs.def.width, 1 / fs.def.height);
    return fs.outSrc.sample(uv().add(texelN.mul(vec2(dx, dy)))) as ColorNode;
  };

  let seeded = false;
  let reseedWas = false;
  const pass: Pass = {
    render(renderer: WebGPURenderer, f: FrameCtx) {
      phase.value = f.frame;
      const prev = renderer.getRenderTarget();

      const reseedHigh = (reseedU.value as number) > 0.5;
      if (!seeded || (reseedHigh && !reseedWas)) {
        for (const fs of fields.values()) {
          renderer.setRenderTarget(fs.read);
          fs.seedQuad.render(renderer);
        }
        seeded = true;
      }
      reseedWas = reseedHigh;

      const iters = Math.max(1, Math.min(16, Math.round(iterU.value as number)));
      for (let it = 0; it < iters; it++) {
        for (const ps of passes) {
          // Point every read sampler at its field's current read target.
          for (const fs of fields.values()) fs.readSrc.value = fs.read.texture;
          const reps = Math.max(1, Math.min(64, Math.round(ps.repeatU.value as number)));
          const tgt = ps.target;
          for (let r = 0; r < reps; r++) {
            // Re-point the target's read sampler each sub-iteration so successive
            // relaxations (Jacobi) see the freshly written values.
            tgt.readSrc.value = tgt.read.texture;
            renderer.setRenderTarget(tgt.write);
            ps.quad.render(renderer);
            [tgt.read, tgt.write] = [tgt.write, tgt.read];
          }
        }
      }
      renderer.setRenderTarget(prev);
      for (const fs of fields.values()) fs.outSrc.value = fs.read.texture; // freshly written this frame
    },
    dispose() {
      for (const fs of fields.values()) {
        fs.read.dispose();
        fs.write.dispose();
        fs.seedMat.dispose();
      }
      for (const ps of passes) ps.mat.dispose();
    },
  };

  return { sampleOut, pass };
}

// ---------------------------------------------------------------------------
// particleState — a true GPU particle pool: position/velocity live in a
// ping-ponged HalfFloat TEXTURE (one texel per particle, indexed by vertexIndex
// in the additive draw), advanced each frame by a `update` step shader and
// respawned by a `spawn` shader. The million-point "silk" payoff: splat the live
// particles into a float accumulation buffer with ADDITIVE blending, then
// tone-map → filamentary smoke-of-points.
//
// Generalizes the machinery `physarum` first owned inline (agent texture +
// instanced `Points` deposit reading it via `textureLoad`, the WebGL2/WebGPU
// render-target Y-flip gotcha) into a reusable, seeded, frame-clocked primitive.
// Stateful like `simBuffer`/`feedback`: a code change (NFR-5) drops the pool and
// it re-seeds next frame; frame-clocked `phase` + in-shader hash seeding (no
// Math.random / DataTexture) keep fixture replays byte-identical.
// ---------------------------------------------------------------------------

/** Stateless identity NDC camera for the deposit draw (positionNode writes clip
 *  space directly). OrthographicCamera carries the updateProjectionMatrix the
 *  WebGPU backend calls — the base Camera lacks it. */
const PARTICLE_CAM = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

/** What a `particleState` step/spawn closure is handed to read the pool + clock. */
export interface ParticleStepApi {
  /** This particle's CURRENT state (rgba) — read posX,posY in .xy, velocity in .zw (your convention). */
  self: ColorNode;
  /**
   * A deterministic hash in 0..1 seeded by THIS particle's index and the given
   * salt (vary the salt per channel so x/y/vx/vy scatter independently). In the
   * step closure the frame `phase` is folded in for per-frame jitter; in the
   * spawn closure it is stable per particle.
   */
  rand: (salt: number) => Node<"float">;
  /** Frame-clocked counter (whole frames) — deterministic motion, never TSL `time`. */
  phase: Node<"float">;
}

export interface ParticleStateOpts {
  /** Particle count (compile-time; packed into a ceil(√count)² texture). 256..1M-ish. */
  count: number;
  /** Per-particle initial state → vec4 (posX, posY, vx, vy by convention). Runs on seed + reseed + respawn. */
  spawn: (api: ParticleStepApi) => ColorNode;
  /** One integration step → the particle's next vec4 state. */
  update: (api: ParticleStepApi) => ColorNode;
  /**
   * Return a value > 0.5 to RESPAWN this particle this frame (dead / out-of-bounds).
   * The step shader picks `spawn` over `update` where this is high. Default: never.
   */
  respawn?: (api: ParticleStepApi) => Node<"float">;
  /** Rising past 0.5 re-seeds the WHOLE pool (a trigger). */
  reseed?: SignalLike;
  /** Seed — deterministic so fixture replays are byte-identical. */
  seed?: number;
}

export interface ParticleStateHandle {
  /** Side length of the (square) state texture; particle i lives at texel (i%side, i/side). */
  side: number;
  /** Actual packed particle count (side²). */
  count: number;
  /** Load particle `idx`'s freshly-updated state (rgba) in a deposit shader — `textureLoad`, no VTF guesswork. */
  load: (idx: Node<"int">) => ColorNode;
  /** The simulation (seed + step) pass — runs BEFORE any deposit pass that calls `load`. */
  pass: Pass;
}

/** A 0..1 hash from a vec2 node — deterministic per-particle seeding (no Math.random).
 *  The inner coord is pre-reduced with `fract` so the `sin` argument never grows
 *  past a few hundred — large args (uv*side*salt reaches 10^5+) collapse to a few
 *  values under ANGLE/WebGL2 mediump and the pool clusters onto a sparse grid. */
const hashNode = (p: Node<"vec2">): Node<"float"> => {
  const q = fract(p.mul(0.1031));
  const d = dot(q, vec2(127.1, 311.7)).add(q.x.mul(q.y).mul(1024));
  return fract(sin(d).mul(43758.5453));
};

/**
 * THE GPU particle-pool skeleton. Positions/velocities live in a ping-ponged
 * HalfFloat texture; `update` advances them, `spawn`/`respawn` recycle them.
 * Returns `load(idx)` so an additive instanced-`Points` deposit can pull each
 * particle's position by `vertexIndex` (see `additiveDeposit`).
 */
export function particleState(ctx: BuildCtx, opts: ParticleStateOpts): ParticleStateHandle {
  const want = Math.max(256, Math.min(1_048_576, Math.round(opts.count)));
  const side = Math.ceil(Math.sqrt(want));
  const count = side * side;
  const seedSalt = ((opts.seed ?? 1337) % 997) + 1;

  const rtOpts = { type: HalfFloatType, depthBuffer: false } as const;
  const a = new RenderTarget(side, side, rtOpts);
  const b = new RenderTarget(side, side, rtOpts);
  for (const rt of [a, b]) {
    rt.texture.minFilter = rt.texture.magFilter = NearestFilter; // exact per-particle texels, never blend
  }
  let read = a;
  let write = b;

  const phase = uniform(0); // frames — deterministic, never TSL time
  const reseedU = ctx.uniformOf(opts.reseed ?? 0);

  // Per-particle deterministic hash: index texel + a salt (and the fixed seed).
  const stateSrc = texture(a.texture);
  const self = stateSrc.sample(uv()) as ColorNode;
  // Per-particle id = integer texel coords (0..side, bounded) offset by the seed,
  // kept small so the hash's `sin` stays precise on WebGL2/ANGLE.
  const idVec = floor(uv().mul(side)).add(float(seedSalt));
  const mkApi = (withPhase: boolean): ParticleStepApi => ({
    self,
    phase: phase as unknown as Node<"float">,
    rand: (salt: number) =>
      hashNode(
        idVec
          .add(vec2(salt * 12.9898 + 1, salt * 78.233 + 1))
          .add(withPhase ? (phase as unknown as Node<"float">) : float(0)),
      ),
  });

  // Seed/spawn material (no frame variation in the base scatter → stable cloud).
  const seedMat = new MeshBasicNodeMaterial();
  seedMat.blending = NoBlending;
  seedMat.colorNode = opts.spawn(mkApi(false));
  const seedQuad = new QuadMesh(seedMat);

  // Step material: respawn-or-update per particle (phase folded into rand for jitter).
  const stepApi = mkApi(true);
  const stepMat = new MeshBasicNodeMaterial();
  stepMat.blending = NoBlending;
  {
    const updated = opts.update(stepApi);
    if (opts.respawn) {
      const dead = opts.respawn(stepApi).clamp(0, 1);
      const respawned = opts.spawn(stepApi);
      stepMat.colorNode = mix(updated, respawned, dead) as ColorNode;
    } else {
      stepMat.colorNode = updated;
    }
  }
  const stepQuad = new QuadMesh(stepMat);

  // Output loader for the deposit pass: textureLoad the freshly-written target.
  const loadTex = texture(a.texture);
  const load = (idx: Node<"int">): ColorNode => {
    const sideI = int(side);
    return textureLoad(loadTex, ivec2(idx.mod(sideI), idx.div(sideI))) as ColorNode;
  };

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

      stateSrc.value = read.texture;
      renderer.setRenderTarget(write);
      stepQuad.render(renderer);
      [read, write] = [write, read];

      renderer.setRenderTarget(prev);
      loadTex.value = read.texture; // freshly written this frame
    },
    dispose() {
      a.dispose();
      b.dispose();
      seedMat.dispose();
      stepMat.dispose();
    },
  };

  return { side, count, load, pass };
}

/** What `additiveDeposit`'s colorNode closure is handed per particle. */
export interface DepositApi {
  /** This particle's freshly-updated state (rgba) from `particleState.load`. */
  state: ColorNode;
  /** This particle's index as an int node. */
  index: Node<"int">;
}

export interface AdditiveDepositOpts {
  /** The pool to draw. */
  particles: ParticleStateHandle;
  /**
   * Particle position in 0..1 SCREEN space → vec2 (the pass flips Y to NDC for the
   * active backend). Typically `api.state.xy` if you stored normalized positions.
   */
  positionUv: (api: DepositApi) => Node<"vec2">;
  /**
   * Per-particle additive RGB contribution → vec3 (added into the float buffer).
   * Default: a faint white splat. Wire audio/age/velocity here for color + flash.
   */
  color?: (api: DepositApi) => Node<"vec3">;
  /** Point sprite size in pixels (1..4 — small keeps the silk filamentary). Default 1. */
  size?: number;
  /** Accumulation buffer grid (fixed HalfFloat, 16:9). Default 1280×720. */
  width?: number;
  height?: number;
  /**
   * Tone-map the accumulated density → final vec4. Default: a soft
   * `1 - exp(-d * exposure)` saturation. `exposureU` is a live uniform.
   */
  tone?: (density: ColorNode, exposureU: Node<"float">) => ColorNode;
  /** Exposure for the default tone-map (higher = brighter silk). SignalLike. Default 1.5. */
  exposure?: SignalLike;
  /** Density carried frame-to-frame (0 = pure single-frame splat; >0 = glowing trails). SignalLike 0..0.98. Default 0. */
  persistence?: SignalLike;
}

export interface AdditiveDepositHandle {
  /** The tone-mapped silk color (vec4) — wrap in `texNode(color, [...particles.pass, deposit.pass])`. */
  color: ColorNode;
  /** The deposit + tone-map pass — append AFTER the pool's own pass. */
  pass: Pass;
}

/**
 * THE additive-accumulation skeleton: splat every particle (read by
 * `vertexIndex → textureLoad`) into a HalfFloat buffer with ADDITIVE blending,
 * optionally bleed the previous frame for trails, then tone-map → the glowing
 * "silk"/smoke-of-points density. Pair with `particleState`. Handles the
 * WebGL2-vs-WebGPU render-target Y orientation so positions land where the
 * sim put them on both backends.
 */
export function additiveDeposit(ctx: BuildCtx, opts: AdditiveDepositOpts): AdditiveDepositHandle {
  const { particles } = opts;
  const W = Math.max(64, Math.round(opts.width ?? 1280));
  const H = Math.max(64, Math.round(opts.height ?? 720));
  const size = Math.max(1, Math.round(opts.size ?? 1));
  const exposureU = ctx.uniformOf(opts.exposure ?? 1.5);
  const persistU = ctx.uniformOf(opts.persistence ?? 0);
  const flipY = uniform(1); // +1 WebGL2 (bottom-up RT), -1 WebGPU (top-down)

  const rtOpts = { type: HalfFloatType, depthBuffer: false } as const;
  let accA = new RenderTarget(W, H, rtOpts);
  let accB = new RenderTarget(W, H, rtOpts);

  // Deposit geometry: one vertex per particle; positionNode reads its texel.
  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(new Float32Array(particles.count * 3), 3));
  geo.setDrawRange(0, particles.count);

  const depMat = new PointsNodeMaterial();
  depMat.blending = AdditiveBlending;
  depMat.depthTest = false;
  depMat.depthWrite = false;
  depMat.transparent = true;
  depMat.size = size;
  {
    const idx = vertexIndex.toInt();
    const state = particles.load(idx);
    const api: DepositApi = { state, index: idx };
    const p = opts.positionUv(api); // 0..1 screen space
    const ndc = p.mul(2).sub(1);
    depMat.positionNode = vec4(ndc.x, ndc.y.mul(flipY), 0, 1);
    const rgb = opts.color ? opts.color(api) : (vec3(0.04, 0.04, 0.04) as unknown as Node<"vec3">);
    depMat.colorNode = vec4(rgb, 1);
  }
  const depPoints = new Points(geo, depMat);
  depPoints.frustumCulled = false;

  // Fade-carry quad: bleed the previous accumulation forward (trails).
  const carrySrc = texture(accA.texture);
  const carryMat = new MeshBasicNodeMaterial();
  carryMat.blending = NoBlending;
  carryMat.colorNode = vec4(carrySrc.sample(uv()).rgb.mul(persistU), 1);
  const carryQuad = new QuadMesh(carryMat);

  // Tone-map the accumulated density to the visible silk.
  const accSrc = texture(accA.texture);
  const density = accSrc.sample(uv()) as ColorNode;
  const expU = exposureU as unknown as Node<"float">;
  // Soft Reinhard-ish tone-map: 1 - exp(-d * exposure), component-wise. TSL `exp`
  // is component-wise at runtime; the cast satisfies the scalar-typed overload.
  const faded = density.rgb.mul(expU).negate();
  const tone =
    opts.tone?.(density, expU) ??
    (vec4(vec3(1, 1, 1).sub(exp(faded as unknown as Node<"float">) as unknown as Node<"vec3">), 1) as ColorNode);

  const pass: Pass = {
    render(renderer: WebGPURenderer, f: FrameCtx) {
      flipY.value = (renderer.backend as { isWebGLBackend?: boolean }).isWebGLBackend ? 1 : -1;
      const prev = renderer.getRenderTarget();
      const prevAutoClear = renderer.autoClear;

      // 1. Start the frame buffer: either cleared (persistence 0) or the bled-forward
      //    previous frame (persistence > 0). Write into accB.
      renderer.autoClear = false;
      renderer.setRenderTarget(accB);
      if ((persistU.value as number) > 0.001) {
        carrySrc.value = accA.texture;
        carryQuad.render(renderer); // overwrites accB with faded previous
      } else {
        renderer.setClearColor(0x000000, 1);
        renderer.clear();
      }

      // 2. Additively splat the live particles on top.
      renderer.render(depPoints, PARTICLE_CAM);
      renderer.autoClear = prevAutoClear;

      [accA, accB] = [accB, accA];
      accSrc.value = accA.texture; // freshly accumulated this frame

      renderer.setRenderTarget(prev);
    },
    dispose() {
      accA.dispose();
      accB.dispose();
      geo.dispose();
      depMat.dispose();
      carryMat.dispose();
    },
  };

  return { color: tone, pass };
}
