// M8 acceptance check: particles. The emitter samples a mesh's SURFACE into a
// GPU-instanced pool (CPU sim — the decided validation strategy: the base
// path runs on the WebGL2 fallback; TSL compute is the WebGPU upgrade),
// rate/turbulence ride as plain set_param (no rebuild), turbulence visibly
// whips the swarm, the flagship loop commits it through a feedback+paletteMap
// post chain via the REAL set_chain mechanism, and the seeded sim replays
// BYTE-IDENTICALLY under a fixture (screenshot {frames} twice).
import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PNG } from "pngjs";
import {
  ROOT,
  ARTIFACTS,
  STATE_DIR,
  bootStack,
  makeResults,
  sleep,
  toolJson,
  callOk,
  waitFor,
  backupState,
} from "./_harness.mjs";

const PARTICLE_SCENE_FILE = join(ROOT, "content", "scenes", "particleval.scene.ts");
const PORT = 5212;
const WS_PORT = 7356;
const OUTPUT_URL = `http://localhost:${PORT}/?audio=test&bpm=120&ws=${WS_PORT}&state=off`;

const { results, check } = makeResults();

function toolImages(res) {
  return (res.content ?? []).filter((c) => c.type === "image").map((c) => c.data);
}

function decode(res) {
  return PNG.sync.read(Buffer.from(res.content.find((c) => c.type === "image").data, "base64"));
}

/** Mean luminance of a full screenshot. */
function lumOf(res) {
  const png = decode(res);
  let l = 0;
  for (let i = 0; i < png.data.length; i += 4) l += (png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3;
  return l / (png.width * png.height);
}

/** Mean absolute per-pixel difference between two screenshots. */
function pixelDiff(resA, resB) {
  const a = decode(resA);
  const b = decode(resB);
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.data.length; i += 8) {
    sum += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
    n += 3;
  }
  return sum / n;
}

// The validator scene: a torus boiling particles, static camera so all motion
// is the swarm's. Turbulence is a param (the flagship wires it to hats; the
// scene's source proves that wiring, this scene isolates the physics).
const PARTICLE_SCENE = `import { defineScene } from "@loom/runtime";
import { particleEmitter } from "../modules/geo/particleEmitter";
import { torus } from "../modules/geo/torus";
import { render3d } from "../modules/sources/render3d";

export default defineScene({
  name: "particleval",
  description: "M8 validator: particles boiling off a torus, static camera.",
  build(ctx) {
    const rate = ctx.float("rate", { default: 400, min: 0, max: 2000 });
    const chaos = ctx.float("chaos", { default: 0, min: 0, max: 8 });
    const surface = torus(ctx, { radius: 0.7, tube: 0.2, color: "#202833" });
    const swarm = particleEmitter(ctx, {
      surface,
      rate: rate.signal(),
      turbulence: chaos.signal(),
      speed: 0.25,
      lifetime: 1.6,
      size: 0.04,
      color: "#ffd24a",
    });
    return render3d(ctx, { world: [surface, swarm], background: "#05060c" });
  },
});
`;

// particleval is its OWN scene file (pre-boot so the barrel globs it); the boot
// instance stays pulse (bootStack default pin) and create_instance builds it.
writeFileSync(PARTICLE_SCENE_FILE, PARTICLE_SCENE);
const stateBackup = backupState(); // fixtures get written during the run

