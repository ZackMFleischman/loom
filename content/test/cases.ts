import type { BuildCtx, Pass, TexNode } from "@loom/runtime";
import { counter } from "../modules/control/counter";
import { envelope } from "../modules/control/envelope";
import { gate } from "../modules/control/gate";
import { lag } from "../modules/control/lag";
import { lfo } from "../modules/control/lfo";
import { noiseSignal } from "../modules/control/noiseSignal";
import { remap } from "../modules/control/remap";
import { sampleHold } from "../modules/control/sampleHold";
import { spring } from "../modules/control/spring";
import { bloom } from "../modules/effects/bloom";
import { blur } from "../modules/effects/blur";
import { crt } from "../modules/effects/crt";
import { displace } from "../modules/effects/displace";
import { echo } from "../modules/effects/echo";
import { hsv } from "../modules/effects/hsv";
import { invert } from "../modules/effects/invert";
import { key } from "../modules/effects/key";
import { mirror } from "../modules/effects/mirror";
import { neon } from "../modules/effects/neon";
import { mixer } from "../modules/effects/mixer";
import { posterize } from "../modules/effects/posterize";
import { rgbSplit } from "../modules/effects/rgbSplit";
import { threshold } from "../modules/effects/threshold";
import { tile } from "../modules/effects/tile";
import { vignette } from "../modules/effects/vignette";
import { checker } from "../modules/sources/checker";
import { gradient } from "../modules/sources/gradient";
import { plasma } from "../modules/sources/plasma";
import { shape } from "../modules/sources/shape";
import { solid } from "../modules/sources/solid";
import { text } from "../modules/sources/text";
import { voronoi } from "../modules/sources/voronoi";
import { webcam } from "../modules/sources/webcam";
import { displaceGeo } from "../modules/geo/displaceGeo";
import { plane } from "../modules/geo/plane";
import { pointCloud } from "../modules/geo/pointCloud";
import { tube } from "../modules/geo/tube";
import { colorize } from "../modules/effects/colorize";
import { feedback } from "../modules/effects/feedback";
import { flyby } from "../modules/effects/flyby";
import { glitch } from "../modules/effects/glitch";
import { kaleido } from "../modules/effects/kaleido";
import { kaleidoZoom } from "../modules/effects/kaleidoZoom";
import { levels } from "../modules/effects/levels";
import { over } from "../modules/effects/over";
import { paletteMap } from "../modules/effects/paletteMap";
import { pixelate } from "../modules/effects/pixelate";
import { transform } from "../modules/effects/transform";
import { blobs } from "../modules/sources/blobs";
import { fireflies } from "../modules/sources/fireflies";
import { image } from "../modules/sources/image";
import { julia } from "../modules/sources/julia";
import { mandelbrot } from "../modules/sources/mandelbrot";
import { noise } from "../modules/sources/noise";
import { noiseField } from "../modules/sources/noiseField";
import { noodles } from "../modules/sources/noodles";
import { osc } from "../modules/sources/osc";
import { pulseRings } from "../modules/sources/pulseRings";
import { reactionDiffusion } from "../modules/sources/reactionDiffusion";
import { ripples } from "../modules/sources/ripples";
import { softServe } from "../modules/sources/softServe";
import { sprinkles } from "../modules/sources/sprinkles";
import { spriteSwarm } from "../modules/sources/spriteSwarm";
import { starAnise } from "../modules/sources/starAnise";
import { waffleCone } from "../modules/sources/waffleCone";
import { video } from "../modules/sources/video";
import { box } from "../modules/geo/box";
import { model } from "../modules/geo/model";
import { orbitCam } from "../modules/geo/orbitCam";
import { particleEmitter } from "../modules/geo/particleEmitter";
import { sphere } from "../modules/geo/sphere";
import { torus } from "../modules/geo/torus";
import { render3d } from "../modules/sources/render3d";
import { blackInput, makeCtx, markerInput, type DiscoveredModule, type Harness } from "./harness";

/**
 * Required-opts registry: how to build each stdlib module minimally. Effects
 * receive the harness input so pass-ordering is observable. A module
 * discovered on disk but missing here fails the tier-1 completeness test —
 * that is the "new modules merge with their tests" rule, mechanized: add your
 * module's case (and any module-specific assertions) alongside the module.
 */
