// One-off screenshotter for the `?` hotkey cheatsheet (keyboard-shortcuts PR
// evidence). Boots Vite, opens the Output + Console, presses `?`, and captures
// the overlay into preview/screenshots/. Not a validator — pure visual evidence.
// Usage: node scripts/shoot-cheatsheet.mjs
import { execSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { glArgs, forceWebGL2, resQuery } from "./_browser.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(ROOT, "preview", "screenshots");
const PORT = 5317;
const WS_PORT = 7364;
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
  await sleep(2000);

  // Press `?` (Shift+/) to open the cheatsheet, then screenshot the overlay.
  await consolePage.keyboard.press("Shift+Slash");
  await consolePage.waitForSelector("#cheatsheet", { timeout: 5_000 });
  await sleep(400);
  await consolePage.screenshot({
    path: join(OUT, "console-cheatsheet.png"),
    animations: "disabled",
    timeout: 10_000,
  });
  const rows = await consolePage.$$eval(".hk-row", (els) => els.length);
  const groups = await consolePage.$$eval(".hk-group", (els) => els.map((e) => e.dataset.group));
  console.log(`cheatsheet open: ${rows} rows across groups [${groups.join(", ")}]`);
  console.log("wrote console-cheatsheet.png to preview/screenshots/");
} finally {
  if (browser) await browser.close();
  try {
    if (process.platform === "win32" && vite.pid) execSync(`taskkill /pid ${vite.pid} /T /F`, { stdio: "ignore" });
    else vite.kill("SIGTERM");
  } catch {}
}
