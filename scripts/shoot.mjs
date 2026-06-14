// shoot.mjs — render LOOM scenes to PNG stills for PR screenshots.
//
// Usage:
//   node scripts/shoot.mjs                      # the current boot scene -> boot.png
//   node scripts/shoot.mjs pulse lava fireflies # named scenes (content/scenes/<name>.scene.ts)
//   node scripts/shoot.mjs pulse --console      # also shoot the Console cockpit -> console.png
//   node scripts/shoot.mjs --console            # only the Console (no scene shot)
//
// Env:
//   SHOOT_OUT   output dir (default: preview/screenshots)
//   SHOOT_W,SHOOT_H  viewport (default 1280x720)
//   SHOOT_SETTLE     ms to let the animation warm up before the shot (default 2500)
//   LOOM_GL     gl backend override (see scripts/_browser.mjs) — CI uses swiftshader
//
// Mechanism mirrors the validators (docs/architecture.md "Validation approach"):
// spawn the dev server on an isolated port, drive headless Chromium against the
// WebGL2 fallback, and screenshot the composited page (a WebGPU/WebGL canvas reads
// back black via drawImage without preserveDrawingBuffer). The boot scene is
// pointed at each target by rewriting live.scene.ts, exactly as M0 does — and the
// original re-export is always restored, even on failure.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { glArgs, forceWebGL2 } from "./_browser.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCENES = join(ROOT, "content", "scenes");
const LIVE = join(SCENES, "live.scene.ts");
const OUT = process.env.SHOOT_OUT ?? join(ROOT, "preview", "screenshots");
const W = Number(process.env.SHOOT_W ?? 1280);
const H = Number(process.env.SHOOT_H ?? 720);
const SETTLE = Number(process.env.SHOOT_SETTLE ?? 2500);
const PORT = 5210;
const WS_PORT = 7349; // isolated from a live session's 7341
// Lower internal render res keeps software WebGL2 (CI) fast enough that the
// compositor hands Playwright a frame before the screenshot timeout.
const RES = process.env.SHOOT_RES ?? process.env.LOOM_RES ?? "1280x720";
const URL = `http://localhost:${PORT}/?state=off&audio=test&bpm=120&res=${RES}&ws=${WS_PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rawArgs = process.argv.slice(2);
const shootConsoleUI = rawArgs.includes("--console");
const args = rawArgs.filter((a) => a !== "--console"); // scene names only

async function waitForServer(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`dev server did not come up at ${url}`);
}

// Validate scene names up front so a typo fails before we spawn anything.
for (const name of args) {
  if (!existsSync(join(SCENES, `${name}.scene.ts`))) {
    console.error(`no such scene: content/scenes/${name}.scene.ts`);
    process.exit(2);
  }
}

mkdirSync(OUT, { recursive: true });
const originalLive = readFileSync(LIVE, "utf8");

const vite = spawn("pnpm", ["exec", "vite", "--port", String(PORT), "--strictPort"], {
  cwd: join(ROOT, "packages", "engine-app"),
  shell: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, LOOM_WS_PORT: String(WS_PORT) },
});
let viteExit = null;
vite.on("exit", (code) => (viteExit = code ?? -1));
vite.stderr.on("data", (d) => process.stderr.write(`[vite] ${d}`));

let browser;
const shots = [];
try {
  await Promise.race([
    waitForServer(URL),
    (async () => {
      while (viteExit === null) await sleep(200);
      throw new Error(`vite exited early (code ${viteExit}) — port ${PORT} in use?`);
    })(),
  ]);

  browser = await chromium.launch({ headless: true, args: [...glArgs, "--autoplay-policy=no-user-gesture-required"] });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  await forceWebGL2(page);
  const consoleLines = [];
  page.on("console", (m) => consoleLines.push(m.text()));
  await page.goto(URL);
  await page.waitForFunction(
    () => /\d+ fps/.test(document.querySelector("#fps")?.textContent ?? ""),
    null,
    { timeout: 20_000 },
  );

  const waitForSwap = async (timeoutMs = 8_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (consoleLines.some((l) => l.includes("scene hot-swapped"))) return true;
      await sleep(100);
    }
    return false;
  };

  // Scene names if given; else the boot scene — UNLESS this is a console-only
  // run (then we shoot just the cockpit, no scene).
  const targets = args.length ? args : shootConsoleUI ? [] : [bootSceneName(originalLive)];
  for (const name of targets) {
    if (args.length) {
      consoleLines.length = 0;
      writeFileSync(LIVE, `export { default } from "./${name}.scene";\n`);
      await waitForSwap();
    }
    await sleep(SETTLE); // let kicks/feedback/steam accumulate to a representative frame
    const path = join(OUT, `${name}.png`);
    try {
      // Generous timeout: software GL on CI is slow to commit a frame.
      await page.screenshot({ path, timeout: 90_000 });
      shots.push(path);
      console.log(`shot ${name} -> ${path}`);
    } catch (err) {
      // One slow/broken scene shouldn't sink the rest (or the preview deploy).
      console.error(`skip ${name}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Console cockpit shot: a second page at /console.html. With no Output window
  // saying hello in this context, the Console self-boots an embedded engine
  // (hidden iframe) and renders its tiles — so the shot is self-contained.
  if (shootConsoleUI) {
    const consoleUrl = `http://localhost:${PORT}/console.html?ws=${WS_PORT}`;
    const cpage = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    try {
      await forceWebGL2(cpage);
      await cpage.goto(consoleUrl);
      // Wait for the embedded engine to boot a tile (it embeds after a short
      // grace period when no external Output window appears).
      await cpage.waitForFunction(() => document.querySelector(".tile[data-id]") != null, null, {
        timeout: 40_000,
      });
      // Select the boot tile so the param panel + FX chain are on screen.
      await cpage.evaluate(() => document.querySelector('.tile[data-id="boot"]')?.click());
      await sleep(SETTLE); // let a thumbnail render and the panel populate
      const path = join(OUT, "console.png");
      await cpage.screenshot({ path, timeout: 90_000 });
      shots.push(path);
      console.log(`shot console -> ${path}`);
    } catch (err) {
      console.error(`skip console: ${err instanceof Error ? err.message : err}`);
    } finally {
      await cpage.close();
    }
  }
} finally {
  writeFileSync(LIVE, originalLive); // never leave the boot scene repointed
  if (browser) await browser.close();
  vite.kill("SIGTERM");
}

console.log(`\n${shots.length} screenshot(s) written to ${OUT}`);
// Exit explicitly: a lingering Vite child (slow SIGTERM under software GL) keeps
// the event loop alive otherwise, hanging the CI step. The validators do the same.
process.exit(0);

/** Pull the scene basename out of `export { default } from "./<name>.scene";`. */
function bootSceneName(src) {
  return src.match(/from\s+"\.\/(.+?)\.scene"/)?.[1] ?? "boot";
}