export type ModuleCase = (ctx: BuildCtx, input: TexNode) => unknown;

const ASSET = new URL("../assets/hippos/hippo1.png", import.meta.url).href;
const CLIP = new URL("../assets/test/clip.mp4", import.meta.url).href;
const CUBE = new URL("../assets/test/cube.glb", import.meta.url).href;

export const CASES: Record<string, ModuleCase> = {
  // control
  lag: (ctx) => lag(ctx, { input: ctx.input("kick"), seconds: 0.1 }),
  lfo: (ctx) => lfo(ctx, { shape: "sine", periodBeats: 4 }),
  envelope: (ctx) => envelope(ctx, { input: ctx.input("kick") }),
  remap: (ctx) => remap(ctx, { input: ctx.input("bass"), outMin: 1, outMax: 1.5, curve: "smooth" }),
  spring: (ctx) => spring(ctx, { input: ctx.input("kick") }),
  sampleHold: (ctx) => sampleHold(ctx, { input: lfo(ctx, { periodBeats: 3 }), trigger: ctx.input("kick") }),
  gate: (ctx) => gate(ctx, { input: ctx.input("bass"), threshold: 0.4 }),
  counter: (ctx) => counter(ctx, { trigger: ctx.input("kick"), wrap: 4 }),
  noiseSignal: (ctx) => noiseSignal(ctx, { rate: 0.3 }),
  // sources
  blobs: (ctx) => blobs(ctx, {}),
  fireflies: (ctx) => fireflies(ctx, {}),
  image: (ctx) => image(ctx, { url: ASSET }),
  julia: (ctx) => julia(ctx, {}),
  mandelbrot: (ctx) => mandelbrot(ctx, {}),
  noise: (ctx) => noise(ctx, {}),
  noiseField: (ctx) => noiseField(ctx, { type: "perlin" }),
  noodles: (ctx) => noodles(ctx, { energy: ctx.input("kick") }),
  osc: (ctx) => osc(ctx, {}),
  pulseRings: (ctx) => pulseRings(ctx, { energy: ctx.input("kick") }),
  reactionDiffusion: (ctx) => reactionDiffusion(ctx, { inject: ctx.input("kick"), reseed: ctx.input("kick") }),
  ripples: (ctx) => ripples(ctx, { energy: ctx.input("kick") }),
  softServe: (ctx) => softServe(ctx, { energy: ctx.input("bass") }),
  sprinkles: (ctx) => sprinkles(ctx, { count: 12, burst: ctx.input("kick") }),
  waffleCone: (ctx) => waffleCone(ctx, {}),
  spriteSwarm: (ctx) => spriteSwarm(ctx, { url: ASSET, cols: 3, rows: 2 }),
  starAnise: (ctx) => starAnise(ctx, { energy: ctx.input("kick") }),
  video: (ctx) => video(ctx, { url: CLIP }),
  render3d: (ctx) => render3d(ctx, { world: box(ctx, { spin: 0.5 }), cam: orbitCam(ctx, {}) }),
  solid: (ctx) => solid(ctx, { paletteStop: 2 }),
  gradient: (ctx) => gradient(ctx, { mode: "radial", scroll: 0.1 }),
  shape: (ctx) => shape(ctx, { kind: "ring", radius: ctx.input("kick") }),
  checker: (ctx) => checker(ctx, { count: 8, line: 0.05, scroll: 0.5 }),
  voronoi: (ctx) => voronoi(ctx, {}),
  plasma: (ctx) => plasma(ctx, {}),
  text: (ctx) => text(ctx, { text: "LOOM" }),
  webcam: (ctx) => webcam(ctx, {}),
  // geo
  box: (ctx) => box(ctx, { spin: 0.5 }),
  sphere: (ctx) => sphere(ctx, { glow: ctx.input("kick") }),
  torus: (ctx) => torus(ctx, { tumble: 0.4 }),
  orbitCam: (ctx) => orbitCam(ctx, { speed: 0.5 }),
  model: (ctx) => model(ctx, { url: CUBE, spin: 0.3 }),
  particleEmitter: (ctx) => particleEmitter(ctx, { surface: torus(ctx, {}), turbulence: ctx.input("hats") }),
  plane: (ctx) => plane(ctx, { segments: 16 }),
  tube: (ctx) => tube(ctx, { glow: ctx.input("kick") }),
  pointCloud: (ctx) => pointCloud(ctx, { source: plane(ctx, { segments: 12 }) }),
  displaceGeo: (ctx) => displaceGeo(ctx, { input: plane(ctx, { segments: 12 }), amount: ctx.input("bass") }),
  // effects
  colorize: (ctx, input) => colorize(ctx, { input }),
  feedback: (ctx, input) => feedback(ctx, { input }),
  flyby: (ctx, input) => flyby(ctx, { input, urls: [ASSET] }),
  glitch: (ctx, input) => glitch(ctx, { input }),
  kaleido: (ctx, input) => kaleido(ctx, { input }),
  kaleidoZoom: (ctx, input) => kaleidoZoom(ctx, { input }),
  levels: (ctx, input) => levels(ctx, { input }),
  over: (ctx, input) => over(ctx, { input, overlay: blackInput() }),
  paletteMap: (ctx, input) => paletteMap(ctx, { input }),
  pixelate: (ctx, input) => pixelate(ctx, { input }),
  transform: (ctx, input) => transform(ctx, { input }),
  blur: (ctx, input) => blur(ctx, { input }),
  threshold: (ctx, input) => threshold(ctx, { input }),
  bloom: (ctx, input) => bloom(ctx, { input }),
  mixer: (ctx, input) => mixer(ctx, { input, b: blackInput(), mix: ctx.input("bass") }),
  displace: (ctx, input) => displace(ctx, { input }),
  hsv: (ctx, input) => hsv(ctx, { input, hue: lfo(ctx, { periodBeats: 8 }) }),
  mirror: (ctx, input) => mirror(ctx, { input }),
  tile: (ctx, input) => tile(ctx, { input }),
  echo: (ctx, input) => echo(ctx, { input }),
  key: (ctx, input) => key(ctx, { input, mode: "luma" }),
  posterize: (ctx, input) => posterize(ctx, { input }),
  invert: (ctx, input) => invert(ctx, { input, amount: ctx.input("kick") }),
  rgbSplit: (ctx, input) => rgbSplit(ctx, { input }),
  vignette: (ctx, input) => vignette(ctx, { input }),
  crt: (ctx, input) => crt(ctx, { input }),
  neon: (ctx, input) => neon(ctx, { input, intensity: ctx.input("kick") }),
};

