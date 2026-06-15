import { asSignal, BuildCtx, defineModule, type GeoNode, type SignalLike } from "@loom/runtime";
import {
  Box3,
  Color,
  Group,
  Mesh,
  MeshStandardMaterial,
  Sprite,
  SpriteMaterial,
  TextureLoader,
  Vector3,
  type Material,
  type Object3D,
  type Texture,
} from "three/webgpu";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";

export interface HippoVortexOpts {
  /** 3D model URL (.fbx/.glb/.gltf) loaded ONCE and cloned for every 3D slot. */
  url: string;
  /** Billboard sprite textures cycled across the 2D slots (the PNG variants). */
  spriteUrls: string[];
  /** Pool ceiling baked at build — the slider's max. Slots beyond `count` are hidden. */
  maxCount?: number;
  /** Live visible-hippo count (0..maxCount) — gates visibility, no rebuild. */
  count?: SignalLike;
  /** Fraction of slots that are instanced 3D models vs 2D billboards (0..1, build-time). */
  modelRatio?: number;
  /** Orbit radius at the swarm's mid-height (world units). */
  radius?: SignalLike;
  /** Vertical span the herd spirals through. */
  height?: SignalLike;
  /** Orbit angular speed (rad/s baseline; each slot scatters around it). */
  speed?: SignalLike;
  /** Vertical climb speed — hippos rise and recycle through the column. */
  rise?: SignalLike;
  /** Self Y-spin for the 3D models (rad/s). */
  spin?: SignalLike;
  /** Overall hippo size multiplier. */
  size?: SignalLike;
  /** Seed for the deterministic per-slot scatter (fixture-safe). */
  seed?: number;
}

/** Deterministic PRNG (mulberry32) — no Math.random, so fixture replays match. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Normalize loader materials to MeshStandardMaterial — exotic FBX phong
 * materials can throw in the render backend (freezing the instance, NFR-2). */
function normalizeMaterials(object: Object3D): void {
  object.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    const src = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as
      | (Material & { color?: Color; map?: Texture | null })
      | undefined;
    mesh.material = new MeshStandardMaterial({
      color: src?.color instanceof Color ? src.color.clone() : new Color("#c8c2b6"),
      map: src?.map ?? null,
      metalness: 0.05,
      roughness: 0.7,
    });
  });
}

interface Slot {
  group: Group; // positioned on the orbit each frame; gated by visibility
  model: boolean; // 3D clone vs 2D billboard sprite
  baseAngle: number;
  radFrac: number; // 0.6..1.1 radial band
  hPhase: number; // height phase 0..1
  speedMul: number; // per-slot orbit-speed scatter
  spinRate: number; // self-spin (models)
  scaleVar: number; // per-slot size scatter
}

/**
 * A swirling herd of hippos for the tornado: a mixed pool of instanced 3D model
 * clones (the FBX loaded once, then SkeletonUtils-cloned per slot) and 2D
 * billboard sprites (the PNG variants, always camera-facing). Every hippo
 * spirals around a vertical axis and climbs/recycles through a height band, so
 * the herd reads as caught in the vortex. The visible count is a live signal
 * gating slot visibility — a slider with a large baked `maxCount` costs one
 * load, not N. Seeded + frame-clocked → fixture-identical. Render via render3d.
 */
