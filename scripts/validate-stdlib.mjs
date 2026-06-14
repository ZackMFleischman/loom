// Stdlib tier-3 smoke render: every module in content/modules/ is mounted in
// a generated sandbox scene (sources render directly, effects wrap an osc,
// controls drive an osc param), hot-swapped into the live engine via the
// usual live.scene.ts pin, and must produce NON-BLACK pixels with a clean
// console. Tiers 1-2 (contract/robustness) live in content/test/ via vitest;
// this is the eyes-on half the headless tests can't cover.
import { execSync, spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { PNG } from "pngjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ARTIFACTS = join(ROOT, "artifacts");
const SCENE = join(ROOT, "content", "scenes", "live.scene.ts");
const MODULES_DIR = join(ROOT, "content", "modules");
const PORT = 5204;
const WS_PORT = 7349; // isolated — never a live session's sidecar
const OUTPUT_URL = `http://localhost:${PORT}/?audio=test&bpm=120&ws=${WS_PORT}&state=off`;

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

async function waitFor(fn, timeoutMs = 10_000, label = "condition") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Mean luminance of a full page screenshot. */
async function pageLum(page, savePath) {
  const buf = await page.screenshot(savePath ? { path: savePath } : {});
  const png = PNG.sync.read(buf);
  let l = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    l += (png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3;
  }
  return l / (png.width * png.height);
}

// ---- per-module sandbox scenes ----------------------------------------------

const ASSET = `new URL("../assets/hippos/hippo1.png", import.meta.url).href`;
const CLIP = `new URL("../assets/test/clip.mp4", import.meta.url).href`;

/** Module-specific build opts (everything else builds with {}). */
const SOURCE_OPTS = {
  image: `{ url: ${ASSET} }`,
  spriteSwarm: `{ url: ${ASSET}, cols: 3, rows: 2 }`,
  pulseRings: `{ energy: ctx.input("kick") }`,
  noodles: `{ energy: ctx.input("kick") }`,
  video: `{ url: ${CLIP} }`,
  text: `{ text: "LOOM" }`,
  shape: `{ kind: "ring", radius: 0.35, thickness: 0.12, soft: 0.05 }`,
  gradient: `{ mode: "radial", scroll: 0.1 }`,
  checker: `{ count: 8, line: 0.05 }`,
};
const EFFECT_EXTRA = {
  over: `, overlay: osc(ctx, { freq: 3, offset: 0.3 })`,
  flyby: `, urls: [${ASSET}]`,
  mixer: `, b: osc(ctx, { freq: 9, offset: 0.2 }), mix: 0.5`,
};
const CONTROL_OPTS = {
  lag: `{ input: ctx.input("kick"), seconds: 0.1 }`,
  lfo: `{ shape: "sine", periodBeats: 2 }`,
  envelope: `{ input: ctx.input("kick") }`,
  remap: `{ input: ctx.input("bass"), outMin: 0, outMax: 1, curve: "smooth" }`,
  spring: `{ input: ctx.input("kick") }`,
  sampleHold: `{ input: ctx.input("bass"), trigger: ctx.input("kick") }`,
  gate: `{ input: ctx.input("bass"), threshold: 0.3 }`,
  counter: `{ trigger: ctx.input("kick"), wrap: 4 }`,
};
// Sparse/dark-by-design modules get a lower luminance bar (still non-black).
const MIN_LUM = {
  fireflies: 0.2,
  spriteSwarm: 0.2,
  image: 0.2,
  noodles: 0.2,
  flyby: 0.5,
  // Geo: one lit mesh over a transparent background — most of the frame is dark.
  box: 0.5,
  sphere: 0.5,
  torus: 0.5,
  orbitCam: 0.5,
  model: 0.5,
  render3d: 0.5,
  particleEmitter: 0.1, // sparse glowing dots over a transparent background
  plane: 0.5,
  tube: 0.5,
  displaceGeo: 0.5,
  pointCloud: 0.02, // a handful of vertex points
  shape: 0.2,
  text: 0.2,
  webcam: 0.1, // the fake-device pattern is dim
};

/** Geo modules mount through the render3d bridge under an orbiting camera. */
const GEO_WORLD = {
  box: `box(ctx, { spin: 0.6, color: "#3fb7f0" })`,
  sphere: `sphere(ctx, { color: "#f0b73f" })`,
  torus: `torus(ctx, { tumble: 0.5, color: "#b73ff0" })`,
  // orbitCam's own smoke orbits a box; model loads the committed test cube.
  orbitCam: `box(ctx, { color: "#3ff0b7" })`,
  model: `model(ctx, { url: new URL("../assets/test/cube.glb", import.meta.url).href, spin: 0.4 })`,
  particleEmitter: `particleEmitter(ctx, { surface: box(ctx, {}), rate: 500, size: 0.06, speed: 0.6, color: "#ffd24a" })`,
  plane: `plane(ctx, { segments: 24, color: "#3fb7f0" })`,
  tube: `tube(ctx, { glow: 0.8, color: "#9ae6ff" })`,
  pointCloud: `pointCloud(ctx, { source: box(ctx, {}), size: 0.04 })`,
  displaceGeo: `displaceGeo(ctx, { input: box(ctx, {}), amount: 0.3 })`,
};

function sceneSource(folder, name) {
  const scene = `smoke-${name}`;
  if (folder === "geo") {
    const needsModel = name === "model";
    const world = GEO_WORLD[name] ?? `box(ctx, {})`;
    return `import { defineScene } from "@loom/runtime";
import { box } from "../modules/geo/box";
${name !== "box" && name !== "orbitCam" && !needsModel ? `import { ${name} } from "../modules/geo/${name}";` : ""}
${needsModel ? `import { model } from "../modules/geo/model";` : ""}
import { orbitCam } from "../modules/geo/orbitCam";
import { render3d } from "../modules/sources/render3d";
export default defineScene({
  name: "${scene}",
  build(ctx) {
    return render3d(ctx, { world: ${world}, cam: orbitCam(ctx, { speed: 0.7 }) });
  },
});
`;
  }
  if (name === "render3d") {
    return `import { defineScene } from "@loom/runtime";
import { box } from "../modules/geo/box";
import { orbitCam } from "../modules/geo/orbitCam";
import { render3d } from "../modules/sources/render3d";
export default defineScene({
  name: "${scene}",
  build(ctx) {
    return render3d(ctx, { world: box(ctx, { spin: 0.6 }), cam: orbitCam(ctx, { speed: 0.7 }) });
  },
});
`;
  }
  if (folder === "control") {
    return `import { Signal, defineScene } from "@loom/runtime";
import { ${name} } from "../modules/control/${name}";
import { osc } from "../modules/sources/osc";
export default defineScene({
  name: "${scene}",
  build(ctx) {
    const sig = ${name}(ctx, ${CONTROL_OPTS[name] ?? "{}"});
    return osc(ctx, { freq: new Signal((f) => 4 + sig.get(f) * 10) });
  },
});
`;
  }
  if (folder === "sources") {
    return `import { defineScene } from "@loom/runtime";
import { ${name} } from "../modules/sources/${name}";
export default defineScene({
  name: "${scene}",
  build(ctx) {
    return ${name}(ctx, ${SOURCE_OPTS[name] ?? "{}"});
  },
});
`;
  }
  return `import { defineScene } from "@loom/runtime";
import { ${name} } from "../modules/effects/${name}";
import { osc } from "../modules/sources/osc";
export default defineScene({
  name: "${scene}",
  build(ctx) {
    return ${name}(ctx, { input: osc(ctx, { freq: 6 })${EFFECT_EXTRA[name] ?? ""} });
  },
});
`;
}

function discoverModules() {
  const out = [];
  for (const folder of ["control", "sources", "effects", "geo"]) {
    for (const file of readdirSync(join(MODULES_DIR, folder))) {
      // _-prefixed files are shared helpers, not modules.
      if (file.endsWith(".ts") && !file.startsWith("_")) {
        out.push({ folder, name: file.replace(/\.ts$/, "") });
      }
    }
  }
  return out;
}

// ---- run ---------------------------------------------------------------------

mkdirSync(ARTIFACTS, { recursive: true });
const originalScene = readFileSync(SCENE, "utf8");
const modules = discoverModules();

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
try {
  await Promise.race([
    waitForServer(`http://localhost:${PORT}/`),
    (async () => {
      while (viteExit === null) await sleep(200);
      throw new Error(`vite exited early (code ${viteExit}) — is port ${PORT} already in use?`);
    })(),
  ]);

  browser = await chromium.launch({
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-angle=d3d11",
      "--autoplay-policy=no-user-gesture-required",
      // The webcam module's smoke gets Chromium's synthetic camera.
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  });
  const context = await browser.newContext({ viewport: { width: 640, height: 360 } });
  const page = await context.newPage();

  // Console-error monitor. The sidecar is deliberately absent, so the
  // browser's own WS reconnect failures are expected noise.
  let errors = [];
  const IGNORE = /WebSocket|ERR_CONNECTION|Failed to load resource.*:7349/i;
  page.on("console", (msg) => {
    if (msg.type() === "error" && !IGNORE.test(msg.text())) errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(String(err)));

  await page.goto(OUTPUT_URL);
  await page.waitForFunction(
    () => /\d+ fps/.test(document.querySelector("#fps")?.textContent ?? ""),
    null,
    { timeout: 20_000 },
  );

  check("module discovery finds the library", modules.length >= 20, `${modules.length} modules`);

  for (const { folder, name } of modules) {
    errors = [];
    writeFileSync(SCENE, sceneSource(folder, name));
    try {
      await waitFor(
        () =>
          page.evaluate(
            (scene) =>
              window.__loom?.sceneName === scene && window.__loom?.instanceError == null,
            `smoke-${name}`,
          ),
        15_000,
        `smoke-${name} to hot-swap in`,
      );
      // Settle: async texture loads + a few real frames before sampling.
      await sleep(folder === "control" ? 600 : 1200);
      const err = await page.evaluate(() => window.__loom?.instanceError);
      const lum = await pageLum(page, join(ARTIFACTS, `stdlib-${name}.png`));
      const minLum = MIN_LUM[name] ?? 1;
      const clean = errors.length === 0;
      check(
        `${name} renders (non-black, no errors, no freeze)`,
        err == null && lum > minLum && clean,
        `lum=${lum.toFixed(2)} (min ${minLum})${err ? ` frozen: ${err}` : ""}${clean ? "" : ` console: ${errors[0]}`}`,
      );
    } catch (err) {
      check(`${name} renders (non-black, no errors, no freeze)`, false, String(err));
    }
  }
} catch (err) {
  check("validation run completed", false, String(err));
} finally {
  writeFileSync(SCENE, originalScene);
  if (browser) await browser.close();
  if (process.platform === "win32") {
    try {
      execSync(`taskkill /pid ${vite.pid} /T /F`, { stdio: "ignore" });
    } catch {}
  } else {
    vite.kill("SIGTERM");
  }
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