/**
 * Pack test cases merge into the same completeness sweep. A pack ships
 * packs/<name>/test/cases.ts exporting a `CASES` (or default) Record<string,
 * ModuleCase> keyed by its BARE module names — exactly the local contract. We
 * glob those, key each pack's registry by pack name, and resolve per module in
 * buildCase. (Static glob → matches any installed pack; absent until pack:add.)
 */
const packCaseModules = import.meta.glob("../../packs/*/test/cases.ts", { eager: true }) as Record<
  string,
  { CASES?: Record<string, ModuleCase>; default?: Record<string, ModuleCase> }
>;

const PACK_CASES: Record<string, Record<string, ModuleCase>> = {};
for (const [file, mod] of Object.entries(packCaseModules)) {
  const pack = /\/packs\/([^/]+)\//.exec(file)?.[1];
  if (!pack) continue;
  const cases = mod.CASES ?? mod.default;
  if (cases) PACK_CASES[pack] = cases;
}

/** Look up the build case for a discovered module (local or pack), or undefined. */
export function caseFor(d: DiscoveredModule): ModuleCase | undefined {
  return d.pack ? PACK_CASES[d.pack]?.[d.bareName] : CASES[d.bareName];
}

export interface BuiltCase {
  h: Harness;
  out: unknown;
  /** The marker pass the input carried in — effects must keep it first. */
  inputPasses: readonly Pass[];
}

/** Build a discovered module through its registry case on a fresh harness. */
export function buildCase(d: DiscoveredModule): BuiltCase {
  const make = caseFor(d);
  if (!make) {
    const where = d.pack
      ? `packs/${d.pack}/test/cases.ts (key "${d.bareName}")`
      : `content/test/cases.ts`;
    throw new Error(`no test case for module "${d.name}" — add it to ${where}`);
  }
  const h = makeCtx();
  const { input, marker } = markerInput();
  const out = make(h.ctx, input);
  h.ctx.finalize(); // what buildInstance does after build() (palette.source)
  return { h, out, inputPasses: [marker] };
}