export const hippoVortex = defineModule(
  {
    name: "hippoVortex",
    kind: "geo",
    description:
      "A swirling herd of hippos (instanced 3D model clones + 2D billboard sprites) spiralling up a vortex; live count slider, render via render3d.",
    tags: ["3d", "hippo", "swarm", "billboard", "sprite", "vortex", "geo"],
    example: 'hippoVortex(ctx, { url: hippoFbx, spriteUrls, count: ctx.float("hippos", {}).signal() })',
  },
  (ctx: BuildCtx, opts: HippoVortexOpts): GeoNode => {
    const max = Math.max(1, Math.min(256, Math.round(opts.maxCount ?? 96)));
    const count = asSignal(opts.count ?? 16);
    const radius = asSignal(opts.radius ?? 1.3);
    const height = asSignal(opts.height ?? 2.4);
    const speed = asSignal(opts.speed ?? 0.5);
    const rise = asSignal(opts.rise ?? 0.12);
    const spin = asSignal(opts.spin ?? 0.6);
    const size = asSignal(opts.size ?? 0.6);
    const modelRatio = Math.max(0, Math.min(1, opts.modelRatio ?? 0.4));
    const rand = mulberry32(opts.seed ?? 0x4170a5);

    const root = new Group();
    const slots: Slot[] = [];
    for (let i = 0; i < max; i++) {
      const group = new Group();
      group.visible = false;
      root.add(group);
      slots.push({
        group,
        model: rand() < modelRatio,
        baseAngle: rand() * Math.PI * 2,
        radFrac: 0.6 + rand() * 0.5,
        hPhase: rand(),
        speedMul: 0.7 + rand() * 0.6,
        spinRate: (0.5 + rand() * 0.8) * (rand() < 0.5 ? -1 : 1),
        scaleVar: 0.65 + rand() * 0.8,
      });
    }

    // --- 2D billboard sprites: ready immediately (textures stream in async). ---
    const texLoader = new TextureLoader();
    const sprites = opts.spriteUrls.map((u) => texLoader.load(u));
    let spriteCursor = 0;
    for (const slot of slots) {
      if (slot.model) continue;
      const tex = sprites.length > 0 ? sprites[spriteCursor++ % sprites.length] ?? null : null;
      const sprite = new Sprite(
        new SpriteMaterial({ map: tex, color: new Color("#ffffff"), transparent: true, depthWrite: false }),
      );
      slot.group.add(sprite);
    }

    // --- 3D model: load ONCE, normalize + height-fit, then clone per model slot. ---
    const fit = 0.9;
    const buildTemplate = (object: Object3D): Group => {
      normalizeMaterials(object);
      const bounds = new Box3().setFromObject(object);
      const sz = bounds.getSize(new Vector3());
      const center = bounds.getCenter(new Vector3());
      const s = sz.y > 1e-6 ? fit / sz.y : 1;
      object.position.sub(center);
      const wrap = new Group();
      wrap.scale.setScalar(s);
      wrap.add(object);
      return wrap;
    };
    const populateModels = (template: Group) => {
      for (const slot of slots) {
        if (!slot.model) continue;
        slot.group.add(cloneSkeleton(template));
      }
    };
    const fail = (err: unknown) =>
      console.warn(`[loom] hippoVortex model "${opts.url}" failed to load — 3D slots stay empty`, err);
    const lower = opts.url.toLowerCase().split("?")[0] ?? "";
    try {
      if (lower.endsWith(".fbx")) {
        new FBXLoader().load(opts.url, (o) => populateModels(buildTemplate(o)), undefined, fail);
      } else {
        new GLTFLoader().load(opts.url, (g) => populateModels(buildTemplate(g.scene)), undefined, fail);
      }
    } catch (err) {
      fail(err);
    }

    ctx.updaters.push((f) => {
      const t = f.now;
      const visible = Math.max(0, Math.min(max, Math.round(count.get(f))));
      const R = Math.max(0.05, radius.get(f));
      const H = Math.max(0.2, height.get(f));
      const sp = speed.get(f);
      const ri = rise.get(f);
      const selfSpin = spin.get(f);
      const sz = Math.max(0.01, size.get(f));
      const yBottom = -H * 0.5;

      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i]!;
        const on = i < visible;
        slot.group.visible = on;
        if (!on) continue;
        let h = slot.hPhase + t * ri;
        h -= Math.floor(h); // climb + recycle
        const ang = slot.baseAngle + t * sp * slot.speedMul;
        const r = R * slot.radFrac * (0.55 + 0.45 * h); // spiral outward as they rise
        const y = yBottom + h * H + Math.sin(t * 1.3 + i) * 0.05;
        slot.group.position.set(Math.cos(ang) * r, y, Math.sin(ang) * r);
        const scale = sz * slot.scaleVar;
        slot.group.scale.setScalar(scale);
        if (slot.model) {
          // Face the direction of travel (tangent) plus a slow self-spin.
          slot.group.rotation.y = -ang + Math.PI * 0.5 + t * selfSpin * slot.spinRate;
        }
      }
    });

    return { object: root };
  },
);
