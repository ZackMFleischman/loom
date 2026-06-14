// One-off Console UI screenshotter (console-ui-refactor PR evidence). Boots a
// Vite dev server, opens the Output window (the engine) and the Console on the
// same BroadcastChannel, waits for a live tile, and captures the header bar plus
// a preview-mode shot into preview/screenshots/. Not a validator — pure visual
// evidence. Usage: node scripts/shoot-console.mjs <suffix>
import { execSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { glArgs, forceWebGL2, resQuery } from "./_browser.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(ROOT, "preview", "screenshots");
const SUFFIX = process.argv[2] ?? "after";
const PORT = 5314;
const WS_PORT = 7361;
const OUTPUT_URL = `http://localhost:${PORT}/?audio=test&bpm=120&ws=${WS_PORT}&state=off${resQuery}`;
const CONSOLE_URL = `http://localhost:${PORT}/console.html?ws=${WS_PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(url, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`dev server did not come up at ${url}`);
}

mkdirSync(OUT, { recursive: true });
const vite = spawn("pnpm", ["exec", "vite", "--port", String(PORT), "--strictPort"], {
  cwd: join(ROOT, "packages", "engine-app"),
  shell: true,
  env: { ...process.env, LOOM_WS_PORT: String(WS_PORT) },
  stdio: "inherit",
});

let browser;
try {
  await waitForServer(`http://localhost:${PORT}/`);
  browser = await chromium.launch({ args: glArgs });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });

  const output = await ctx.newPage();
  await forceWebGL2(output);
  await output.goto(OUTPUT_URL);
  await sleep(2500);

  const consolePage = await ctx.newPage();
  await consolePage.goto(CONSOLE_URL);
  await consolePage.waitForSelector('.tile[data-id="boot"]', { timeout: 20_000 });
  await sleep(2500); // let thumbnails stream in

  // Header bar.
  const header = await consolePage.$("header");
  await header.screenshot({ path: join(OUT, `console-header-${SUFFIX}.png`) });

  // Stage strip.
  const strip = await consolePage.$("#stagestrip");
  await strip.screenshot({ path: join(OUT, `console-stagestrip-${SUFFIX}.png`) });

  // Full console (header + strip + grid + panel) for context.
  await consolePage.click('.tile[data-id="boot"]'); // select → param panel populates
  await sleep(600);
  await consolePage.screenshot({
    path: join(OUT, `console-full-${SUFFIX}.png`),
    animations: "disabled",
    timeout: 10_000,
  });

  // Preview mode (the headline FR-1 button in its ACTIVE/contained state).
  // Best-effort: the embedded full-res stream can be slow to warm, so don't fail
  // the whole run if it doesn't settle.
  try {
    await consolePage.click("#previewbtn", { force: true });
    await consolePage.waitForSelector("#preview-mode", { timeout: 8_000 });
    await sleep(2500);
    await consolePage.screenshot({
      path: join(OUT, `console-preview-${SUFFIX}.png`),
      animations: "disabled",
      timeout: 12_000,
    });
  } catch (e) {
    console.warn(`preview shot skipped: ${e.message?.split("\n")[0]}`);
  }

  console.log(`wrote console-{header,stagestrip,full}-${SUFFIX}.png to preview/screenshots/`);
} finally {
  if (browser) await browser.close();
  // Kill the whole vite process TREE (pnpm → vite grandchild) so nothing lingers
  // on the port between runs — `vite.kill()` alone only reaps the shell parent.
  try {
    if (process.platform === "win32" && vite.pid) execSync(`taskkill /pid ${vite.pid} /T /F`, { stdio: "ignore" });
    else vite.kill("SIGTERM");
  } catch {}
}
