// M0 acceptance check, automated with Playwright.
// Asserts the plan's "shipped when": scene renders, editing the scene file
// hot-swaps it in-place, and a broken edit changes nothing on screen.
import { spawn, execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { glArgs, forceWebGL2, resQuery } from "./_browser.mjs";
import { PNG } from "pngjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCENE = join(ROOT, "content", "scenes", "live.scene.ts");
const ARTIFACTS = join(ROOT, "artifacts");
const PORT = 5199;
// state=off: persisted tunings (M5) must never skew validation assertions.
const URL = `http://localhost:${PORT}/?state=off${resQuery}`;

const GREEN_SCENE = `import { defineScene, texNode } from "@loom/runtime";
import { vec4 } from "three/tsl";

export default defineScene({
  name: "solid-green",
  build() {
    return texNode(vec4(0, 1, 0, 1));
  },
});
`;

const SYNTAX_ERROR_SCENE = `import { defineScene } from "@loom/runtime";
this is not valid typescript ((((
`;

const THROWING_SCENE = `import { defineScene } from "@loom/runtime";

export default defineScene({
  name: "kaboom",
  build() {
    throw new Error("intentional build failure for validation");
  },
});
`;
// (build() throws before returning, so no TexNode is ever produced)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
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

/**
 * Average + center RGB from a composited page screenshot (a WebGL/WebGPU
 * canvas reads back black via drawImage without preserveDrawingBuffer,
 * so we sample what's actually on screen instead).
 */
async function samplePixels(page, savePath) {
  const buf = await page.screenshot(savePath ? { path: savePath } : {});
  const png = PNG.sync.read(buf);
  const { width, height, data } = png;
  let r = 0, g = 0, b = 0;
  const n = width * height;
  for (let i = 0; i < data.length; i += 4) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
  }
  const ci = ((height >> 1) * width + (width >> 1)) * 4;
  return {
    avg: { r: r / n, g: g / n, b: b / n },
    center: { r: data[ci], g: data[ci + 1], b: data[ci + 2] },
  };
}

const originalScene = readFileSync(SCENE, "utf8");
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
try {
  await Promise.race([
    waitForServer(URL),
    (async () => {
      while (viteExit === null) await sleep(200);
      throw new Error(`vite exited early (code ${viteExit}) — is port ${PORT} already in use?`);
    })(),
  ]);

  browser = await chromium.launch({
    headless: true,
    args: [...glArgs],
  });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  await forceWebGL2(page);

  const consoleLines = [];
  page.on("console", (msg) => consoleLines.push(msg.text()));
  const waitForConsole = async (substr, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (consoleLines.some((l) => l.includes(substr))) return true;
      await sleep(100);
    }
    return false;
  };

  await page.goto(URL);
  await page.waitForFunction(
    () => /\d+ fps/.test(document.querySelector("#fps")?.textContent ?? ""),
    null,
    { timeout: 20_000 },
  );
  const hasWebGPU = await page.evaluate(() => !!navigator.gpu);
  console.log(`[info] navigator.gpu available: ${hasWebGPU} (three falls back to WebGL2 if not)`);

  // Guard against silent full-page reloads during HMR tests.
  await page.evaluate(() => { window.__loomAlive = true; });

  // 1. Initial scene renders non-black with the animation loop ticking.
  const initial = await samplePixels(page, join(ARTIFACTS, "m0-1-hello.png"));
  const lum = (initial.avg.r + initial.avg.g + initial.avg.b) / 3;
  check("initial scene renders non-black", lum > 5, `avg luminance ${lum.toFixed(1)}`);

  // 2. Editing the scene file hot-swaps it in place (<2s per the plan).
  consoleLines.length = 0;
  const editStart = Date.now();
  writeFileSync(SCENE, GREEN_SCENE);
  const swapped = await waitForConsole("scene hot-swapped");
  const swapMs = Date.now() - editStart;
  await sleep(300);
  const green = await samplePixels(page, join(ARTIFACTS, "m0-2-green-swap.png"));
  check("HMR swap fired", swapped, `${swapMs} ms after save`);
  check("HMR swap under 2s", swapped && swapMs < 2000, `${swapMs} ms`);
  check(
    "screen shows the new scene (solid green)",
    green.center.g > 200 && green.center.r < 60 && green.center.b < 60,
    `center rgb(${green.center.r},${green.center.g},${green.center.b})`,
  );

  // 3. Syntax error: nothing changes on screen, no reload, no overlay.
  consoleLines.length = 0;
  writeFileSync(SCENE, SYNTAX_ERROR_SCENE);
  await sleep(2000);
  const afterError = await samplePixels(page, join(ARTIFACTS, "m0-3-syntax-error.png"));
  const stillAlive = await page.evaluate(() => window.__loomAlive === true);
  const overlayPresent = await page.evaluate(() => !!document.querySelector("vite-error-overlay"));
  check(
    "syntax error changes nothing on screen",
    afterError.center.g > 200 && afterError.center.r < 60,
    `center rgb(${afterError.center.r},${afterError.center.g},${afterError.center.b})`,
  );
  check("no full-page reload on syntax error", stillAlive);
  check("no error overlay painted over output", !overlayPresent);

  // 4. Runtime throw in build(): scene rejected, previous keeps rendering.
  consoleLines.length = 0;
  writeFileSync(SCENE, THROWING_SCENE);
  const rejected = await waitForConsole("rejected");
  await sleep(300);
  const afterThrow = await samplePixels(page, join(ARTIFACTS, "m0-4-build-throw.png"));
  check("throwing build() is rejected (console says so)", rejected);
  check(
    "previous scene still live after throw",
    afterThrow.center.g > 200 && afterThrow.center.r < 60,
    `center rgb(${afterThrow.center.r},${afterThrow.center.g},${afterThrow.center.b})`,
  );

  // 5. Restore the original scene; it hot-swaps back in.
  consoleLines.length = 0;
  writeFileSync(SCENE, originalScene);
  const restored = await waitForConsole("scene hot-swapped");
  await sleep(300);
  const final = await samplePixels(page, join(ARTIFACTS, "m0-5-restored.png"));
  const finalLum = (final.avg.r + final.avg.g + final.avg.b) / 3;
  check("original scene restored via HMR", restored && finalLum > 5, `avg luminance ${finalLum.toFixed(1)}`);
} catch (err) {
  check("validation run completed", false, String(err));
} finally {
  writeFileSync(SCENE, originalScene);
  if (browser) await browser.close();
  if (process.platform === "win32") {
    try { execSync(`taskkill /pid ${vite.pid} /T /F`, { stdio: "ignore" }); } catch {}
  } else {
    vite.kill("SIGTERM");
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
