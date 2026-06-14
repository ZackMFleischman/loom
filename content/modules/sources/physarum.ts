import { BuildCtx, defineModule, texNode, type FrameCtx, type Pass, type SignalLike, type TexNode } from "@loom/runtime";
import { cos, float, fract, int, ivec2, mix, mod, sin, texture, textureLoad, uniform, uv, vec2, vec4, vertexIndex } from "three/tsl";
import {
  AdditiveBlending, BufferAttribute, BufferGeometry, HalfFloatType, MeshBasicNodeMaterial, NearestFilter,
  NoBlending, type Node, OrthographicCamera, Points, PointsNodeMaterial, QuadMesh, RenderTarget, RepeatWrapping,
  type WebGPURenderer,
} from "three/webgpu";

// Stateless pass camera — the deposit material writes clip space via positionNode,
// so any camera works; OrthographicCamera carries the updateProjectionMatrix the
// WebGPU backend calls (the base Camera lacks it). Identity NDC pass-through.
const DEPOSIT_CAM = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

/** Trail field grid — fixed & modest (HalfFloat state, not output res). Toroidal.
 *  16:9 and high enough that veins read thin against a 1080p frame. (sensorDist/
 *  speed are in texels; the slight non-square bias is acceptable — on the WebGPU
 *  production backend the network reads cleanly isotropic.) */
const TRAIL_W = 768;
const TRAIL_H = 432;

export interface PhysarumOpts {
  /** Agent count (compile-time; packed into a √count² texture). 4k..1M-ish. */
  count?: number;
  /** Forward step per frame in trail-texels (1..4). Bigger = faster scouts. */
  speed?: SignalLike;
  /** How far ahead (in texels) the three sensors taste the trail (4..24). */
  sensorDist?: SignalLike;
  /** Sensor splay angle in radians — wire ctx.input("kick") for pulsing veins (0.2..1.4). */
  sensorAngle?: SignalLike;
  /** Turn rate toward the strongest sensor, radians/frame (0.1..1.2). */
  turnSpeed?: SignalLike;
  /** Trail laid per agent per frame — beat this up for brighter blooms (0..1). */
  deposit?: SignalLike;
  /** Trail survival per frame after diffusion (0.85..0.99; higher = longer veins). */
  decay?: SignalLike;
  /** Rising past 0.5 re-scatters every agent + clears the field (a trigger). */
  reseed?: SignalLike;
  /** Sim seed — deterministic so fixture replays are byte-identical. */
  seed?: number;
}

/**
 * Physarum (slime-mold) transport networks: thousands of agents crawl a
 * diffusing TRAIL FIELD, each tasting it at three sensors (left/center/right),
 * turning toward the strongest scent and depositing as it moves. The field
 * blurs + decays every frame, so the agents grow, reinforce and prune the
 * living vein / neuron / leaf-venation networks Physarum polycephalum is famous
 * for. Fully on the GPU: agents in a ping-ponged position texture, additive
 * deposit via instanced points, diffuse/decay in a second ping-pong — frame-
 * clocked + seeded, so fixture replays are byte-identical. Stateful like
 * `feedback` (NFR-5 resets it on a code change).
 *
 * Output: the raw trail intensity in every channel (.x is the field) — colorize
 * in the scene through the palette ramp. Reads non-black on its own.
 */