const T_START = Date.now();
let tChecks = T_START;
let teardown = async () => {};
try {
  const boot = await bootStack({
    name: "validate-m8",
    port: PORT,
    wsPort: WS_PORT,
    url: OUTPUT_URL,
  });
  teardown = boot.teardown;
  const { client, output } = boot;
  tChecks = Date.now();
  const session = async () => toolJson(await callOk(client, "get_session", {}));

  // 1. Particles emit from the mesh surface — the pool lights the frame up.
  const sb = toolJson(await callOk(client, "create_instance", { scene: "particleval" })).instance;
  const shot = async () => callOk(client, "screenshot", { instance: sb });
  const lit = await waitFor(async () => {
    try {
      const res = await shot();
      const l = lumOf(res);
      return l > 2.5 ? { l, res } : null;
    } catch {
      return null;
    }
  }, 20_000, "the particle pool to fill and light the frame");
  check("particles emit from the mesh surface (frame lights up)", true, `lum=${lit.l.toFixed(2)}`);

  // 2. The swarm moves (static camera — all motion is particles).
  const m1 = await shot();
  await sleep(400);
  const m2 = await shot();
  const motion = pixelDiff(m1, m2);
  check("the swarm moves (static camera, frames differ)", motion > 0.3, `meanΔ=${motion.toFixed(3)}`);

  // 3. rate/turbulence are live params — no rebuild.
  const buildsOf = async () => (await session()).instances.find((x) => x.id === sb)?.builds;
  const b0 = await buildsOf();
  await callOk(client, "set_param", { instance: sb, path: "rate", value: 1200 });
  await callOk(client, "set_param", { instance: sb, path: "chaos", value: 5 });
  await sleep(400);
  check("riding rate + turbulence caused NO rebuild", (await buildsOf()) === b0);

  // 4. Turbulence whips the swarm: per-frame motion grows vs the calm baseline.
  const w1 = await shot();
  await sleep(400);
  const w2 = await shot();
  const wild = pixelDiff(w1, w2);
  check("turbulence visibly whips the swarm", wild > motion * 1.3, `calm Δ=${motion.toFixed(3)} → wild Δ=${wild.toFixed(3)}`);
  await callOk(client, "set_param", { instance: sb, path: "chaos", value: 0 });
  await callOk(client, "set_param", { instance: sb, path: "rate", value: 400 });

  // 5. The flagship loop: feedback + paletteMap through the REAL set_chain, then commit.
  await callOk(client, "set_chain", {
    instance: sb,
    steps: [
      { effect: "feedback", params: { amount: 0.86, zoom: 1.01 } },
      { effect: "paletteMap" },
    ],
  });
  const m = toolJson(await callOk(client, "get_manifest", { instance: sb }));
  check(
    "feedback+paletteMap chain folded (fx params live)",
    Object.keys(m.params).some((p) => p.startsWith("fx.feedback")) &&
      Object.keys(m.params).some((p) => p.startsWith("fx.paletteMap")),
  );
  await callOk(client, "stage", { instance: sb });
  await callOk(client, "commit", { durationFrames: 10 });
  await waitFor(async () => ((await session()).live === sb ? true : null), 10_000, "commit to land");
  const live = await session();
  check(
    "particle scene commits through the chain to LIVE, all healthy",
    live.live === sb && live.instances.every((i) => i.status === "ok"),
    live.instances.map((i) => `${i.id}:${i.status} ${i.frameMs}ms`).join(" · "),
  );
  await output.screenshot({ path: join(ARTIFACTS, "m8-1-swarm-live.png") }).catch(() => {});

  // 6. Deterministic under a fixture: the seeded sim replays byte-identically.
  await callOk(client, "record_fixture", { name: "m8trace", frames: 60 });
  const fx = toolJson(
    await callOk(client, "create_instance", { scene: "particleval", inputs: "fixture:m8trace" }),
  ).instance;
  const d1 = toolImages(await callOk(client, "screenshot", { instance: fx, frames: [20, 70] }));
  const d2 = toolImages(await callOk(client, "screenshot", { instance: fx, frames: [20, 70] }));
  writeFileSync(join(ARTIFACTS, "m8-fx-f20.png"), Buffer.from(d1[0], "base64"));
  writeFileSync(join(ARTIFACTS, "m8-fx-f70.png"), Buffer.from(d1[1], "base64"));
  writeFileSync(join(ARTIFACTS, "m8-fx2-f20.png"), Buffer.from(d2[0], "base64"));
  writeFileSync(join(ARTIFACTS, "m8-fx2-f70.png"), Buffer.from(d2[1], "base64"));
  const xdiff = (a, b) => {
    const pa = PNG.sync.read(Buffer.from(a, "base64"));
    const pb = PNG.sync.read(Buffer.from(b, "base64"));
    let s = 0, m = 0;
    for (let i = 0; i < pa.data.length; i++) {
      const d = Math.abs(pa.data[i] - pb.data[i]);
      s += d;
      if (d > m) m = d;
    }
    return { mean: s / pa.data.length, max: m };
  };
  console.log(`      cross-call diff f20: ${JSON.stringify(xdiff(d1[0], d2[0]))} f70: ${JSON.stringify(xdiff(d1[1], d2[1]))}`);
  check("seeded particle sim replays byte-identically under a fixture", d1[0] === d2[0] && d1[1] === d2[1]);
  check("the two fixture frames differ (sanity)", d1[0] !== d1[1]);

  // 7. The frame-time HUD reports the pool's cost (perf self-policing, M7→M8).
  const fmsAll = (await session()).instances.find((i) => i.id === sb)?.frameMs;
  check("frame-time HUD reports the particle instance's cost", typeof fmsAll === "number" && fmsAll > 0, `${fmsAll}ms`);
} catch (err) {
  check("validation run completed", false, String(err));
} finally {
  console.log(
    `[timing] m8 boot=${((tChecks - T_START) / 1000).toFixed(1)}s checks=${((Date.now() - tChecks) / 1000).toFixed(1)}s`,
  );
  await teardown(); // closes engine/sidecar/vite and restores the original live scene
  rmSync(PARTICLE_SCENE_FILE, { force: true });
  rmSync(join(STATE_DIR, "fixtures"), { recursive: true, force: true });
  for (const [rel, content] of stateBackup) {
    const file = join(STATE_DIR, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  try { execSync(`node "${join(ROOT, "scripts", "build-catalog.mjs")}"`, { stdio: "ignore" }); } catch {}
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
