// M7 acceptance check: the 3D path. A glTF model loads into a sandbox tile,
// orbits under orbitCam (no rebuild on a cam-speed ride), renders through the
// render3d bridge into the TexNode chain (a post chain darkens it), and
// commits through that chain — never-go-black untouched throughout (no
// freezes, no rejections). The per-instance frame-time HUD reports ms in
// get_session + the Console tile, and screenshot metadata carries fps. The
// FBX path (the hippo) is exercised when the local asset exists.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { chromium } from "playwright";
import { glArgs, forceWebGL2, resQuery } from "./_browser.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ARTIFACTS = join(ROOT, "artifacts");
const SCENE = join(ROOT, "content", "scenes", "live.scene.ts");
const GEO_SCENE_FILE = join(ROOT, "content", "scenes", "geoval.scene.ts");
const HIPPO_FBX = "C:\\Users\\zFlei\\Dropbox\\VJ\\Assets\\3DModels\\Hippo3D\\Hippopotamus 3D Model.fbx";
const PORT = 5209;
const WS_PORT = 7354;
const OUTPUT_URL = `http://localhost:${PORT}/?audio=test&bpm=120&ws=${WS_PORT}&state=off${resQuery}`;
const CONSOLE_URL = `http://localhost:${PORT}/console.html?embed=0`;

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

/** Average RGB over the center band of an MCP screenshot. */
function bandAvg(res) {
  const img = res.content?.find((c) => c.type === "image");
  if (!img?.data) throw new Error("screenshot result carried no image data");
  const png = PNG.sync.read(Buffer.from(img.data, "base64"));
  const r0 = Math.floor(png.height * 0.25), r1 = Math.floor(png.height * 0.75);
  let r = 0, g = 0, b = 0, n = 0;
  for (let row = r0; row < r1; row++) {
    for (let col = Math.floor(png.width * 0.25); col < Math.floor(png.width * 0.75); col += 2) {
      const i = (row * png.width + col) * 4;
      r += png.data[i]; g += png.data[i + 1]; b += png.data[i + 2]; n++;
    }
  }
  return { r: r / n, g: g / n, b: b / n, lum: (r + g + b) / (3 * n) };
}
const dist = (a, b) => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);

/** Mean absolute per-pixel difference — sensitive to motion that leaves the
 * AVERAGE color unchanged (a rotating, roughly symmetric mesh). */