export const physarum = defineModule(
  {
    name: "physarum",
    kind: "source",
    description: "Slime-mold agents depositing into a diffusing trail field — grows living vein/neuron networks (GPU).",
    tags: ["physarum", "slime-mold", "agents", "simulation", "organic", "generative", "audio-reactive", "gpu"],
    example: 'physarum(ctx, { count: 160000, sensorAngle: ctx.input("kick"), deposit: 0.12 })',
  },
  (ctx: BuildCtx, opts: PhysarumOpts = {}): TexNode => {
    // Pack agents into a square texture: side = ceil(sqrt(count)).
    const want = Math.max(256, Math.min(1_048_576, Math.round(opts.count ?? 160_000)));
    const AW = Math.ceil(Math.sqrt(want));
    const agentCount = AW * AW;

    const speed = ctx.uniformOf(opts.speed ?? 1.0);
    const sensorDist = ctx.uniformOf(opts.sensorDist ?? 12);
    const sensorAngle = ctx.uniformOf(opts.sensorAngle ?? 0.4);
    const turnSpeed = ctx.uniformOf(opts.turnSpeed ?? 0.6);
    const deposit = ctx.uniformOf(opts.deposit ?? 0.12);
    const decay = ctx.uniformOf(opts.decay ?? 0.88);
    const reseedU = ctx.uniformOf(opts.reseed ?? 0);
    const phase = uniform(0); // frame counter — deterministic, never TSL time
    // Render-target Y points opposite ways on WebGL2 vs WebGPU. The agent UPDATE
    // samples the trail via uv() (texture space); the DEPOSIT writes NDC. Without
    // matching them, agents on WebGPU deposit Y-mirrored from where they sense and
    // the network degenerates to horizontal bands — set per-frame from the backend.
    const depFlipY = uniform(1);

    const rtOpts = { type: HalfFloatType, depthBuffer: false } as const;
    // Agent state rgba = (posX, posY, heading, _) in trail-grid units; trail field is toroidal.
    const agA = new RenderTarget(AW, AW, rtOpts), agB = new RenderTarget(AW, AW, rtOpts);
    const trA = new RenderTarget(TRAIL_W, TRAIL_H, rtOpts), trB = new RenderTarget(TRAIL_W, TRAIL_H, rtOpts);
    for (const rt of [agA, agB]) rt.texture.minFilter = rt.texture.magFilter = NearestFilter;
    for (const rt of [trA, trB]) rt.texture.wrapS = rt.texture.wrapT = RepeatWrapping;
    let agRead = agA, agWrite = agB;
    let trRead = trA, trWrite = trB;

    // Deterministic in-shader scatter (no Math.random / DataTexture): hash the agent texel.
    const hash = (p: Node<"vec2">): Node<"float"> => fract(sin(p.x.mul(127.1).add(p.y.mul(311.7))).mul(43758.5453));
    const seedScale = ((opts.seed ?? 1337) % 997) + 1;
    const seedMat = new MeshBasicNodeMaterial();
    seedMat.blending = NoBlending;
    {
      const id = uv().mul(AW).mul(float(seedScale));
      const px = hash(id).mul(TRAIL_W);
      const py = hash(id.add(vec2(17.3, 4.7))).mul(TRAIL_H);
      const hd = hash(id.add(vec2(91.1, 53.9))).mul(6.2831853);
      seedMat.colorNode = vec4(px, py, hd, 1);
    }
    const seedQuad = new QuadMesh(seedMat);

    // --- Agent update: sense the trail at L/C/R, steer, advance, wrap. ---
    const trailSampler = texture(trA.texture);
    const agentSampler = texture(agA.texture);
    // Taste the trail one sensor-distance ahead along `ang` (toroidal wrap).
    const senseAt = (x: Node<"float">, y: Node<"float">, ang: Node<"float">): Node<"float"> => {
      const sx = x.add(cos(ang).mul(sensorDist));
      const sy = y.add(sin(ang).mul(sensorDist));
      const u = mod(sx, float(TRAIL_W)).div(TRAIL_W);
      const v = mod(sy, float(TRAIL_H)).div(TRAIL_H);
      return trailSampler.sample(vec2(u, v)).x;
    };
    const updateMat = new MeshBasicNodeMaterial();
    updateMat.blending = NoBlending;
    {
      const a = agentSampler.sample(uv());
      const x = a.x, y = a.y, h = a.z;
      const fwd = senseAt(x, y, h);
      const left = senseAt(x, y, h.add(sensorAngle));
      const right = senseAt(x, y, h.sub(sensorAngle));
      // Steer: toward whichever sensor tastes the strongest trail. A tiny hash
      // jitter (frame-keyed) breaks symmetry so colonies don't freeze in lockstep.
      const jit = hash(uv().mul(AW).add(phase)).sub(0.5).mul(turnSpeed).mul(0.6);
      const turnL = left.greaterThan(fwd).and(left.greaterThan(right));
      const turnR = right.greaterThan(fwd).and(right.greaterThan(left));
      const nh = h
        .add(turnL.select(turnSpeed, float(0)))
        .sub(turnR.select(turnSpeed, float(0)))
        .add(jit);
      const nx = mod(x.add(cos(nh).mul(speed)), float(TRAIL_W));
      const ny = mod(y.add(sin(nh).mul(speed)), float(TRAIL_H));
      updateMat.colorNode = vec4(nx, ny, nh, 1);
    }
    const updateQuad = new QuadMesh(updateMat);

    // --- Diffuse (gentle 3x3) + decay the trail. ---
    const diffSampler = texture(trA.texture);
    const diffMat = new MeshBasicNodeMaterial();
    diffMat.blending = NoBlending;
    {
      const t = vec2(1 / TRAIL_W, 1 / TRAIL_H);
      const center = diffSampler.sample(uv());
      let box = center;
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          if (dx !== 0 || dy !== 0) box = box.add(diffSampler.sample(uv().add(t.mul(vec2(dx, dy)))));
      // Gentle diffuse: only blend 40% toward the box average, then decay — keeps
      // veins thin (a full 1/9 box smears the whole network into fat channels).
      const diffused = mix(center, box.mul(1 / 9), float(0.4));
      diffMat.colorNode = vec4(diffused.mul(decay).xyz, 1);
    }
    const diffQuad = new QuadMesh(diffMat);

    // --- Deposit: instanced points, additive, each reading its agent position. ---
    const depGeo = new BufferGeometry();
    depGeo.setAttribute("position", new BufferAttribute(new Float32Array(agentCount * 3), 3));
    depGeo.setDrawRange(0, agentCount);
    const depAgent = texture(agA.texture);
    const depMat = new PointsNodeMaterial();
    depMat.blending = AdditiveBlending;
    depMat.depthTest = false;
    depMat.depthWrite = false;
    depMat.transparent = true;
    depMat.size = 1;
    {
      const idx = vertexIndex.toInt();
      const ax = idx.mod(int(AW));
      const ay = idx.div(int(AW));
      const a = textureLoad(depAgent, ivec2(ax, ay));
      const ndc = vec2(a.x.div(TRAIL_W), a.y.div(TRAIL_H)).mul(2).sub(1);
      depMat.positionNode = vec4(ndc.x, ndc.y.mul(depFlipY), 0, 1);
      depMat.colorNode = vec4(deposit, deposit, deposit, 1);
    }
    const depPoints = new Points(depGeo, depMat);
    depPoints.frustumCulled = false;

    const out = texture(trA.texture);

    let seeded = false, reseedWas = false;
    const pass: Pass = {
      render(renderer: WebGPURenderer, f: FrameCtx) {
        phase.value = f.frame;
        // WebGL2 RTs are bottom-up, WebGPU top-down — flip deposit Y on WebGPU
        // so it agrees with the uv()-space sensing (else: horizontal-band collapse).
        depFlipY.value = (renderer.backend as { isWebGLBackend?: boolean }).isWebGLBackend ? 1 : -1;
        const prev = renderer.getRenderTarget();

        const reseedHigh = (reseedU.value as number) > 0.5;
        if (!seeded || (reseedHigh && !reseedWas)) {
          renderer.setRenderTarget(agRead); seedQuad.render(renderer);
          renderer.setClearColor(0x000000, 0);
          renderer.setRenderTarget(trRead); renderer.clear();
          renderer.setRenderTarget(trWrite); renderer.clear();
          seeded = true;
        }
        reseedWas = reseedHigh;

        // 1. Each agent senses the trail (trRead) at L/C/R, steers + steps → agWrite.
        trailSampler.value = trRead.texture;
        agentSampler.value = agRead.texture;
        renderer.setRenderTarget(agWrite); updateQuad.render(renderer);
        [agRead, agWrite] = [agWrite, agRead];

        // 2. Diffuse + decay the field trRead → trWrite.
        diffSampler.value = trRead.texture;
        renderer.setRenderTarget(trWrite); diffQuad.render(renderer);

        // 3. Additively deposit moved agents ON TOP (autoClear off, else render() wipes the diffuse).
        depAgent.value = agRead.texture;
        const prevAutoClear = renderer.autoClear;
        renderer.autoClear = false;
        renderer.render(depPoints, DEPOSIT_CAM);
        renderer.autoClear = prevAutoClear;
        [trRead, trWrite] = [trWrite, trRead];

        renderer.setRenderTarget(prev);
        out.value = trRead.texture;
      },
      dispose() {
        for (const rt of [agA, agB, trA, trB]) rt.dispose();
        for (const m of [seedMat, updateMat, diffMat, depMat]) m.dispose();
        depGeo.dispose();
      },
    };

    return texNode(vec4(out.x, out.x, out.x, 1), [pass]);
  },
);
