// M8 acceptance check: particles. The emitter samples a mesh's SURFACE into a
// GPU-instanced pool (CPU sim — the decided validation strategy: the base
// path runs on the WebGL2 fallback; TSL compute is the WebGPU upgrade),
// rate/turbulence ride as plain set_param (no rebuild), turbulence visibly
// whips the swarm, the flagship loop commits it through a feedback+paletteMap
// post chain via the REAL set_chain mechanism, and the seeded sim replays
// BYTE-IDENTICALLY under a fixture (screenshot {frames} twice).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { chromium } from "playwright";
import { glArgs, forceWebGL2, resQuery } from "./_browser.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ARTIFACTS = join(ROOT, "artifacts");
const SCENE = join(ROOT, "content", "scenes", "live.scene.ts");
const PARTICLE_SCENE_FILE = join(ROOT, "content", "scenes", "particleval.scene.ts");
const STATE_DIR = join(ROOT, "content", "state");
const PORT = 5212;
const WS_PORT = 7356;
const OUTPUT_URL = `http://localhost:${PORT}/?audio=test&bpm=120&ws=${WS_PORT}&state=off${resQuery}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function waitForServer(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`dev server did not come up at ${url}`);
}

function toolJson(res) {
  const text = res.content?.find((c) => c.type === "text")?.text ?? "";
  return JSON.parse(text);
}

function toolImages(res) {
  return (res.content ?? []).filter((c) => c.type === "image").map((c) => c.data);
}

async function callOk(client, name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) throw new Error(`${name} failed: ${res.content?.[0]?.text}`);
  return res;
}

async function waitFor(fn, timeoutMs = 15_000, label = "condition") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const waitForFps = (page) =>
  page.waitForFunction(
    () => /\d+ fps/.test(document.querySelector("#fps")?.textContent ?? ""),
    null,
    { timeout: 20_000 },
  );

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

const PULSE_PIN = `export { default } from "./pulse.scene";\n`;
const originalScene = readFileSync(SCENE, "utf8");
writeFileSync(SCENE, PULSE_PIN);
writeFileSync(PARTICLE_SCENE_FILE, PARTICLE_SCENE);
const stateBackup = new Map();
if (existsSync(STATE_DIR)) {
  for (const rel of readdirSync(STATE_DIR, { recursive: true })) {
    const file = join(STATE_DIR, String(rel));
    if (file.endsWith(".json")) stateBackup.set(String(rel), readFileSync(file, "utf8"));
  }
}
mkdirSync(ARTIFACTS, { recursive: true });

const vite = spawn("pnpm", ["exec", "vite", "--port", String(PORT), "--strictPort"], {
  cwd: join(ROOT, "packages", "engine-app"),
  shell: true,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
vite.stdout.on("data", (d) => process.stdout.write(`[vite] ${d}`));
vite.stderr.on("data", (d) => process.stderr.write(`[vite] ${d}`));
let viteExit = null;
vite.on("exit", (code) => {
  viteExit = code ?? -1;
});

let browser;
let client;
try {
  await Promise.race([
    waitForServer(`http://localhost:${PORT}/`),
    (async () => {
      while (viteExit === null) await sleep(200);
      throw new Error(`vite exited early (code ${viteExit}) — is port ${PORT} already in use?`);
    })(),
  ]);

  client = new Client({ name: "validate-m8", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "packages/sidecar/src/index.ts"],
    cwd: ROOT,
    env: { ...process.env, LOOM_WS_PORT: String(WS_PORT) },
    stderr: "pipe",
  });
  await client.connect(transport);
  transport.stderr?.on("data", (d) => process.stderr.write(`[sidecar] ${d}`));

  browser = await chromium.launch({
    headless: true,
    args: [...glArgs, "--autoplay-policy=no-user-gesture-required"],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await forceWebGL2(context);
  const output = await context.newPage();
  await output.goto(OUTPUT_URL);
  await waitForFps(output);
  const session = async () => toolJson(await callOk(client, "get_session", {}));
  await waitFor(async () => {
    const res = await client.callTool({ name: "get_session", arguments: {} });
    return res.isError ? null : toolJson(res);
  }, 15_000, "engine to connect to sidecar");

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
  if (client) await client.close().catch(() => {});
  if (browser) await browser.close();
  if (process.platform === "win32") {
    try { execSync(`taskkill /pid ${vite.pid} /T /F`, { stdio: "ignore" }); } catch {}
  } else {
    vite.kill("SIGTERM");
  }
  writeFileSync(SCENE, originalScene);
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