function pixelDiff(resA, resB) {
  const decode = (res) => PNG.sync.read(Buffer.from(res.content.find((c) => c.type === "image").data, "base64"));
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

// The validator scene: the committed test cube under an orbiting camera.
const GEO_SCENE = `import { defineScene } from "@loom/runtime";
import { model } from "../modules/geo/model";
import { orbitCam } from "../modules/geo/orbitCam";
import { render3d } from "../modules/sources/render3d";

export default defineScene({
  name: "geoval",
  description: "M7 validator: the test cube orbited by the rig camera.",
  build(ctx) {
    const speed = ctx.float("camSpeed", { default: 0.8, min: -3, max: 3 });
    return render3d(ctx, {
      world: model(ctx, { url: new URL("../assets/test/cube.glb", import.meta.url).href, spin: 0.5, fit: 1.1 }),
      cam: orbitCam(ctx, { radius: 2.1, height: 0.6, speed: speed.signal() }),
      background: "#0a0c16",
    });
  },
});
`;

// Pin the boot scene to pulse; geoval is its OWN scene file (pre-boot, so the
// barrel globs it) — create_instance then builds it into a real sandbox tile.
const PULSE_PIN = `export { default } from "./pulse.scene";\n`;
const originalScene = readFileSync(SCENE, "utf8");
writeFileSync(SCENE, PULSE_PIN);
writeFileSync(GEO_SCENE_FILE, GEO_SCENE);
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

  client = new Client({ name: "validate-m7", version: "0.0.0" });
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

  // 1. The glTF model loads into a SANDBOX tile and renders (orange cube on dark blue).
  const sb = toolJson(await callOk(client, "create_instance", { scene: "geoval" })).instance;
  const shot = async () => callOk(client, "screenshot", { instance: sb });
  const loaded = await waitFor(async () => {
    // A just-created instance's preview target may not have rendered yet —
    // treat an early readback error as "not ready", not a failure.
    try {
      const a = bandAvg(await shot());
      return a.r > a.b + 12 ? a : null; // the cube's orange dominates once loaded
    } catch {
      return null;
    }
  }, 20_000, "the glTF cube to load and render");
  check("gltf model loads into a sandbox tile and renders", true, `center=(${loaded.r.toFixed(0)},${loaded.g.toFixed(0)},${loaded.b.toFixed(0)})`);
  await sleep(100);

  // 2. It orbits under orbitCam — frames differ over time, no errors.
  const o1 = bandAvg(await shot());
  await sleep(500);
  const o2 = bandAvg(await shot());
  check("the camera orbits (frames differ over time)", dist(o1, o2) > 2, `Δ=${dist(o1, o2).toFixed(2)}`);

  // 3. Cam-speed ride is a plain set_param — no rebuild.
  const buildsOf = async (id) => (await session()).instances.find((x) => x.id === id)?.builds;
  const b0 = await buildsOf(sb);
  await callOk(client, "set_param", { instance: sb, path: "camSpeed", value: -2.5 });
  await sleep(300);
  check("riding camSpeed caused NO rebuild", (await buildsOf(sb)) === b0);

  // 4. The bridge output flows through the TexNode chain: a post chain darkens it.
  await callOk(client, "set_chain", {
    instance: sb,
    steps: [{ effect: "levels", params: { gain: 0.12 } }],
  });
  const dark = await waitFor(async () => {
    const a = bandAvg(await shot());
    return a.lum < o2.lum * 0.55 ? a : null;
  }, 8_000, "the post chain to darken the 3D render");
  check("render3d output flows through a post chain (levels gain)", true, `lum ${o2.lum.toFixed(1)} → ${dark.lum.toFixed(1)}`);
  await callOk(client, "set_param", { instance: sb, path: `fx.levels-1.gain`, value: 1 });

  // 5. Commit through the chain — the 3D scene goes LIVE, nothing froze on the way.
  await callOk(client, "stage", { instance: sb });
  await callOk(client, "commit", { durationFrames: 10 });
  await waitFor(async () => ((await session()).live === sb ? true : null), 10_000, "commit to land");
  const live = await session();
  check(
    "3D instance commits through its chain to LIVE, all instances healthy",
    live.live === sb && live.instances.every((i) => i.status === "ok"),
    live.instances.map((i) => `${i.id}:${i.status}`).join(" · "),
  );
  const liveShot = bandAvg(await callOk(client, "screenshot", { instance: "live" }));
  check("live canvas shows the 3D render", liveShot.lum > 3, `lum=${liveShot.lum.toFixed(1)}`);
  await output.screenshot({ path: join(ARTIFACTS, "m7-1-geo-live.png") }).catch(() => {});

  // 6. Frame-time HUD: get_session carries per-instance ms; screenshot metadata carries fps.
  check(
    "get_session reports per-instance frameMs",
    live.instances.every((i) => typeof i.frameMs === "number") &&
      live.instances.some((i) => i.frameMs > 0),
    live.instances.map((i) => `${i.id}:${i.frameMs}ms`).join(" · "),
  );
  const meta = JSON.parse((await callOk(client, "screenshot", { instance: sb })).content.find((c) => c.type === "text").text);
  check("screenshot metadata carries fps", typeof meta.fps === "number" && meta.fps > 0, `fps=${meta.fps}`);

  // 7. Console tile shows the ms meter.
  const consolePage = await context.newPage();
  await consolePage.goto(CONSOLE_URL);
  await consolePage.waitForSelector(`.tile[data-id="${sb}"] .framems`, { timeout: 10_000 });
  const msText = await consolePage.$eval(`.tile[data-id="${sb}"] .framems`, (el) => el.textContent);
  check("Console tile shows the frame-time meter", /\d+(\.\d+)?ms/.test(msText ?? ""), `text="${msText}"`);
  await consolePage.close();

  // 8. FBX path — exercised when the local hippo exists (skipped elsewhere).
  if (existsSync(HIPPO_FBX)) {
    const hippo = toolJson(await callOk(client, "create_instance", { scene: "hippo3d" })).instance;
    const hshot = async () => callOk(client, "screenshot", { instance: hippo });
    const visible = await waitFor(async () => {
      // Early readbacks can race the instance's first render — keep polling.
      try {
        const a = bandAvg(await hshot());
        return a.lum > 4 ? a : null; // the lit hippo over a transparent bg
      } catch {
        return null;
      }
    }, 30_000, "the FBX hippo to load and render");
    check("FBX model (hippo) loads and renders", true, `lum=${visible.lum.toFixed(1)}`);
    // Crank the turn so the comparison is decisive (the avg color of a slowly
    // rotating mesh barely moves — compare per-pixel instead).
    await callOk(client, "set_param", { instance: hippo, path: "hippo.spin", value: 3 });
    const hA = await hshot();
    await sleep(700);
    const hB = await hshot();
    const turn = pixelDiff(hA, hB);
    check("the hippo turns (per-pixel frames differ)", turn > 0.5, `meanΔ=${turn.toFixed(3)}`);
    const png = (await hshot()).content.find((c) => c.type === "image");
    writeFileSync(join(ARTIFACTS, "m7-2-hippo.png"), Buffer.from(png.data, "base64"));
    await callOk(client, "destroy_instance", { instance: hippo });
  } else {
    console.log("SKIP  FBX hippo checks — local asset not present (machine-specific)");
  }
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
  rmSync(GEO_SCENE_FILE, { force: true });
  // The temp scene landed in the generated catalog while the dev server ran —
  // regenerate so the repo never carries a stale entry.
  try { execSync(`node "${join(ROOT, "scripts", "build-catalog.mjs")}"`, { stdio: "ignore" }); } catch {}
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
